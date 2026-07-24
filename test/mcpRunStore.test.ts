import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RoutedCompletionAttempt } from "../mcp/llm.js";
import type { McpProviderDefiniteFailureCode } from "../mcp/failureCodes.js";
import {
  createMcpRunService,
  validateMcpRunRecoveryEnvelope,
  type McpRunJudgeRequest,
  type McpRunPlanRequest,
  type McpRunProvider,
  type McpRunRepository,
} from "../mcp/runService.js";
import { createMcpRunStore } from "../mcp/runStore.js";
import { DEFAULT_CONFIG, executionLimitsFrom, loopConfigFrom } from "../src/core/config.js";
import {
  applyRecoveryDecisionToLedger,
  fingerprintFailure,
  validateRecoveryDirective,
} from "../src/core/recovery.js";

describe("durable MCP run store", () => {
  it("restarts from append-only authority and resolves exact historical checkpoints", async () => {
    const fixture = createFixture();
    const provider = new PlanProvider();
    const first = serviceFor(fixture, provider);
    const started = await first.start(startInput("restart-request"));

    expect(started.status).toBe("active");
    expect(started.currentNode).toBe("awaiting_approval");
    expect(started.plan).toBe("Durable plan");
    expect(provider.planCalls).toBe(1);

    const restartedStore = createStore(fixture);
    const restarted = createMcpRunService({
      repository: restartedStore,
      provider,
      loop: loopConfigFrom(DEFAULT_CONFIG),
      maxProviderCalls: restartedStore.providerCallLimit,
      createRunId: (requestRef) => restartedStore.runIdForRequest(requestRef),
    });
    expect(await restarted.get({ runId: started.runId })).toEqual({ ...started, outcome: "current" });
    expect((await restartedStore.getCheckpoint({ runId: started.runId, revision: 1 }))?.revision).toBe(1);
    expect((await restartedStore.getCheckpoint({ runId: started.runId, revision: started.revision }))?.state.plan)
      .toBe("Durable plan");
    const authority = await restartedStore.get(started.runId);
    const committed = authority?.providerEvidence.find((evidence) => evidence.phase === "output_committed");
    expect(committed?.phase === "output_committed" ? committed.resultRef.sha256 : undefined).toMatch(/^[a-f0-9]{64}$/);

    const changedLimitsStore = createStore(fixture, {
      limits: { ...executionLimitsFrom(DEFAULT_CONFIG), maxSideEffectAttempts: 1 },
    });
    expect((await changedLimitsStore.get(started.runId))?.maxProviderCalls).toBe(32);
  });

  it("replays an event appended before snapshot publication without repeating provider work", async () => {
    const fixture = createFixture();
    let injected = false;
    const crashingStore = createStore(fixture, {
      failAt: (point, context) => {
        if (!injected && point === "after-event-append" && context.revision === 1) {
          injected = true;
          throw new Error("simulated snapshot crash");
        }
      },
    });
    const provider = new PlanProvider();
    const crashing = createMcpRunService({
      repository: crashingStore,
      provider,
      loop: loopConfigFrom(DEFAULT_CONFIG),
      maxProviderCalls: crashingStore.providerCallLimit,
      createRunId: (requestRef) => crashingStore.runIdForRequest(requestRef),
    });
    await expect(crashing.start(startInput("snapshot-crash"))).rejects.toThrow("simulated snapshot crash");
    expect(provider.planCalls).toBe(0);

    const restarted = serviceFor(fixture, provider);
    const replay = await restarted.start(startInput("snapshot-crash"));
    expect(replay.status).toBe("blocked");
    expect(replay.revision).toBe(1);
    expect(provider.planCalls).toBe(0);
  });

  it("never exposes returned output when final publication crashes before its event", async () => {
    const fixture = createFixture();
    let injected = false;
    const store = createStore(fixture, {
      failAt: (point, context) => {
        if (!injected && point === "after-publication-artifact" && context.revision === 4) {
          injected = true;
          throw new Error("simulated output publication crash");
        }
      },
    });
    const provider = new PlanProvider();
    const service = createMcpRunService({
      repository: store,
      provider,
      loop: loopConfigFrom(DEFAULT_CONFIG),
      maxProviderCalls: store.providerCallLimit,
      createRunId: (requestRef) => store.runIdForRequest(requestRef),
    });
    await expect(service.start(startInput("output-crash"))).rejects.toThrow("simulated output publication crash");
    expect(provider.planCalls).toBe(1);

    const restarted = serviceFor(fixture, provider);
    const replay = await restarted.start(startInput("output-crash"));
    expect(replay.status).toBe("blocked");
    expect(replay.plan).toBeUndefined();
    expect(provider.planCalls).toBe(1);
  });

  it("persists reject, retry, automatic re-plan, approval, and terminal judge transitions", async () => {
    const fixture = createFixture();
    const provider = new PlanProvider(["reject", "reject", "approve"]);
    const service = serviceFor(fixture, provider);
    const started = await service.start(startInput("flow-start"));
    const approved = await service.advance({
      requestId: "flow-approve-1",
      runId: started.runId,
      expectedRevision: started.revision,
      event: { type: "plan_approved" },
    });
    const rejected = await service.advance({
      requestId: "flow-code-1",
      runId: started.runId,
      expectedRevision: approved.revision,
      event: { type: "code_result_submitted", diff: "diff one", testOutput: "failed" },
    });
    expect(rejected).toMatchObject({ currentNode: "coding", lastVerdict: { verdict: "reject" } });

    const replanned = await service.advance({
      requestId: "flow-code-2",
      runId: started.runId,
      expectedRevision: rejected.revision,
      event: { type: "code_result_submitted", diff: "diff two", testOutput: "failed again" },
    });
    expect(replanned).toMatchObject({ currentNode: "awaiting_approval", progress: { planVersion: 2 } });
    const approvedAgain = await service.advance({
      requestId: "flow-approve-2",
      runId: started.runId,
      expectedRevision: replanned.revision,
      event: { type: "plan_approved" },
    });
    const done = await service.advance({
      requestId: "flow-code-3",
      runId: started.runId,
      expectedRevision: approvedAgain.revision,
      event: { type: "code_result_submitted", diff: "fixed diff", testOutput: "passing" },
    });
    expect(done).toMatchObject({ status: "done", currentNode: "done", lastVerdict: { verdict: "approve" } });

    const restarted = serviceFor(fixture, provider);
    expect(await restarted.get({ runId: started.runId })).toMatchObject({
      status: "done",
      revision: done.revision,
      progress: { planVersion: 2 },
    });
    expect(provider).toMatchObject({ planCalls: 2, judgeCalls: 3 });
  }, 20_000);

  it("rejects corrupt publication bytes and isolates canonical repositories", async () => {
    const fixture = createFixture();
    const store = createStore(fixture);
    const started = await serviceFor(fixture, new PlanProvider()).start(startInput("corrupt-request"));

    const otherProject = join(fixture.root, "other-project");
    mkdirSync(otherProject);
    const otherStore = createStore({ ...fixture, project: otherProject });
    expect(await otherStore.get(started.runId)).toBeUndefined();

    const mutations = join(
      fixture.userRoot,
      DEFAULT_CONFIG.mcp.runs.userStoreDir,
      "repositories",
      store.repositoryDigest,
      "runs",
      started.runId,
      "mutations",
    );
    const first = readdirSync(mutations).sort()[0];
    if (!first) throw new Error("Expected a durable publication artifact");
    writeFileSync(join(mutations, first), "{}", "utf8");
    await expect(store.get(started.runId)).rejects.toThrow(/mutation artifact|publication/i);
  });

  it("binds contention to one lease generation and rejects a user-root symlink escape", async () => {
    const fixture = createFixture();
    const store = createStore(fixture);
    const started = await serviceFor(fixture, new PlanProvider()).start(startInput("contention-request"));
    await expect(store.withRunLease(started.runId, async () =>
      store.withRunLease(started.runId, async () => undefined))).rejects.toThrow(/already executing|lease/i);

    const escaped = createFixture();
    const outside = join(escaped.root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(escaped.userRoot, DEFAULT_CONFIG.mcp.runs.userStoreDir));
    const escapedStore = createStore(escaped);
    await expect(serviceFor(escaped, new PlanProvider(), escapedStore).start(startInput("symlink-request")))
      .rejects.toThrow(/symlink/i);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("writes only a sanitized optional project mirror and ignores a poisoned mirror path", async () => {
    const fixture = createFixture();
    const mirrorStore = createStore(fixture, { projectMirror: true });
    const started = await serviceFor(fixture, new PlanProvider(), mirrorStore).start(startInput("mirror-request", "secret task"));
    const mirrorPath = join(fixture.project, ".ai-orchestrator", "mcp-runs", `${started.runId}.json`);
    const mirror = readFileSync(mirrorPath, "utf8");
    expect(mirror).not.toContain("secret task");
    expect(mirror).not.toContain("Durable plan");
    expect(JSON.parse(mirror)).toMatchObject({ runId: started.runId, revision: started.revision, status: "active" });

    const poisoned = createFixture();
    const outside = join(poisoned.root, "mirror-outside");
    mkdirSync(outside);
    symlinkSync(outside, join(poisoned.project, ".ai-orchestrator"));
    const poisonedStore = createStore(poisoned, { projectMirror: true });
    await expect(serviceFor(poisoned, new PlanProvider(), poisonedStore).start(startInput("poisoned-mirror")))
      .resolves.toMatchObject({ currentNode: "awaiting_approval" });
    expect(readdirSync(outside)).toEqual([]);
  });

  it("derives bounded retry only from a closed provider failure and preserves it across restart", async () => {
    const retryFixture = createFixture();
    const retryService = serviceFor(retryFixture, new PlanProvider([], ["http_error"]));
    const retryRun = await retryService.start(startInput("recovery-retry-start"));
    const approved = await retryService.advance({
      requestId: "recovery-retry-approve",
      runId: retryRun.runId,
      expectedRevision: retryRun.revision,
      event: { type: "plan_approved" },
    });
    const failed = await retryService.advance({
      requestId: "recovery-retry-code",
      runId: retryRun.runId,
      expectedRevision: approved.revision,
      event: { type: "code_result_submitted", diff: "provider failure", testOutput: "not reached" },
    });
    expect(failed).toMatchObject({ status: "failed", currentNode: "failed" });
    const retried = await retryService.recover({
      requestId: "recovery-retry-1",
      runId: retryRun.runId,
      expectedRevision: failed.revision,
    });
    expect(retried.recovery).toMatchObject({
      status: "released",
      action: "retry",
      reason: "transient-failure",
      remaining: { retry: 0, repair: 1, replan: 1 },
    });
    expect(await retryService.advance({
      requestId: "recovery-cannot-bypass",
      runId: retryRun.runId,
      expectedRevision: retried.revision,
      event: { type: "plan_approved" },
    })).toMatchObject({ status: "blocked", revision: retried.revision, requiredAction: "inspect_run" });
    expect(await retryService.recover({
      requestId: "recovery-retry-1",
      runId: retryRun.runId,
      expectedRevision: failed.revision,
    })).toEqual(retried);
    const stale = await retryService.recover({
      requestId: "recovery-stale",
      runId: retryRun.runId,
      expectedRevision: failed.revision,
    });
    expect(stale).toMatchObject({ outcome: "conflict", revision: retried.revision, requiredAction: "inspect_run" });
    expect(stale.recovery).toBeUndefined();
    const retryStore = createStore(retryFixture);
    const retryAuthority = await retryStore.get(retryRun.runId);
    const registrations = retryAuthority?.recovery?.ledger.records.filter((record) => record.kind === "registration") ?? [];
    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.kind === "registration" ? registrations[0].failure.failureLineageId : undefined)
      .toMatch(/^lineage-[a-f0-9]{48}$/);
    expect((await serviceFor(retryFixture, new PlanProvider(), retryStore).get({ runId: retryRun.runId })).recovery)
      .toEqual(retried.recovery);

    await expect(retryService.recover({
      requestId: "recovery-retry-2",
      runId: retryRun.runId,
      expectedRevision: retried.revision,
    })).rejects.toThrow(/already registered/i);

    const cancelled = await retryService.cancel({
      requestId: "recovery-retry-cancel",
      runId: retryRun.runId,
      expectedRevision: retried.revision,
      reason: "operator stopped recovery",
    });
    expect(cancelled).toMatchObject({ status: "cancelled", outcome: "cancelled", currentNode: "failed" });
  }, 30_000);

  it("rejects manufactured observations and derives checker rejection without client-authored diagnosis", async () => {
    const fixture = createFixture();
    const service = serviceFor(fixture, new PlanProvider(["reject"]));
    const started = await service.start(startInput("recovery-reject-start"));
    await expect(service.recover({
      requestId: "recovery-manufactured",
      runId: started.runId,
      expectedRevision: started.revision,
    })).rejects.toThrow(/server-authenticated closed/i);

    const approved = await service.advance({
      requestId: "recovery-reject-approve",
      runId: started.runId,
      expectedRevision: started.revision,
      event: { type: "plan_approved" },
    });
    const rejected = await service.advance({
      requestId: "recovery-reject-code",
      runId: started.runId,
      expectedRevision: approved.revision,
      event: { type: "code_result_submitted", diff: "bad diff", testOutput: "failed" },
    });
    const classified = await service.recover({
      requestId: "recovery-reject-classify",
      runId: started.runId,
      expectedRevision: rejected.revision,
    });
    expect(classified.recovery).toMatchObject({
      status: "waiting-diagnosis",
      action: "pause",
      reason: "diagnosis-required",
      remaining: { retry: 1, repair: 1, replan: 1 },
    });
    await expect(service.recover({
      requestId: "recovery-client-diagnosis",
      runId: started.runId,
      expectedRevision: classified.revision,
      category: "implementation-defect",
      diagnosis: {
        rootCauseCategory: "implementation-defect",
        confidence: "high",
        content: "self-authored",
        repairScope: ["src"],
        validationRequirements: ["tests"],
        topologyAssessment: "preserve",
      },
    } as never)).rejects.toThrow();
  }, 30_000);

  it("rejects a correct recovery registration bundled with a forged diagnosis decision", async () => {
    const fixture = createFixture();
    const store = createStore(fixture);
    let injected = false;
    const repository: McpRunRepository = {
      withStartLease: store.withStartLease.bind(store),
      withRunLease: (runId, work) => store.withRunLease(runId, async (transaction) => work({
        get: transaction.get.bind(transaction),
        getRequest: transaction.getRequest.bind(transaction),
        writeProviderOutput: transaction.writeProviderOutput.bind(transaction),
        getRecoveryContext: transaction.getRecoveryContext?.bind(transaction),
        writeRecoveryArtifact: transaction.writeRecoveryArtifact?.bind(transaction),
        compareAndSwap: async (expectedRevision, draft, update, beforePublication) => {
          if (!injected && update.mutationEffect.operation === "recover" && draft.recovery !== undefined) {
            injected = true;
            const envelope = validateMcpRunRecoveryEnvelope(draft.recovery);
            const registration = envelope.ledger.records.find((record) => record.kind === "registration");
            if (!registration || registration.kind !== "registration" || !transaction.writeRecoveryArtifact) {
              throw new Error("Expected an initial recovery registration and artifact writer");
            }
            const fingerprint = fingerprintFailure(registration.failure);
            const content = "Client-authored diagnosis must not become durable authority.";
            const diagnosisRef = `plan-versions/${registration.failure.planVersion}/diagnoses/${fingerprint}.md`;
            const directive = validateRecoveryDirective({
              version: 1,
              failureFingerprint: fingerprint,
              rootCauseCategory: "implementation-defect",
              confidence: "high",
              diagnosisRef,
              diagnosisHash: createHash("sha256").update(content).digest("hex"),
              evidenceRefs: [],
              repairScope: ["src"],
              validationRequirements: ["tests"],
              topologyAssessment: "preserve",
            });
            const diagnosis = await transaction.writeRecoveryArtifact({
              runId,
              semanticRef: diagnosisRef,
              bytes: Buffer.from(content, "utf8"),
            });
            const forged = validateMcpRunRecoveryEnvelope({
              ...envelope,
              ledger: applyRecoveryDecisionToLedger(
                envelope.ledger,
                envelope.binding.authority,
                fingerprint,
                directive,
              ),
              artifacts: [...envelope.artifacts, diagnosis],
            });
            return transaction.compareAndSwap(
              expectedRevision,
              { ...draft, recovery: forged },
              update,
              () => undefined,
            );
          }
          return transaction.compareAndSwap(expectedRevision, draft, update, beforePublication);
        },
      })),
      get: store.get.bind(store),
      getCheckpoint: store.getCheckpoint.bind(store),
    };
    const service = createMcpRunService({
      repository,
      provider: new PlanProvider(["reject"]),
      loop: loopConfigFrom(DEFAULT_CONFIG),
      maxProviderCalls: store.providerCallLimit,
      createRunId: (requestRef) => store.runIdForRequest(requestRef),
    });
    const started = await service.start(startInput("recovery-forged-diagnosis-start"));
    const approved = await service.advance({
      requestId: "recovery-forged-diagnosis-approve",
      runId: started.runId,
      expectedRevision: started.revision,
      event: { type: "plan_approved" },
    });
    const rejected = await service.advance({
      requestId: "recovery-forged-diagnosis-code",
      runId: started.runId,
      expectedRevision: approved.revision,
      event: { type: "code_result_submitted", diff: "bad diff", testOutput: "failed" },
    });

    await expect(service.recover({
      requestId: "recovery-forged-diagnosis",
      runId: started.runId,
      expectedRevision: rejected.revision,
    })).rejects.toThrow(/exact server-derived registration and no-diagnosis decision/i);
    expect(injected).toBe(true);
    const afterRejectedPublication = await store.get(started.runId);
    expect(afterRejectedPublication?.revision).toBe(rejected.revision);
    expect(afterRejectedPublication?.recovery).toBeUndefined();
    const restarted = await createStore(fixture).get(started.runId);
    expect(restarted?.revision).toBe(rejected.revision);
    expect(restarted?.recovery).toBeUndefined();
  }, 30_000);
});

interface Fixture {
  root: string;
  project: string;
  userRoot: string;
}

function createFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ai-orchestrator-mcp-run-")));
  const project = join(root, "project");
  const userRoot = join(root, "user");
  mkdirSync(project);
  mkdirSync(userRoot);
  return { root, project, userRoot };
}

