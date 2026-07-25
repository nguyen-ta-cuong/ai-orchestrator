import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RoutedCompletionAttempt } from "../mcp/llm.js";
import { createMcpRunService, type McpRunJudgeRequest, type McpRunPlanRequest, type McpRunProvider } from "../mcp/runService.js";
import { createMcpRunStore } from "../mcp/runStore.js";
import { DEFAULT_CONFIG, executionLimitsFrom, loopConfigFrom } from "../src/core/config.js";

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

  constructor(private readonly verdicts: Array<"approve" | "reject"> = []) {}

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