function createStore(
  fixture: Fixture,
  overrides: Partial<Parameters<typeof createMcpRunStore>[0]> & { projectMirror?: boolean } = {},
) {
  const { projectMirror, ...options } = overrides;
  return createMcpRunStore({
    cwd: fixture.project,
    userDataRoot: fixture.userRoot,
    storage: { ...DEFAULT_CONFIG.mcp.runs, ...(projectMirror === undefined ? {} : { projectMirror }) },
    limits: executionLimitsFrom(DEFAULT_CONFIG),
    ...options,
  });
}

function serviceFor(fixture: Fixture, provider: McpRunProvider, supplied = createStore(fixture)) {
  return createMcpRunService({
    repository: supplied,
    provider,
    loop: loopConfigFrom(DEFAULT_CONFIG),
    maxProviderCalls: supplied.providerCallLimit,
    createRunId: (requestRef) => supplied.runIdForRequest(requestRef),
  });
}

function startInput(requestId: string, task = "Implement durable state") {
  return { requestId, task, coderIdentity: "cursor/coder" };
}

class PlanProvider implements McpRunProvider {
  planCalls = 0;
  judgeCalls = 0;

  constructor(
    private readonly verdicts: Array<"approve" | "reject"> = [],
    private readonly judgeFailures: McpProviderDefiniteFailureCode[] = [],
  ) {}

  preflight() {
    return { coderFamily: "cursor-family", requireDifferentCheckerFamily: false };
  }

  async plan(input: McpRunPlanRequest) {
    this.planCalls += 1;
    const decision = {
      decisionId: `plan-${this.planCalls}`,
      policyVersion: "test-v1",
      policyDigest: digest("policy"),
      configDigest: digest("config"),
      candidatesDigest: digest("candidates"),
    };
    const attempt: RoutedCompletionAttempt = {
      attempt: 1,
      providerRequestRef: digest(`request-${this.planCalls}`),
      routingDecision: decision,
      identity: { provider: "test", model: "planner", family: "planner-family" },
      thinking: "high",
      requestedOutputTokens: 512,
      estimatedCostUsd: 0.01,
    };
    await input.beforeAttempt(attempt);
    await input.afterAttempt({ ...attempt, outcome: "succeeded" });
    return {
      plan: "Durable plan",
      routing: {
        decisionId: decision.decisionId,
        stage: "plan" as const,
        selectedIndex: 0,
        selectedIdentity: attempt.identity,
        thinking: attempt.thinking,
        policyVersion: decision.policyVersion,
        policyDigest: decision.policyDigest,
        configDigest: decision.configDigest,
        candidatesDigest: decision.candidatesDigest,
        fallbackHistory: [],
      },
    };
  }

  async judge(input: McpRunJudgeRequest): Promise<Awaited<ReturnType<McpRunProvider["judge"]>>> {
    this.judgeCalls += 1;
    const verdict = this.verdicts.shift() ?? "approve";
    const decision = {
      decisionId: `judge-${this.judgeCalls}`,
      policyVersion: "test-v1",
      policyDigest: digest("judge-policy"),
      configDigest: digest("judge-config"),
      candidatesDigest: digest("judge-candidates"),
    };
    const attempt: RoutedCompletionAttempt = {
      attempt: 1,
      providerRequestRef: digest(`judge-request-${this.judgeCalls}`),
      routingDecision: decision,
      identity: { provider: "test", model: "judge", family: "judge-family" },
      thinking: "high",
      requestedOutputTokens: 256,
      estimatedCostUsd: 0.01,
    };
    await input.beforeAttempt(attempt);
    const failureCode = this.judgeFailures.shift();
    if (failureCode !== undefined) {
      await input.afterAttempt({ ...attempt, outcome: "failed", failureCode });
      throw new Error(failureCode);
    }
    await input.afterAttempt({ ...attempt, outcome: "succeeded" });
    const routing = {
      decisionId: decision.decisionId,
      stage: "fast-judge" as const,
      selectedIndex: 0,
      selectedIdentity: attempt.identity,
      thinking: attempt.thinking,
      policyVersion: decision.policyVersion,
      policyDigest: decision.policyDigest,
      configDigest: decision.configDigest,
      candidatesDigest: decision.candidatesDigest,
      fallbackHistory: [],
    };
    return verdict === "approve"
      ? { verdict, reasons: "independently approved", routing }
      : { verdict, reasons: "needs work", requiredFixes: "fix it", routing };
  }
}

function digest(value: string): string {
  return Buffer.from(value).toString("hex").padEnd(64, "0").slice(0, 64);
}
import { createHash } from "node:crypto";
