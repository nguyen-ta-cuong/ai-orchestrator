import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RoutedCompletionAttempt, RoutedCompletionRequest, RoutedCompletionResult } from "../mcp/llm.js";
import { createRoutedMcpRunProvider } from "../mcp/runProvider.js";
import { createMcpRunRequestRecord, createMcpRunService, providerAttemptIdempotencyKey, providerEffectIdentity, type McpRunCheckpointReference, type McpRunPlanRequest, type McpRunPreflightRequest, type McpRunProvider, type McpRunProviderOutput, type McpRunPublicationGuard, type McpRunRecord, type McpRunRecordDraft, type McpRunRepository, type McpRunRequestRecord, type McpRunRequestUpdate, type McpRunStartTransaction, type McpRunTransaction, type ProviderEffect } from "../mcp/runService.js";
import type { ArtifactReference } from "../src/core/scheduler.js";
import {
  mcpRunAdvanceInputSchema,
  mcpRunCancelInputSchema,
  mcpRunGetInputSchema,
  mcpRunResponseSchema,
  mcpRunStartInputSchema,
  mcpRunToolResult,
} from "../mcp/runProtocol.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";

const runId = "mrun_abcdefghijklmnopqrstuv";
const requestId = "cursor-request-1";

describe("stateful MCP run protocol", () => {
  it("rejects caller-supplied counters, routing, topology, and recovery fields", () => {
    const start = {
      requestId,
      task: "add a flag",
      coderIdentity: "cursor/coder-model",
    };
    const forbidden: Record<string, unknown> = {
      iteration: 1,
      consecutiveRejections: 0,
      nextAction: "done",
      graphVersion: "attacker-graph",
      planVersion: 99,
      routing: { selectedIdentity: "attacker/model" },
      recoveryLevel: "skip-checker",
    };

    for (const [field, value] of Object.entries(forbidden)) {
      expect(mcpRunStartInputSchema.safeParse({ ...start, [field]: value }).success, field).toBe(false);
      expect(mcpRunAdvanceInputSchema.safeParse({
        requestId,
        runId,
        expectedRevision: 1,
        event: { type: "plan_approved" },
        [field]: value,
      }).success, field).toBe(false);
    }

    expect(mcpRunAdvanceInputSchema.safeParse({
      requestId,
      runId,
      expectedRevision: 1,
      event: { type: "code_result_submitted", diff: "diff", iteration: 1 },
    }).success).toBe(false);
    expect(mcpRunGetInputSchema.safeParse({ runId, expectedRevision: 1 }).success).toBe(false);
    expect(mcpRunCancelInputSchema.safeParse({ requestId, runId, expectedRevision: 1, nextAction: "done" }).success).toBe(false);
  });

  it("uses direct limits and remaining fields and returns an exact JSON text fallback", () => {
    const response = {
      outcome: "started",
      runId,
      revision: 2,
      status: "active",
      currentNode: "awaiting_approval",
      requiredAction: "approve_or_revise_plan",
      permittedEvents: ["plan_approved", "plan_revision_requested", "cancelled"],
      plan: "1. Inspect\n2. Implement\n3. Test",
      routing: [],
      progress: { coderIterations: 0, consecutiveRejections: 0, planVersion: 1 },
      limits: { coderIterations: 3, consecutiveRejections: 2, graphSteps: 100 },
      remaining: { coderIterations: 3, consecutiveRejections: 2, graphSteps: 98 },
    };

    const parsed = mcpRunResponseSchema.safeParse(response);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const result = mcpRunToolResult(parsed.data);
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    expect(result.structuredContent).toEqual(parsed.data);
  });

  it("enforces scheduler-safe decision IDs and semantic verdict variants", () => {
    const base = {
      outcome: "current" as const,
      runId,
      revision: 1,
      status: "done" as const,
      currentNode: "done" as const,
      requiredAction: "none" as const,
      permittedEvents: [],
      routing: [],
      progress: { coderIterations: 1, consecutiveRejections: 0, planVersion: 1 },
      limits: { coderIterations: 3 },
      remaining: { coderIterations: 2 },
    };
    expect(mcpRunResponseSchema.safeParse({
      ...base,
      lastVerdict: { verdict: "approve", reasons: "good", requiredFixes: "must not exist" },
    }).success).toBe(false);
    expect(mcpRunResponseSchema.safeParse({
      ...base,
      lastVerdict: { verdict: "reject", reasons: "bad" },
    }).success).toBe(false);

    const routingDecision = {
      decisionId: "bad decision id",
      stage: "plan",
      selectedIndex: 0,
      selectedIdentity: { provider: "p", model: "m" },
      thinking: "high",
      policyVersion: "v1",
      fallbackHistory: [],
    };
    expect(mcpRunResponseSchema.safeParse({ ...base, routing: [routingDecision] }).success).toBe(false);
    expect(mcpRunResponseSchema.safeParse({
      ...base,
      routing: [{ ...routingDecision, decisionId: "x".repeat(129) }],
    }).success).toBe(false);
  });
});

describe("server-owned MCP run service", () => {
  it("owns start, approval, code submission, and an approving judge transition", async () => {
    const harness = createHarness({ verdicts: ["approve"] });

    const started = await harness.service.start(startInput("start-approve"));
    expect(started).toMatchObject({
      outcome: "started",
      status: "active",
      currentNode: "awaiting_approval",
      requiredAction: "approve_or_revise_plan",
      progress: { coderIterations: 0, consecutiveRejections: 0, planVersion: 1 },
    });
    expect(started.revision).toBeGreaterThan(0);
    expect(started.permittedEvents).toEqual(["plan_approved", "plan_revision_requested", "cancelled"]);
    expect(harness.provider.planCalls).toHaveLength(1);

    const approved = await harness.service.advance({
      requestId: "approve-plan-1",
      runId: started.runId,
      expectedRevision: started.revision,
      event: { type: "plan_approved" },
    });
    expect(approved).toMatchObject({ currentNode: "coding", requiredAction: "implement_and_submit_code" });
    expect(approved.revision).toBeGreaterThan(started.revision);

    const done = await harness.service.advance({
      requestId: "submit-code-1",
      runId: started.runId,
      expectedRevision: approved.revision,
      event: { type: "code_result_submitted", diff: "diff --git a/a.ts b/a.ts\n+export const answer = 42;", testOutput: "1 test passed" },
    });
    expect(done).toMatchObject({
      outcome: "advanced",
      status: "done",
      currentNode: "done",
      requiredAction: "none",
      progress: { coderIterations: 1, consecutiveRejections: 0, planVersion: 1 },
      lastVerdict: { verdict: "approve" },
    });
    expect(done.revision).toBeGreaterThan(approved.revision);
    expect(done.permittedEvents).toEqual([]);
    expect(harness.provider.judgeCalls).toHaveLength(1);

    const current = await harness.service.get({ runId: started.runId });
    expect(current).toMatchObject({ outcome: "current", revision: done.revision, status: "done" });
  });

  it("retries after one rejection, replans after two, and requires fresh approval", async () => {
    const harness = createHarness({ verdicts: ["reject", "reject", "approve"], maxCoderIterations: 4 });
    const started = await harness.service.start(startInput("start-replan"));
    const approved = await approve(harness, started, "approve-replan-v1");

    const retry = await submit(harness, approved, "reject-code-1", "diff one");
    expect(retry).toMatchObject({
      currentNode: "coding",
      requiredAction: "implement_and_submit_code",
      progress: { coderIterations: 1, consecutiveRejections: 1, planVersion: 1 },
      lastVerdict: { verdict: "reject" },
    });
    expect(retry.revision).toBeGreaterThan(approved.revision);

    const replanned = await submit(harness, retry, "reject-code-2", "diff two");
    expect(replanned).toMatchObject({
      currentNode: "awaiting_approval",
      requiredAction: "approve_or_revise_plan",
      progress: { coderIterations: 2, consecutiveRejections: 0, planVersion: 2 },
    });
    expect(replanned.revision).toBeGreaterThan(retry.revision);
    expect(harness.provider.planCalls).toHaveLength(2);
    expect(harness.provider.planCalls[1]).toMatchObject({
      previousPlan: "plan-1",
      diff: "diff two",
    });
    expect(harness.provider.planCalls[1]?.judgeReports).toHaveLength(2);

    const reapproved = await approve(harness, replanned, "approve-replan-v2");
    const done = await submit(harness, reapproved, "approve-code-3", "diff three");
    expect(done).toMatchObject({
      status: "done",
      progress: { coderIterations: 3, consecutiveRejections: 0, planVersion: 2 },
    });
    expect(done.revision).toBeGreaterThan(reapproved.revision);
  });

  it("fails closed at the server-owned coding cap", async () => {
    const harness = createHarness({
      verdicts: ["reject", "reject"],
      maxCoderIterations: 2,
      plannerEscalationAfterRejections: 5,
    });
    const started = await harness.service.start(startInput("start-cap"));
    const approved = await approve(harness, started, "approve-cap");
    const retry = await submit(harness, approved, "cap-code-1", "diff one");
    const failed = await submit(harness, retry, "cap-code-2", "diff two");

    expect(failed).toMatchObject({
      status: "failed",
      currentNode: "failed",
      requiredAction: "none",
      progress: { coderIterations: 2, consecutiveRejections: 2, planVersion: 1 },
      remaining: { coderIterations: 0 },
    });
    expect(failed.message).toMatch(/maximum coder iterations/i);
    expect(harness.provider.judgeCalls).toHaveLength(2);
    expect(harness.provider.planCalls).toHaveLength(1);
  });

  it("uses each persisted run loop after restart in both configuration directions", async () => {
    for (const testCase of [
      { persistedMax: 1, restartedMax: 5, expectedNode: "failed", expectedStatus: "failed" },
      { persistedMax: 5, restartedMax: 1, expectedNode: "coding", expectedStatus: "active" },
    ] as const) {
      const repository = new InMemoryRunRepository();
      const provider = new ScriptedRunProvider(["reject"]);
      const original = createMcpRunService({
        repository,
        provider,
        loop: {
          maxCoderIterations: testCase.persistedMax,
          plannerEscalationAfterRejections: 4,
          requirePlanApproval: true,
        },
        createRunId: () => runId,
      });
      const started = await original.start(startInput(`restart-${testCase.persistedMax}-${testCase.restartedMax}`));
      const approved = await original.advance({
        requestId: `restart-approve-${testCase.persistedMax}`,
        runId: started.runId,
        expectedRevision: started.revision,
        event: { type: "plan_approved" },
      });

      const restarted = createMcpRunService({
        repository,
        provider,
        loop: {
          maxCoderIterations: testCase.restartedMax,
          plannerEscalationAfterRejections: 1,
          requirePlanApproval: true,
        },
      });
      const result = await restarted.advance({
        requestId: `restart-submit-${testCase.persistedMax}`,
        runId: started.runId,
        expectedRevision: approved.revision,
        event: { type: "code_result_submitted", diff: "restart diff" },
      });

      expect(result).toMatchObject({
        currentNode: testCase.expectedNode,
        status: testCase.expectedStatus,
        limits: { coderIterations: testCase.persistedMax, consecutiveRejections: 4 },
      });
      expect((await repository.get(started.runId))?.loop.maxCoderIterations).toBe(testCase.persistedMax);
    }
  });

  it("retains an inspectable immutable cancellation", async () => {
    const harness = createHarness();
    const started = await harness.service.start(startInput("start-cancel"));
    const cancelled = await harness.service.cancel({
      requestId: "cancel-run-1",
      runId: started.runId,
      expectedRevision: started.revision,
      reason: "User stopped the task",
    });

    expect(cancelled).toMatchObject({
      outcome: "cancelled",
      status: "cancelled",
      currentNode: "awaiting_approval",
      requiredAction: "none",
      message: "User stopped the task",
      plan: "plan-1",
      progress: { coderIterations: 0, consecutiveRejections: 0, planVersion: 1 },
    });
    expect(cancelled.revision).toBeGreaterThan(started.revision);
    expect(cancelled.permittedEvents).toEqual([]);
    await expect(harness.service.cancel({
      requestId: "cancel-run-2",
      runId: started.runId,
      expectedRevision: cancelled.revision,
    })).rejects.toThrow(/terminal/i);
    await expect(harness.service.advance({
      requestId: "advance-cancelled",
      runId: started.runId,
      expectedRevision: cancelled.revision,
      event: { type: "plan_approved" },
    })).rejects.toThrow(/terminal/i);

    expect(await harness.service.get({ runId: started.runId })).toMatchObject({ status: "cancelled", revision: cancelled.revision });
  });

  it("returns stale conflicts before validating an event or invoking a provider", async () => {
    const harness = createHarness({ verdicts: ["approve"] });
    const started = await harness.service.start(startInput("start-stale"));
    const approved = await approve(harness, started, "approve-stale");

    const conflict = await harness.service.advance({
      requestId: "stale-submit",
      runId: started.runId,
      expectedRevision: started.revision,
      event: { type: "code_result_submitted", diff: "stale diff" },
    });

    expect(conflict).toMatchObject({
      outcome: "conflict",
      revision: approved.revision,
      currentNode: "coding",
      requiredAction: "inspect_run",
      conflict: { expectedRevision: started.revision, currentRevision: approved.revision },
    });
    expect(conflict.plan).toBeUndefined();
    expect(conflict.lastVerdict).toBeUndefined();
    expect(conflict.routing).toEqual([]);
    expect(JSON.stringify(conflict)).not.toContain("plan-1");
    expect(harness.provider.judgeCalls).toHaveLength(0);
  });

  it("replays identical request IDs and rejects a reused ID with a different body", async () => {
    const harness = createHarness({ verdicts: ["approve"] });
    const input = startInput("start-idempotent");
    const started = await harness.service.start(input);

    expect(await harness.service.start(structuredClone(input))).toEqual(started);
    expect(harness.provider.planCalls).toHaveLength(1);
    await expect(harness.service.start({ ...input, task: "different task" }))
      .rejects.toThrow(/requestId.*different/i);

    const approved = await approve(harness, started, "approve-idempotent");
    const submittedInput = {
      requestId: "submit-idempotent",
      runId: started.runId,
      expectedRevision: approved.revision,
      event: { type: "code_result_submitted" as const, diff: "stable diff" },
    };
    const done = await harness.service.advance(submittedInput);
    expect(await harness.service.advance(structuredClone(submittedInput))).toEqual(done);
    expect(harness.provider.judgeCalls).toHaveLength(1);
    await expect(harness.service.advance({ ...submittedInput, event: { ...submittedInput.event, diff: "changed diff" } }))
      .rejects.toThrow(/requestId.*different/i);
  });

  it("rejects corrupt repository identities at every replay and transaction boundary", async () => {
    const harness = createHarness();
    const input = startInput("corrupt-boundary-start");
    const started = await harness.service.start(input);
    const otherRunId = "mrun_bbbbbbbbbbbbbbbbbbbbbb";
    const serviceFor = (repository: McpRunRepository) => createMcpRunService({
      repository,
      provider: harness.provider,
      loop: { maxCoderIterations: 99, plannerEscalationAfterRejections: 99, requirePlanApproval: true },
    });

    await expect(serviceFor(repositoryProxy(harness.repository, {
      get: (record) => record ? { ...record, runId: otherRunId } : record,
    })).get({ runId: started.runId })).rejects.toThrow(/different run/i);

    await expect(serviceFor(repositoryProxy(harness.repository, {
      transactionGet: (record) => record ? { ...record, runId: otherRunId } : record,
    })).advance({
      requestId: "corrupt-transaction-get",
      runId: started.runId,
      expectedRevision: started.revision,
      event: { type: "plan_approved" },
    })).rejects.toThrow(/different run/i);

    await expect(serviceFor(repositoryProxy(harness.repository, {
      runRequest: (_record) => harness.repository.firstRequest(),
    })).advance({
      requestId: "corrupt-request-ref",
      runId: started.runId,
      expectedRevision: started.revision,
      event: { type: "plan_approved" },
    })).rejects.toThrow(/different lookup reference/i);

    await expect(serviceFor(repositoryProxy(harness.repository, {
      runRequest: (record, requestRef) => {
        const source = record ?? harness.repository.firstRequest();
        return source ? { ...source, requestRef, runId: otherRunId } : source;
      },
    })).advance({
      requestId: "corrupt-request-run",
      runId: started.runId,
      expectedRevision: started.revision,
      event: { type: "plan_approved" },
    })).rejects.toThrow(/different run/i);

    for (const [name, checkpoint] of [
      ["run", (record: McpRunRecord) => ({ ...record, runId: otherRunId })],
      ["revision", (record: McpRunRecord) => ({ ...record, revision: record.revision + 1 })],
    ] as const) {
      await expect(serviceFor(repositoryProxy(harness.repository, {
        checkpoint: (record) => record ? checkpoint(record) : record,
      })).start(structuredClone(input)), name).rejects.toThrow(/different run|different revision/i);
    }

    const uncertainHarness = createHarness({
      afterProviderResult: () => { throw new Error("crash for corrupt replay"); },
    });
    const uncertainInput = startInput("corrupt-pending-authority");
    await expect(uncertainHarness.service.start(uncertainInput)).rejects.toThrow("crash for corrupt replay");
    const corruptReplay = serviceFor(repositoryProxy(uncertainHarness.repository, {
      startRequest: (record) => record?.state === "pending"
        ? { ...record, reservedRevision: record.reservedRevision + 100 }
        : record,
    }));
    await expect(corruptReplay.start(structuredClone(uncertainInput))).rejects.toThrow(/checkpoint.*not found|beyond.*authority/i);
  });

  it("rejects a settled receipt rebound to a historical checkpoint from the same run", async () => {
    const harness = createHarness();
    const input = startInput("historical-checkpoint-substitution");
    const started = await harness.service.start(input);
    const original = harness.repository.firstRequest();
    expect(original?.state).toBe("settled");
    const historical = await harness.repository.getCheckpoint({ runId: started.runId, revision: started.revision - 1 });
    if (!original || original.state !== "settled" || !historical) throw new Error("missing test authority");
    const forged = createMcpRunRequestRecord({
      state: "settled",
      requestRef: original.requestRef,
      requestHash: original.requestHash,
      mutationEffect: structuredClone(original.mutationEffect),
      providerEffectIds: [...original.providerEffectIds],
      outcome: original.outcome,
    }, historical);
    const restarted = createMcpRunService({
      repository: repositoryProxy(harness.repository, { startRequest: () => forged }),
      provider: harness.provider,
      loop: { maxCoderIterations: 99, plannerEscalationAfterRejections: 99, requirePlanApproval: true },
    });

    await expect(restarted.start(structuredClone(input)))
      .rejects.toThrow(/substituted|exact checkpoint authority/i);
    expect(harness.provider.planCalls).toHaveLength(1);
  });

  it("rejects a pending receipt whose effect was mutated after reservation", async () => {
    const harness = createHarness({
      afterProviderResult: () => { throw new Error("crash for mutated pending effect"); },
    });
    const input = startInput("mutated-pending-effect");
    await expect(harness.service.start(input)).rejects.toThrow("crash for mutated pending effect");
    const original = harness.repository.firstRequest();
    if (!original || original.state !== "pending" || original.effect.phase !== "awaiting_output_commit") {
      throw new Error("missing pending test authority");
    }
    const checkpoint = await harness.repository.getCheckpoint({
      runId: original.runId,
      revision: original.reservedRevision,
    });
    if (!checkpoint) throw new Error("missing pending checkpoint");
    const forged = createMcpRunRequestRecord({
      state: "pending",
      requestRef: original.requestRef,
      requestHash: original.requestHash,
      mutationEffect: structuredClone(original.mutationEffect),
      providerEffectIds: [...original.providerEffectIds],
      effect: {
        ...structuredClone(original.effect),
        attempt: {
          ...structuredClone(original.effect.attempt),
          routingDecision: {
            ...structuredClone(original.effect.attempt.routingDecision),
            configDigest: providerRef("mutated-pending-config"),
          },
        },
      },
    }, checkpoint);
    const restarted = createMcpRunService({
      repository: repositoryProxy(harness.repository, { startRequest: () => forged }),
      provider: harness.provider,
      loop: { maxCoderIterations: 99, plannerEscalationAfterRejections: 99, requirePlanApproval: true },
    });

    await expect(restarted.start(structuredClone(input)))
      .rejects.toThrow(/substituted|exact checkpoint authority/i);
    expect(harness.provider.planCalls).toHaveLength(1);
  });

  it("validates repository-assigned identity and revision before publication", async () => {
    for (const corruption of ["runId", "revision", "revisionJump", "noncanonicalCoderIdentity", "yolo"] as const) {
      const repository = new UnsafePublicationRepository(corruption);
      const service = createMcpRunService({
        repository,
        provider: new ScriptedRunProvider([]),
        loop: { maxCoderIterations: 3, plannerEscalationAfterRejections: 2, requirePlanApproval: true },
        createRunId: () => runId,
      });

      await expect(service.start(startInput(`unsafe-publication-${corruption}`)))
        .rejects.toThrow(
          corruption === "runId"
            ? /changed the run identity/i
            : corruption === "noncanonicalCoderIdentity"
              ? /canonical persisted form/i
              : corruption === "yolo"
                ? /authoritative run data|yolo/i
              : /safe integer|revision/i,
        );
      expect(repository.published).toBe(false);
    }
  });

  it("rejects noncanonical adapter data instead of accepting Zod trim normalization", async () => {
    const harness = createHarness();
    const started = await harness.service.start(startInput("noncanonical-read"));
    const restarted = createMcpRunService({
      repository: repositoryProxy(harness.repository, {
        get: (record) => record ? { ...record, coderIdentity: ` ${record.coderIdentity}` } : record,
      }),
      provider: harness.provider,
      loop: { maxCoderIterations: 3, plannerEscalationAfterRejections: 2, requirePlanApproval: true },
    });

    await expect(restarted.get({ runId: started.runId })).rejects.toThrow(/canonical persisted form/i);
  });

  it("revalidates persisted business invariants on every run read", async () => {
    const harness = createHarness();
    const started = await harness.service.start(startInput("read-business-invariants"));
    const mutations: Array<[string, (record: McpRunRecord) => McpRunRecord]> = [
      ["approval policy", (record) => ({
        ...record,
        loop: { ...record.loop, requirePlanApproval: false },
      })],
      ["yolo", (record) => ({ ...record, state: { ...record.state, yolo: true } })],
      ["status/phase", (record) => ({ ...record, status: "done" })],
      ["required plan", (record) => {
        const state = structuredClone(record.state);
        delete state.plan;
        return { ...record, state };
      }],
      ["pending authority", (record) => ({ ...record, pendingProviderIntent: true })],
      ["attempt count", (record) => ({ ...record, providerAttempts: record.providerAttempts + 1 })],
      ["rejection cap", (record) => ({
        ...record,
        state: {
          ...record.state,
          consecutiveRejections: record.loop.plannerEscalationAfterRejections + 1,
        },
      })],
      ["phase-invalid coder iteration", (record) => ({
        ...record,
        state: { ...record.state, coderIterations: record.state.coderIterations + 1 },
      })],
      ["effect identity", (record) => ({
        ...record,
        providerEffects: [
          ...record.providerEffects,
          { ...record.providerEffects[0]!, ordinal: record.nextProviderEffectOrdinal },
        ],
        nextProviderEffectOrdinal: record.nextProviderEffectOrdinal + 1,
      })],
      ["attempt key", (record) => ({
        ...record,
        providerAttempts: record.providerAttempts + 1,
        providerEvidence: [...record.providerEvidence, structuredClone(record.providerEvidence[0]!)],
      })],
      ["routing authority", (record) => ({
        ...record,
        routing: record.routing.map((decision, index) => index === 0
          ? { ...decision, configDigest: providerRef("mutated-read-config") }
          : decision),
      })],
    ];

    for (const [name, mutate] of mutations) {
      const restarted = createMcpRunService({
        repository: repositoryProxy(harness.repository, {
          get: (record) => record ? mutate(structuredClone(record)) : record,
        }),
        provider: harness.provider,
        loop: { maxCoderIterations: 3, plannerEscalationAfterRejections: 2, requirePlanApproval: true },
      });
      await expect(restarted.get({ runId: started.runId }), name).rejects.toThrow();
    }
  });

  it("rejects persisted active or abandoned fallbacks without an immediately prior definitive failure", async () => {
    let crash = true;
    const returnedOutput = createHarness({
      afterProviderResult: () => {
        if (crash) {
          crash = false;
          throw new Error("leave returned output uncommitted");
        }
      },
    });
    await expect(returnedOutput.service.start(startInput("persisted-fallback-after-success")))
      .rejects.toThrow("leave returned output uncommitted");

    const activeFallback = createMcpRunService({
      repository: repositoryProxy(returnedOutput.repository, {
        get: (record) => record ? forgeActiveFallback(record) : record,
      }),
      provider: returnedOutput.provider,
      loop: { maxCoderIterations: 3, plannerEscalationAfterRejections: 2, requirePlanApproval: true },
    });
    await expect(activeFallback.get({ runId: "mrun_aaaaaaaaaaaaaaaaaaaaa1" }))
      .rejects.toThrow(/fallback.*definitive failure/i);

    const unknownRepository = new InMemoryRunRepository();
    const unknownProvider: McpRunProvider = {
      preflight: () => ({ requireDifferentCheckerFamily: false }),
      plan: async (input) => {
        const attempt = scriptedAttempt("plan", 1);
        await input.beforeAttempt(attempt);
        await input.afterAttempt({ ...attempt, outcome: "unknown", failureCode: "provider_failed" });
        throw new Error("transport outcome is unknown");
      },
      judge: async () => { throw new Error("unused"); },
    };
    const unknownService = createMcpRunService({
      repository: unknownRepository,
      provider: unknownProvider,
      loop: { maxCoderIterations: 3, plannerEscalationAfterRejections: 2, requirePlanApproval: true },
      createRunId: () => runId,
    });
    const blocked = await unknownService.start(startInput("persisted-abandoned-fallback-after-unknown"));
    const abandonedFallback = createMcpRunService({
      repository: repositoryProxy(unknownRepository, {
        get: (record) => record ? forgeAbandonedFallback(record) : record,
      }),
      provider: unknownProvider,
      loop: { maxCoderIterations: 3, plannerEscalationAfterRejections: 2, requirePlanApproval: true },
    });
    expect(blocked.status).toBe("blocked");
    await expect(abandonedFallback.get({ runId }))
      .rejects.toThrow(/fallback.*definitive failure/i);
  });

  it("rejects persisted lifecycle phases and rejection streaks that the reducer cannot reach", async () => {
    const approved = createHarness({ verdicts: ["approve"] });
    const approvedStart = await approved.service.start(startInput("persisted-approve-then-code"));
    const approvedPlan = await approve(approved, approvedStart, "approve-persisted-approve-then-code");
    const done = await submit(approved, approvedPlan, "submit-persisted-approve-then-code", "approved diff");
    const resumedAfterApprove = createMcpRunService({
      repository: repositoryProxy(approved.repository, {
        get: (record) => record ? {
          ...record,
          status: "active",
          state: { ...record.state, phase: "coding" },
        } : record,
      }),
      provider: approved.provider,
      loop: { maxCoderIterations: 3, plannerEscalationAfterRejections: 2, requirePlanApproval: true },
    });
    expect(done.status).toBe("done");
    await expect(resumedAfterApprove.get({ runId: done.runId }))
      .rejects.toThrow(/reachable lifecycle/i);

    const rejected = createHarness({ verdicts: ["reject"], plannerEscalationAfterRejections: 3 });
    const rejectedStart = await rejected.service.start(startInput("persisted-wrong-rejection-streak"));
    const rejectedPlan = await approve(rejected, rejectedStart, "approve-persisted-wrong-rejection-streak");
    const retry = await submit(rejected, rejectedPlan, "submit-persisted-wrong-rejection-streak", "rejected diff");
    const resetStreak = createMcpRunService({
      repository: repositoryProxy(rejected.repository, {
        get: (record) => record ? {
          ...record,
          state: { ...record.state, consecutiveRejections: 0 },
        } : record,
      }),
      provider: rejected.provider,
      loop: { maxCoderIterations: 3, plannerEscalationAfterRejections: 3, requirePlanApproval: true },
    });
    expect(retry).toMatchObject({ status: "active", currentNode: "coding", progress: { consecutiveRejections: 1 } });
    await expect(resetStreak.get({ runId: retry.runId }))
      .rejects.toThrow(/reachable lifecycle/i);
  });

  it("binds pending current and genesis effect bases exactly to the immutable effect ledger", async () => {
    let crash = true;
    const harness = createHarness({
      afterProviderResult: () => {
        if (crash) {
          crash = false;
          throw new Error("leave pending effect authority");
        }
      },
    });
    const input = startInput("persisted-effect-base");
    await expect(harness.service.start(input)).rejects.toThrow("leave pending effect authority");

    for (const [name, hooks] of [
      ["current", {
        get: (record: McpRunRecord | undefined) => record ? mutatePendingEffectOrdinal(record) : record,
      }],
      ["genesis", {
        checkpoint: (record: McpRunRecord | undefined, reference: McpRunCheckpointReference) =>
          record && reference.revision === 1 ? mutatePendingEffectOrdinal(record) : record,
      }],
    ] satisfies Array<[string, RepositoryProxyHooks]>) {
      const restarted = createMcpRunService({
        repository: repositoryProxy(harness.repository, hooks),
        provider: harness.provider,
        loop: { maxCoderIterations: 3, plannerEscalationAfterRejections: 2, requirePlanApproval: true },
      });
      await expect(restarted.get({ runId: "mrun_aaaaaaaaaaaaaaaaaaaaa1" }), name)
        .rejects.toThrow(/effect.*ledger|effect identity/i);
    }
  });

  it("binds restart authority to immutable genesis instead of a self-attested current digest", async () => {
    const harness = createHarness();
    const started = await harness.service.start(startInput("immutable-genesis"));
    const restarted = createMcpRunService({
      repository: repositoryProxy(harness.repository, {
        get: (record) => record ? {
          ...record,
          loop: { ...record.loop, maxCoderIterations: 999 },
          maxProviderCalls: 999,
          coderIdentity: "attacker/rebound-coder",
          repoContext: "rebound repository authority",
        } : record,
      }),
      provider: harness.provider,
      loop: { maxCoderIterations: 999, plannerEscalationAfterRejections: 999, requirePlanApproval: true },
    });

    await expect(restarted.get({ runId: started.runId })).rejects.toThrow(/authority frozen at creation/i);
  });

  it("does not re-call PLAN after a crash leaves a durable provider intent uncertain", async () => {
    let crash = true;
    const harness = createHarness({
      afterProviderResult: ({ effect }) => {
        if (crash && effect.kind === "plan") {
          crash = false;
          throw new Error("simulated crash after PLAN");
        }
      },
    });
    const input = startInput("start-crash-plan");

    await expect(harness.service.start(input)).rejects.toThrow("simulated crash after PLAN");
    expect(harness.provider.planCalls).toHaveLength(1);

    const uncertain = await harness.service.start(structuredClone(input));
    expect(uncertain).toMatchObject({
      outcome: "current",
      status: "blocked",
      currentNode: "planning",
      requiredAction: "inspect_run",
    });
    expect(uncertain.message).toMatch(/outcome is uncertain/i);
    expect(JSON.stringify(uncertain)).not.toContain(input.task);
    const pendingBytes = harness.repository.requestAuthorityBytes();
    expect(pendingBytes).toContain("awaiting_output_commit");
    expect(pendingBytes).not.toContain('"outcome":"succeeded"');
    expect(pendingBytes).not.toContain('"plan":"plan-1"');
    expect(harness.provider.planCalls).toHaveLength(1);
    await expect(harness.service.start({ ...input, task: "changed after crash" }))
      .rejects.toThrow(/requestId.*different/i);
  });

  it("leaves the provider intent blocked when post-provider checkpointing fails", async () => {
    const repository = new InMemoryRunRepository();
    const provider = new ScriptedRunProvider([]);
    const service = createMcpRunService({
      repository,
      provider,
      loop: { maxCoderIterations: 3, plannerEscalationAfterRejections: 2, requirePlanApproval: true },
      createRunId: () => runId,
    });
    const input = startInput("post-provider-checkpoint-crash");
    repository.failNextProviderAttemptSettlement();

    await expect(service.start(input)).rejects.toThrow(/checkpoint failed.*uncertain/i);
    expect(provider.planCalls).toHaveLength(1);

    const blocked = await service.start(structuredClone(input));
    expect(blocked).toMatchObject({
      outcome: "current",
      status: "blocked",
      currentNode: "planning",
      requiredAction: "inspect_run",
      remaining: { providerCalls: 99 },
    });
    expect(provider.planCalls).toHaveLength(1);
  });

  it("keeps an unmatched beforeAttempt pending and unknown when the provider throws", async () => {
    const repository = new InMemoryRunRepository();
    let providerCalls = 0;
    const provider: McpRunProvider = {
      preflight: () => ({ requireDifferentCheckerFamily: false }),
      plan: async (input) => {
        providerCalls += 1;
        await input.beforeAttempt(scriptedAttempt("plan", providerCalls));
        throw new Error("provider transport disappeared before afterAttempt");
      },
      judge: async () => { throw new Error("unused"); },
    };
    const service = createMcpRunService({
      repository,
      provider,
      loop: { maxCoderIterations: 3, plannerEscalationAfterRejections: 2, requirePlanApproval: true },
      createRunId: () => runId,
    });
    const input = startInput("active-attempt-unknown");

    await expect(service.start(input)).rejects.toThrow(/checkpoint failed.*uncertain/i);
    const blocked = await service.start(structuredClone(input));
    expect(blocked).toMatchObject({
      status: "blocked",
      currentNode: "planning",
      requiredAction: "inspect_run",
    });
    expect(providerCalls).toBe(1);
    expect(await repository.get(runId)).toMatchObject({
      status: "active",
      pendingProviderIntent: true,
      requestAuthority: { state: "pending", effect: { phase: "attempting" } },
      providerEvidence: [],
      providerAttempts: 1,
    });
    const cancelled = await service.cancel({
      requestId: "cancel-active-attempt-unknown",
      runId,
      expectedRevision: blocked.revision,
      reason: "abandon the unknown provider call",
    });
    expect(cancelled).toMatchObject({ status: "cancelled", currentNode: "planning" });
    expect(await repository.get(runId)).toMatchObject({
      abandonedProviderAttempt: {
        kind: "plan",
        ordinal: 1,
        attempt: { attempt: 1, providerAttemptIdempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/) },
      },
    });
  });

  it("keeps an explicit post-dispatch unknown outcome blocked without retrying it", async () => {
    const repository = new InMemoryRunRepository();
    let providerCalls = 0;
    const provider: McpRunProvider = {
      preflight: () => ({ requireDifferentCheckerFamily: false }),
      plan: async (input) => {
        providerCalls += 1;
        const attempt = scriptedAttempt("plan", providerCalls);
        await input.beforeAttempt(attempt);
        await input.afterAttempt({ ...attempt, outcome: "unknown", failureCode: "provider_failed" });
        throw new Error("transport outcome is unknown");
      },
      judge: async () => { throw new Error("unused"); },
    };
    const service = createMcpRunService({
      repository,
      provider,
      loop: { maxCoderIterations: 3, plannerEscalationAfterRejections: 2, requirePlanApproval: true },
      createRunId: () => runId,
    });
    const input = startInput("post-dispatch-unknown");

    const blocked = await service.start(input);
    expect(blocked).toMatchObject({ status: "blocked", currentNode: "planning" });
    expect(await service.start(structuredClone(input))).toEqual(blocked);
    expect(providerCalls).toBe(1);
    expect(await repository.get(runId)).toMatchObject({
      pendingProviderIntent: true,
      requestAuthority: {
        state: "pending",
        effect: { phase: "attempted", result: { outcome: "unknown", failureCode: "provider_failed" } },
      },
      providerEvidence: [{ phase: "unknown", failureCode: "provider_failed" }],
    });
  });

  it("does not re-call JUDGE after a crash leaves a durable provider intent uncertain", async () => {
    let crashJudge = true;
    const harness = createHarness({
      verdicts: ["approve"],
      afterProviderResult: ({ effect }) => {
        if (crashJudge && effect.kind === "judge") {
          crashJudge = false;
          throw new Error("simulated crash after JUDGE");
        }
      },
    });
    const started = await harness.service.start(startInput("start-crash-judge"));
    const approved = await approve(harness, started, "approve-before-crash");
    const input = {
      requestId: "submit-crash-judge",
      runId: started.runId,
      expectedRevision: approved.revision,
      event: { type: "code_result_submitted" as const, diff: "sensitive diff body" },
    };

    await expect(harness.service.advance(input)).rejects.toThrow("simulated crash after JUDGE");
    expect(harness.provider.judgeCalls).toHaveLength(1);

    const uncertain = await harness.service.advance(structuredClone(input));
    expect(uncertain).toMatchObject({
      outcome: "current",
      status: "blocked",
      currentNode: "judging",
      requiredAction: "inspect_run",
    });
    expect(uncertain.plan).toBeUndefined();
    expect(uncertain.lastVerdict).toBeUndefined();
    expect(JSON.stringify(uncertain)).not.toContain(input.event.diff);
    expect(harness.provider.judgeCalls).toHaveLength(1);
    expect(await harness.service.get({ runId: started.runId })).toMatchObject({ status: "blocked" });
    await expect(harness.service.advance({ ...input, event: { ...input.event, diff: "changed after crash" } }))
      .rejects.toThrow(/requestId.*different/i);
  });

  it("settles known provider failures and invalid output instead of leaving an uncertain intent", async () => {
    const planFailure = createHarness();
    planFailure.provider.nextPlan = " ";
    const failedStart = await planFailure.service.start(startInput("invalid-plan-output"));
    expect(failedStart).toMatchObject({ status: "failed", currentNode: "failed", requiredAction: "none" });
    expect(failedStart.message).toMatch(/provider failed/i);
    expect(failedStart.message).not.toContain("Zod");
    expect(await planFailure.service.start(startInput("invalid-plan-output"))).toEqual(failedStart);
    expect(planFailure.provider.planCalls).toHaveLength(1);

    const judgeFailure = createHarness();
    const started = await judgeFailure.service.start(startInput("judge-provider-failure"));
    const approved = await approve(judgeFailure, started, "approve-provider-failure");
    judgeFailure.provider.nextJudgeError = new Error("secret provider credential detail");
    const failedJudge = await submit(judgeFailure, approved, "failed-judge-request", "diff body");
    expect(failedJudge).toMatchObject({ status: "failed", currentNode: "failed", requiredAction: "none" });
    expect(failedJudge.message).toMatch(/provider failed/i);
    expect(failedJudge.message).not.toContain("secret provider credential detail");
    expect(await submit(judgeFailure, approved, "failed-judge-request", "diff body")).toEqual(failedJudge);
    expect(judgeFailure.provider.judgeCalls).toHaveLength(1);
  });

  it("allows explicit cancellation of an uncertain provider intent without losing its replay evidence", async () => {
    let crashJudge = true;
    const harness = createHarness({
      afterProviderResult: ({ effect }) => {
        if (crashJudge && effect.kind === "judge") {
          crashJudge = false;
          throw new Error("simulated uncertain judge");
        }
      },
    });
    const started = await harness.service.start(startInput("cancel-uncertain"));
    const approved = await approve(harness, started, "approve-cancel-uncertain");
    const submission = {
      requestId: "uncertain-submission",
      runId: started.runId,
      expectedRevision: approved.revision,
      event: { type: "code_result_submitted" as const, diff: "uncertain diff" },
    };
    await expect(harness.service.advance(submission)).rejects.toThrow("simulated uncertain judge");
    const uncertain = await harness.service.advance(structuredClone(submission));

    const cancelled = await harness.service.cancel({
      requestId: "cancel-uncertain-request",
      runId: started.runId,
      expectedRevision: uncertain.revision,
      reason: "Human chose to cancel uncertain work",
    });
    expect(cancelled).toMatchObject({
      status: "cancelled",
      currentNode: "judging",
      requiredAction: "none",
      plan: "plan-1",
      progress: { coderIterations: 1 },
    });
    expect(cancelled.revision).toBeGreaterThan(uncertain.revision);
    expect(await harness.service.advance(structuredClone(submission))).toMatchObject({
      outcome: "current",
      status: "cancelled",
      revision: cancelled.revision,
    });
    expect(harness.provider.judgeCalls).toHaveLength(1);
    const authority = await harness.repository.get(started.runId);
    expect(authority?.providerEvidence.at(-1)).toMatchObject({
      kind: "judge",
      phase: "unknown",
      failureCode: "provider_failed",
    });
    expect(authority?.providerEvidence.some(({ phase }) => phase === "awaiting_output_commit")).toBe(false);
  });

  it("assigns revisions per run without leaking unrelated run activity", async () => {
    const harness = createHarness();
    const first = await harness.service.start(startInput("first-run"));
    const second = await harness.service.start(startInput("second-run"));

    expect(second.runId).not.toBe(first.runId);
    expect(second.revision).toBe(first.revision);
    const firstAdvanced = await approve(harness, first, "advance-first-only");
    expect((await harness.service.get({ runId: second.runId })).revision).toBe(second.revision);
    expect(firstAdvanced.revision).toBeGreaterThan(first.revision);
  });

  it("preflights strict checker routing before creating a run or spending PLAN", async () => {
    const harness = createHarness();
    harness.provider.nextPreflightError = new Error("no independent checker");

    await expect(harness.service.start(startInput("preflight-blocked"))).rejects.toThrow("no independent checker");
    expect(harness.provider.preflightCalls).toHaveLength(1);
    expect(harness.provider.planCalls).toHaveLength(0);
    expect(harness.repository.runCount()).toBe(0);

    const allowed = createHarness({ coderFamily: "builder-family", requireDifferentCheckerFamily: true });
    const started = await allowed.service.start(startInput("preflight-frozen"));
    expect(await allowed.repository.get(started.runId)).toMatchObject({
      coderIdentity: "cursor/coder-model",
      coderFamily: "builder-family",
      requireDifferentCheckerFamily: true,
    });

    const missingFamily = createHarness({ requireDifferentCheckerFamily: true });
    await expect(missingFamily.service.start(startInput("preflight-missing-family")))
      .rejects.toThrow(/coder family.*required/i);
    expect(missingFamily.provider.planCalls).toHaveLength(0);
    expect(missingFamily.repository.runCount()).toBe(0);
  });

  it("does not reserve a fallback after an earlier provider attempt succeeded", async () => {
    const repository = new InMemoryRunRepository();
    const networkAttempts: string[] = [];
    const provider: McpRunProvider = {
      preflight: () => ({ requireDifferentCheckerFamily: false }),
      plan: async (input) => {
        const first = scriptedAttempt("plan", 1);
        await input.beforeAttempt(first);
        networkAttempts.push("first");
        await input.afterAttempt({ ...first, outcome: "succeeded" });
        const second = {
          ...first,
          attempt: 2,
          providerRequestRef: providerRef("fallback-after-success"),
        };
        await input.beforeAttempt(second);
        networkAttempts.push("second");
        await input.afterAttempt({ ...second, outcome: "succeeded" });
        return { plan: "must not commit", routing: routing("plan", 1) };
      },
      judge: async () => { throw new Error("unused"); },
    };
    const service = createMcpRunService({
      repository,
      provider,
      loop: { maxCoderIterations: 3, plannerEscalationAfterRejections: 2, requirePlanApproval: true },
      createRunId: () => runId,
    });

    const failed = await service.start(startInput("fallback-after-success"));
    expect(failed).toMatchObject({ status: "failed", currentNode: "failed" });
    expect(networkAttempts).toEqual(["first"]);
    expect((await repository.get(runId))?.providerAttempts).toBe(1);
  });

  it("fails before settlement when JUDGE evidence violates frozen identity, family, or stage", async () => {
    const cases = [
      {
        name: "identity",
        harness: createHarness(),
        routing: {
          ...routing("fast-judge", 1),
          selectedIdentity: { provider: "cursor", model: "coder-model", family: "different-family" },
        },
      },
      {
        name: "family",
        harness: createHarness({ coderFamily: "shared-family", requireDifferentCheckerFamily: true }),
        routing: {
          ...routing("fast-judge", 1),
          selectedIdentity: { provider: "test", model: "checker", family: "shared-family" },
        },
      },
      {
        name: "stage",
        harness: createHarness(),
        routing: routing("plan", 1),
      },
    ];

    for (const testCase of cases) {
      const started = await testCase.harness.service.start(startInput(`semantic-${testCase.name}`));
      const approved = await approve(testCase.harness, started, `approve-${testCase.name}`);
      testCase.harness.provider.nextJudgeRouting = testCase.routing;
      const failed = await submit(testCase.harness, approved, `submit-${testCase.name}`, "diff");
      expect(failed).toMatchObject({ status: "failed", currentNode: "failed" });
      expect(failed.lastVerdict).toBeUndefined();
      expect(failed.routing).toHaveLength(1);
    }
  });

  it("accepts only routing evidence that exactly matches ordered provider attempts", async () => {
    const validRepository = new InMemoryRunRepository();
    const validService = createMcpRunService({
      repository: validRepository,
      provider: fallbackEvidenceProvider(),
      loop: { maxCoderIterations: 3, plannerEscalationAfterRejections: 2, requirePlanApproval: true },
      createRunId: () => runId,
    });
    const accepted = await validService.start(startInput("exact-fallback-evidence"));
    expect(accepted).toMatchObject({
      status: "active",
      routing: [{
        selectedIndex: 2,
        selectedIdentity: { provider: "p3", model: "selected", family: "family-3" },
        thinking: "high",
        fallbackHistory: [
          { identity: "p1/first", failureCode: "provider_response_failed" },
          { identity: "p2/second", failureCode: "http_error" },
        ],
      }],
    });
    expect((await validRepository.get(runId))?.providerEvidence).toMatchObject([
      { phase: "failed", identity: { provider: "p1", model: "first" }, thinking: "low", failureCode: "provider_response_failed" },
      { phase: "failed", identity: { provider: "p2", model: "second" }, thinking: "medium", failureCode: "http_error" },
      { phase: "output_committed", identity: { provider: "p3", model: "selected" }, thinking: "high" },
    ]);

    const forgeries: Array<[string, (decision: ReturnType<typeof exactFallbackRouting>) => void]> = [
      ["selected index", (decision) => { decision.selectedIndex = 1; }],
      ["selected identity", (decision) => { decision.selectedIdentity.model = "forged"; }],
      ["selected thinking", (decision) => { decision.thinking = "xhigh"; }],
      ["fallback order", (decision) => { decision.fallbackHistory.reverse(); }],
      ["fallback failure code", (decision) => { decision.fallbackHistory[0]!.failureCode = "invalid_json"; }],
      ["decision identity", (decision) => { decision.decisionId = "forged-decision"; }],
      ["policy version", (decision) => { decision.policyVersion = "forged-policy"; }],
      ["policy digest", (decision) => { decision.policyDigest = providerRef("forged-policy"); }],
      ["config digest", (decision) => { decision.configDigest = providerRef("forged-config"); }],
      ["candidate digest", (decision) => { decision.candidatesDigest = providerRef("forged-candidates"); }],
    ];
    for (const [name, mutate] of forgeries) {
      const repository = new InMemoryRunRepository();
      const service = createMcpRunService({
        repository,
        provider: fallbackEvidenceProvider(mutate),
        loop: { maxCoderIterations: 3, plannerEscalationAfterRejections: 2, requirePlanApproval: true },
        createRunId: () => runId,
      });
      const failed = await service.start(startInput(`forged-${name.replaceAll(" ", "-")}`));
      expect(failed, name).toMatchObject({ status: "failed", currentNode: "failed", routing: [] });
      expect((await repository.get(runId))?.providerEvidence.at(-1), name).toMatchObject({
        phase: "discarded",
        identity: { provider: "p3", model: "selected" },
        thinking: "high",
      });
    }
  });

  it("rejects a fallback that changes its predeclared routing authority before network use", async () => {
    const repository = new InMemoryRunRepository();
    const networkAttempts: string[] = [];
    const provider: McpRunProvider = {
      preflight: () => ({ requireDifferentCheckerFamily: false }),
      plan: async (input) => {
        const first: RoutedCompletionAttempt = {
          ...scriptedAttempt("plan", 1),
          routingDecision: exactFallbackAttemptDecision(),
        };
        await input.beforeAttempt(first);
        networkAttempts.push("first");
        await input.afterAttempt({ ...first, outcome: "failed", failureCode: "http_error" });
        const changed: RoutedCompletionAttempt = {
          ...first,
          attempt: 2,
          providerRequestRef: providerRef("changed-routing-fallback"),
          routingDecision: { ...first.routingDecision, candidatesDigest: providerRef("changed-candidates") },
        };
        await input.beforeAttempt(changed);
        networkAttempts.push("second");
        await input.afterAttempt({ ...changed, outcome: "succeeded" });
        return { plan: "must not commit", routing: exactFallbackRouting() };
      },
      judge: async () => { throw new Error("unused"); },
    };
    const service = createMcpRunService({
      repository,
      provider,
      loop: { maxCoderIterations: 3, plannerEscalationAfterRejections: 2, requirePlanApproval: true },
      createRunId: () => runId,
    });
    const input = startInput("changed-fallback-routing-authority");

    await expect(service.start(input)).rejects.toThrow(/checkpoint failed.*uncertain/i);
    expect(networkAttempts).toEqual(["first"]);
    expect(await service.start(structuredClone(input))).toMatchObject({ status: "blocked" });
  });

  it("checks maker/checker independence against the actual successful attempt", async () => {
    const harness = createHarness();
    const started = await harness.service.start(startInput("actual-checker-independence"));
    const approved = await approve(harness, started, "actual-checker-approve");
    harness.provider.nextJudgeAttempt = {
      attempt: 1,
      providerRequestRef: providerRef("actual-coder-checker"),
      routingDecision: {
        ...attemptRoutingDecision("fast-judge", 99),
        decisionId: "actual-coder-route",
      },
      identity: { provider: "cursor", model: "coder-model", family: "coder-family" },
      thinking: "high",
      requestedOutputTokens: 4_096,
    };
    harness.provider.nextJudgeRouting = {
      decisionId: "actual-coder-route",
      stage: "fast-judge",
      selectedIndex: 0,
      selectedIdentity: { provider: "cursor", model: "coder-model", family: "coder-family" },
      thinking: "high",
      policyVersion: "test-policy-v1",
      policyDigest: providerRef("policy-fast-judge-99"),
      configDigest: providerRef("config-fast-judge-99"),
      candidatesDigest: providerRef("candidates-fast-judge-99"),
      fallbackHistory: [],
    };

    const failed = await submit(harness, approved, "actual-checker-submit", "diff");
    expect(failed).toMatchObject({ status: "failed", currentNode: "failed", routing: [expect.any(Object)] });
    expect(failed.routing).toHaveLength(1);
    expect((await harness.repository.get(started.runId))?.providerEvidence.at(-1)?.phase).toBe("discarded");
  });

  it("binds afterAttempt evidence to the exact provider request reference", async () => {
    const repository = new InMemoryRunRepository();
    const provider = new ScriptedRunProvider([]);
    provider.mismatchNextProviderRequestRef = true;
    const service = createMcpRunService({
      repository,
      provider,
      loop: { maxCoderIterations: 3, plannerEscalationAfterRejections: 2, requirePlanApproval: true },
      createRunId: () => runId,
    });
    const input = startInput("mismatched-provider-reference");

    await expect(service.start(input)).rejects.toThrow(/checkpoint failed.*uncertain/i);
    expect(await service.start(structuredClone(input))).toMatchObject({ status: "blocked", currentNode: "planning" });
    expect(provider.planCalls).toHaveLength(1);
  });

  it("binds afterAttempt evidence to the exact predeclared routing decision", async () => {
    const repository = new InMemoryRunRepository();
    const provider = new ScriptedRunProvider([]);
    provider.mismatchNextRoutingDecision = true;
    const service = createMcpRunService({
      repository,
      provider,
      loop: { maxCoderIterations: 3, plannerEscalationAfterRejections: 2, requirePlanApproval: true },
      createRunId: () => runId,
    });
    const input = startInput("mismatched-routing-decision");

    await expect(service.start(input)).rejects.toThrow(/checkpoint failed.*uncertain/i);
    expect(await service.start(structuredClone(input))).toMatchObject({ status: "blocked", currentNode: "planning" });
    expect(provider.planCalls).toHaveLength(1);
  });

  it("checks the prospective response bound before a 101st routing entry can be persisted", async () => {
    const harness = createHarness();
    let current = await harness.service.start(startInput("routing-bound"));
    for (let index = 1; index < 100; index += 1) {
      current = await harness.service.advance({
        requestId: `revise-routing-${index}`,
        runId: current.runId,
        expectedRevision: current.revision,
        event: { type: "plan_revision_requested", feedback: `revision ${index}` },
      });
    }
    expect(current.routing).toHaveLength(100);
    const planCalls = harness.provider.planCalls.length;

    await expect(harness.service.advance({
      requestId: "revise-routing-overflow",
      runId: current.runId,
      expectedRevision: current.revision,
      event: { type: "plan_revision_requested", feedback: "one too many" },
    })).rejects.toThrow(/routing.*limit/i);
    expect(harness.provider.planCalls).toHaveLength(planCalls);
    expect(await harness.service.get({ runId: current.runId })).toMatchObject({
      revision: current.revision,
      status: "active",
      routing: current.routing,
    });
  }, 15_000);

  it("stores request receipts as hash/checkpoint references without raw run or provider text", async () => {
    const harness = createHarness({ verdicts: ["reject"] });
    const input = {
      requestId: "receipt-start",
      task: "RAW_TASK_MARKER",
      repoContext: "RAW_CONTEXT_MARKER",
      coderIdentity: "cursor/coder-model",
    };
    const started = await harness.service.start(input);
    const approved = await approve(harness, started, "receipt-approve");
    await harness.service.advance({
      requestId: "receipt-submit",
      runId: started.runId,
      expectedRevision: approved.revision,
      event: { type: "code_result_submitted", diff: "RAW_DIFF_MARKER", testOutput: "RAW_TEST_MARKER" },
    });

    const requestBytes = harness.repository.requestAuthorityBytes();
    for (const marker of ["RAW_TASK_MARKER", "RAW_CONTEXT_MARKER", "RAW_DIFF_MARKER", "RAW_TEST_MARKER", "scripted judge"]) {
      expect(requestBytes).not.toContain(marker);
    }
    expect(requestBytes).not.toContain("responseRecord");
    expect(requestBytes).toContain("checkpoint");
  });

  it("keeps provider request references distinct from client mutation hashes", async () => {
    const harness = createHarness();
    const started = await harness.service.start(startInput("separate-provider-identity"));
    const record = await harness.repository.get(started.runId);
    const providerRefs = record?.providerEvidence.map((item) => item.providerRequestRef) ?? [];
    const clientHashes = harness.repository.requestHashes();

    expect(providerRefs).toHaveLength(1);
    expect(clientHashes.length).toBeGreaterThan(0);
    expect(providerRefs.every((reference) => !clientHashes.includes(reference))).toBe(true);
  });

  it("reserves a run-scoped provider-attempt idempotency key before network use", async () => {
    const repository = new InMemoryRunRepository();
    const providerRequestRef = providerRef("same-outbound-request");
    let sawDurableKeyBeforeNetwork = false;
    let networkCalls = 0;
    const provider: McpRunProvider = {
      preflight: () => ({ requireDifferentCheckerFamily: false }),
      plan: async (input) => {
        const attempt: RoutedCompletionAttempt = {
          attempt: 1,
          providerRequestRef,
          routingDecision: attemptRoutingDecision("plan", 1),
          identity: { provider: "test", model: "plan-model", family: "plan-family" },
          thinking: "high",
          requestedOutputTokens: 4_096,
        };
        await input.beforeAttempt(attempt);
        sawDurableKeyBeforeNetwork = repository.requestAuthorityBytes().includes("providerAttemptIdempotencyKey");
        networkCalls += 1;
        await input.afterAttempt({ ...attempt, outcome: "succeeded" });
        return { plan: "idempotent plan", routing: routing("plan", 1) };
      },
      judge: async () => { throw new Error("unused"); },
    };
    const service = createMcpRunService({
      repository,
      provider,
      loop: { maxCoderIterations: 3, plannerEscalationAfterRejections: 2, requirePlanApproval: true },
      createRunId: () => runId,
    });

    await service.start(startInput("provider-attempt-idempotency"));
    const evidence = (await repository.get(runId))?.providerEvidence[0];
    expect(sawDurableKeyBeforeNetwork).toBe(true);
    expect(networkCalls).toBe(1);
    expect(evidence?.providerRequestRef).toBe(providerRequestRef);
    expect(evidence?.providerAttemptIdempotencyKey).toBe(
      providerAttemptIdempotencyKey(runId, {
        effectId: providerEffectIdentity(runId, "plan", 1), kind: "plan", ordinal: 1,
      }, { attempt: 1, providerRequestRef }),
    );
    expect(providerAttemptIdempotencyKey(
      "mrun_bbbbbbbbbbbbbbbbbbbbbb",
      {
        effectId: providerEffectIdentity("mrun_bbbbbbbbbbbbbbbbbbbbbb", "plan", 1),
        kind: "plan",
        ordinal: 1,
      },
      { attempt: 1, providerRequestRef },
    )).not.toBe(evidence?.providerAttemptIdempotencyKey);
    expect(evidence?.providerAttemptIdempotencyKey).not.toBe(providerRequestRef);
    expect(repository.requestHashes()).not.toContain(evidence?.providerAttemptIdempotencyKey);
  });

  it("allocates a unique durable effect identity for every repeated lifecycle visit", async () => {
    const harness = createHarness();
    const providerRequestRef = providerRef("identical-plan-request");
    harness.provider.fixedPlanProviderRequestRef = providerRequestRef;

    let current = await harness.service.start(startInput("unique-plan-visits"));
    for (const index of [1, 2]) {
      current = await harness.service.advance({
        requestId: `unique-plan-revision-${index}`,
        runId: current.runId,
        expectedRevision: current.revision,
        event: { type: "plan_revision_requested", feedback: "repeat the exact plan" },
      });
    }

    const record = await harness.repository.get(current.runId);
    expect(record?.providerEffects.map(({ kind, ordinal }) => ({ kind, ordinal }))).toEqual([
      { kind: "plan", ordinal: 1 },
      { kind: "plan", ordinal: 2 },
      { kind: "plan", ordinal: 3 },
    ]);
    expect(new Set(record?.providerEffects.map(({ effectId }) => effectId)).size).toBe(3);
    expect(record?.providerEvidence.map(({ providerRequestRef: reference }) => reference)).toEqual([
      providerRequestRef,
      providerRequestRef,
      providerRequestRef,
    ]);
    expect(new Set(record?.providerEvidence.map(({ providerAttemptIdempotencyKey }) => providerAttemptIdempotencyKey)).size).toBe(3);
    expect(new Set(record?.providerEvidence.map(({ routingDecision }) => routingDecision.decisionId)).size).toBe(3);
  });

  it("rejects reuse of a routing decision identity by a later provider effect before network use", async () => {
    const repository = new InMemoryRunRepository();
    let planCalls = 0;
    let networkCalls = 0;
    const provider: McpRunProvider = {
      preflight: () => ({ requireDifferentCheckerFamily: false }),
      plan: async (input) => {
        planCalls += 1;
        const decision = { ...attemptRoutingDecision("plan", planCalls), decisionId: "reused-plan-decision" };
        const attempt = { ...scriptedAttempt("plan", planCalls), routingDecision: decision };
        await input.beforeAttempt(attempt);
        networkCalls += 1;
        await input.afterAttempt({ ...attempt, outcome: "succeeded" });
        return {
          plan: `plan-${planCalls}`,
          routing: { ...routing("plan", planCalls), ...decision },
        };
      },
      judge: async () => { throw new Error("unused"); },
    };
    const service = createMcpRunService({
      repository,
      provider,
      loop: { maxCoderIterations: 3, plannerEscalationAfterRejections: 2, requirePlanApproval: true },
      createRunId: () => runId,
    });
    const started = await service.start(startInput("reused-routing-decision"));
    const revision = {
      requestId: "reused-routing-decision-revision",
      runId: started.runId,
      expectedRevision: started.revision,
      event: { type: "plan_revision_requested" as const, feedback: "revise" },
    };

    await expect(service.advance(revision)).rejects.toThrow(/checkpoint failed.*uncertain/i);
    expect(planCalls).toBe(2);
    expect(networkCalls).toBe(1);
    expect(await service.advance(structuredClone(revision))).toMatchObject({ status: "blocked" });
    expect(planCalls).toBe(2);
    expect(networkCalls).toBe(1);
  });

  it("persists only closed failure codes when provider evidence contains raw response text", async () => {
    const marker = "RAW_PROVIDER_BODY_MARKER_secret_endpoint_payload";
    const repository = new InMemoryRunRepository();
    const complete = async (request: RoutedCompletionRequest): Promise<RoutedCompletionResult> => {
      const attempt = completionAttempt(request, 0);
      await request.beforeAttempt?.(attempt);
      await request.afterAttempt?.({ ...attempt, outcome: "succeeded" });
      if (request.role === "planner") {
        return {
          text: "1. Safe plan",
          selectedIndex: 0,
          fallbackHistory: [{ identity: "raw/provider", reason: marker }],
        } as unknown as RoutedCompletionResult;
      }
      return {
        text: `{not-json:${marker}}`,
        selectedIndex: 0,
        fallbackHistory: [],
      };
    };
    const provider = createRoutedMcpRunProvider("/unused", {
      loadConfig: () => structuredClone(DEFAULT_CONFIG),
      complete,
      createDecisionId: (stage) => `raw-evidence-${stage}`,
    });
    const service = createMcpRunService({
      repository,
      provider,
      loop: { maxCoderIterations: 3, plannerEscalationAfterRejections: 2, requirePlanApproval: true },
      createRunId: () => runId,
    });

    const started = await service.start(startInput("raw-provider-evidence"));
    expect(started).toMatchObject({ status: "failed", currentNode: "failed", routing: [] });

    const authorityBytes = JSON.stringify(await repository.get(started.runId)) + repository.requestAuthorityBytes();
    expect(authorityBytes).not.toContain(marker);
    expect(authorityBytes).not.toContain("not-json");
  });

  it("preserves user revision feedback separately from empty and non-empty judge history end to end", async () => {
    const repository = new InMemoryRunRepository();
    const plannerPrompts: string[] = [];
    let judgeCall = 0;
    const complete = async (request: RoutedCompletionRequest): Promise<RoutedCompletionResult> => {
      const attempt = completionAttempt(request, 0);
      await request.beforeAttempt?.(attempt);
      if (request.role === "planner") {
        plannerPrompts.push(request.prompt);
        await request.afterAttempt?.({ ...attempt, outcome: "succeeded" });
        return { text: `routed-plan-${plannerPrompts.length}`, selectedIndex: 0, fallbackHistory: [] };
      }
      judgeCall += 1;
      await request.afterAttempt?.({ ...attempt, outcome: "succeeded" });
      return {
        text: JSON.stringify({ verdict: "reject", reasons: `judge-history-${judgeCall}`, requiredFixes: `fix-${judgeCall}` }),
        selectedIndex: 0,
        fallbackHistory: [],
      };
    };
    const provider = createRoutedMcpRunProvider("/unused", {
      loadConfig: () => structuredClone(DEFAULT_CONFIG),
      complete,
      createDecisionId: (stage) => `feedback-${stage}-${plannerPrompts.length}-${judgeCall}`,
    });
    let runSequence = 0;
    const service = createMcpRunService({
      repository,
      provider,
      loop: { maxCoderIterations: 5, plannerEscalationAfterRejections: 2, requirePlanApproval: true },
      createRunId: () => `mrun_${String(++runSequence).padStart(22, "f")}`,
    });

    const emptyHistory = await service.start(startInput("feedback-empty-start"));
    await service.advance({
      requestId: "feedback-empty-revise",
      runId: emptyHistory.runId,
      expectedRevision: emptyHistory.revision,
      event: { type: "plan_revision_requested", feedback: "EMPTY_HISTORY_FEEDBACK" },
    });
    expect(plannerPrompts.at(-1)).toContain("EMPTY_HISTORY_FEEDBACK");
    expect(plannerPrompts.at(-1)).not.toContain("judge-history-");

    const withHistory = await service.start(startInput("feedback-history-start"));
    const approved = await service.advance({
      requestId: "feedback-history-approve",
      runId: withHistory.runId,
      expectedRevision: withHistory.revision,
      event: { type: "plan_approved" },
    });
    const retry = await service.advance({
      requestId: "feedback-history-code-1",
      runId: withHistory.runId,
      expectedRevision: approved.revision,
      event: { type: "code_result_submitted", diff: "diff one" },
    });
    const replanned = await service.advance({
      requestId: "feedback-history-code-2",
      runId: withHistory.runId,
      expectedRevision: retry.revision,
      event: { type: "code_result_submitted", diff: "diff two" },
    });
    await service.advance({
      requestId: "feedback-history-revise",
      runId: withHistory.runId,
      expectedRevision: replanned.revision,
      event: { type: "plan_revision_requested", feedback: "NON_EMPTY_HISTORY_FEEDBACK" },
    });
    expect(plannerPrompts.at(-1)).toContain("NON_EMPTY_HISTORY_FEEDBACK");
    expect(plannerPrompts.at(-1)).toContain("judge-history-1");
    expect(plannerPrompts.at(-1)).toContain("judge-history-2");
  });

  it("durably consumes the final provider-attempt budget before a fallback can start", async () => {
    const repository = new InMemoryRunRepository();
    const provider = new BudgetFallbackProvider();
    const service = createMcpRunService({
      repository,
      provider,
      loop: { maxCoderIterations: 3, plannerEscalationAfterRejections: 2, requirePlanApproval: true },
      maxProviderCalls: 1,
      createRunId: () => runId,
    });

    const failed = await service.start(startInput("provider-budget"));
    expect(failed).toMatchObject({
      status: "failed",
      limits: { providerCalls: 1 },
      remaining: { providerCalls: 0 },
    });
    expect(provider.networkAttempts).toEqual(["p1/primary"]);
    expect((await repository.get(failed.runId))?.providerAttempts).toBe(1);
  });
});

function startInput(requestIdValue: string) {
  return {
    requestId: requestIdValue,
    task: "Implement the requested behavior",
    repoContext: "TypeScript project with Vitest",
    coderIdentity: "cursor/coder-model",
  };
}

type Harness = ReturnType<typeof createHarness>;

async function approve(harness: Harness, response: { runId: string; revision: number }, requestIdValue: string) {
  return harness.service.advance({
    requestId: requestIdValue,
    runId: response.runId,
    expectedRevision: response.revision,
    event: { type: "plan_approved" },
  });
}

async function submit(harness: Harness, response: { runId: string; revision: number }, requestIdValue: string, diff: string) {
  return harness.service.advance({
    requestId: requestIdValue,
    runId: response.runId,
    expectedRevision: response.revision,
    event: { type: "code_result_submitted", diff },
  });
}

function createHarness(options: {
  verdicts?: Array<"approve" | "reject">;
  maxCoderIterations?: number;
  plannerEscalationAfterRejections?: number;
  afterProviderResult?: (context: { runId: string; effect: ProviderEffect }) => void;
  coderFamily?: string;
  requireDifferentCheckerFamily?: boolean;
} = {}) {
  const repository = new InMemoryRunRepository();
  const provider = new ScriptedRunProvider(
    options.verdicts ?? [],
    options.coderFamily,
    options.requireDifferentCheckerFamily ?? false,
  );
  let nextRun = 0;
  const service = createMcpRunService({
    repository,
    provider,
    loop: {
      maxCoderIterations: options.maxCoderIterations ?? 3,
      plannerEscalationAfterRejections: options.plannerEscalationAfterRejections ?? 2,
      requirePlanApproval: false,
    },
    createRunId: () => `mrun_${String(++nextRun).padStart(22, "a")}`,
    afterProviderResult: options.afterProviderResult,
  });
  return { repository, provider, service };
}

class ScriptedRunProvider implements McpRunProvider {
  readonly preflightCalls: McpRunPreflightRequest[] = [];
  readonly planCalls: McpRunPlanRequest[] = [];
  readonly judgeCalls: Parameters<McpRunProvider["judge"]>[0][] = [];
  nextPreflightError: Error | undefined;
  nextPlan: string | undefined;
  nextJudgeError: Error | undefined;
  nextJudgeRouting: ReturnType<typeof routing> | undefined;
  nextJudgeAttempt: RoutedCompletionAttempt | undefined;
  mismatchNextProviderRequestRef = false;
  mismatchNextRoutingDecision = false;
  fixedPlanProviderRequestRef: string | undefined;

  constructor(
    private readonly verdicts: Array<"approve" | "reject">,
    private readonly coderFamily?: string,
    private readonly requireDifferentCheckerFamily = false,
  ) {}

  preflight(input: McpRunPreflightRequest): ReturnType<McpRunProvider["preflight"]> {
    this.preflightCalls.push(structuredClone(input));
    if (this.nextPreflightError) {
      const error = this.nextPreflightError;
      this.nextPreflightError = undefined;
      throw error;
    }
    return {
      ...(this.coderFamily === undefined ? {} : { coderFamily: this.coderFamily }),
      requireDifferentCheckerFamily: this.requireDifferentCheckerFamily,
    };
  }

  async plan(input: McpRunPlanRequest): Promise<Awaited<ReturnType<McpRunProvider["plan"]>>> {
    this.planCalls.push(input);
    const call = this.planCalls.length;
    const attempt = {
      ...scriptedAttempt("plan", call),
      ...(this.fixedPlanProviderRequestRef === undefined ? {} : { providerRequestRef: this.fixedPlanProviderRequestRef }),
    };
    await input.beforeAttempt(attempt);
    const plan = this.nextPlan ?? `plan-${call}`;
    this.nextPlan = undefined;
    await input.afterAttempt({
      ...attempt,
      ...(this.mismatchNextProviderRequestRef ? { providerRequestRef: providerRef(`mismatch-plan-${call}`) } : {}),
      ...(this.mismatchNextRoutingDecision ? {
        routingDecision: { ...attempt.routingDecision, configDigest: providerRef(`mismatch-config-${call}`) },
      } : {}),
      outcome: "succeeded",
    });
    this.mismatchNextProviderRequestRef = false;
    this.mismatchNextRoutingDecision = false;
    return { plan, routing: routing("plan", call) };
  }

  async judge(input: Parameters<McpRunProvider["judge"]>[0]): Promise<Awaited<ReturnType<McpRunProvider["judge"]>>> {
    this.judgeCalls.push(input);
    const call = this.judgeCalls.length;
    const attempt = this.nextJudgeAttempt ?? scriptedAttempt("fast-judge", call);
    this.nextJudgeAttempt = undefined;
    await input.beforeAttempt(attempt);
    if (this.nextJudgeError) {
      const error = this.nextJudgeError;
      this.nextJudgeError = undefined;
      await input.afterAttempt({ ...attempt, outcome: "failed", failureCode: "provider_response_failed" });
      throw error;
    }
    const verdict = this.verdicts.shift() ?? "approve";
    await input.afterAttempt({ ...attempt, outcome: "succeeded" });
    return {
      verdict,
      reasons: `${verdict} from scripted judge ${call}`,
      ...(verdict === "reject" ? { requiredFixes: `fix scripted issue ${call}` } : {}),
      routing: this.nextJudgeRouting ?? routing("fast-judge", call),
    } as Awaited<ReturnType<McpRunProvider["judge"]>>;
  }
}

function fallbackEvidenceProvider(
  mutate?: (decision: ReturnType<typeof exactFallbackRouting>) => void,
): McpRunProvider {
  return {
    preflight: () => ({ requireDifferentCheckerFamily: false }),
    plan: async (input) => {
      const attempts: RoutedCompletionAttempt[] = [
        {
          attempt: 1,
          providerRequestRef: providerRef("fallback-first"),
          routingDecision: exactFallbackAttemptDecision(),
          identity: { provider: "p1", model: "first", family: "family-1" },
          thinking: "low",
          requestedOutputTokens: 1_024,
        },
        {
          attempt: 2,
          providerRequestRef: providerRef("fallback-second"),
          routingDecision: exactFallbackAttemptDecision(),
          identity: { provider: "p2", model: "second", family: "family-2" },
          thinking: "medium",
          requestedOutputTokens: 2_048,
        },
        {
          attempt: 3,
          providerRequestRef: providerRef("fallback-selected"),
          routingDecision: exactFallbackAttemptDecision(),
          identity: { provider: "p3", model: "selected", family: "family-3" },
          thinking: "high",
          requestedOutputTokens: 4_096,
        },
      ];
      await input.beforeAttempt(attempts[0]!);
      await input.afterAttempt({ ...attempts[0]!, outcome: "failed", failureCode: "provider_response_failed" });
      await input.beforeAttempt(attempts[1]!);
      await input.afterAttempt({ ...attempts[1]!, outcome: "failed", failureCode: "http_error" });
      await input.beforeAttempt(attempts[2]!);
      await input.afterAttempt({ ...attempts[2]!, outcome: "succeeded" });
      const decision = exactFallbackRouting();
      mutate?.(decision);
      return { plan: "exact fallback plan", routing: decision };
    },
    judge: async () => { throw new Error("unused"); },
  };
}

function exactFallbackRouting() {
  return {
    decisionId: "exact-fallback-route",
    stage: "plan" as const,
    selectedIndex: 2,
    selectedIdentity: { provider: "p3", model: "selected", family: "family-3" },
    thinking: "high" as const,
    policyVersion: "test-policy-v1",
    policyDigest: providerRef("exact-policy"),
    configDigest: providerRef("exact-config"),
    candidatesDigest: providerRef("exact-candidates"),
    fallbackHistory: [
      { identity: "p1/first", failureCode: "provider_response_failed" as const },
      { identity: "p2/second", failureCode: "http_error" as const },
    ],
  };
}

function exactFallbackAttemptDecision() {
  return {
    decisionId: "exact-fallback-route",
    policyVersion: "test-policy-v1",
    policyDigest: providerRef("exact-policy"),
    configDigest: providerRef("exact-config"),
    candidatesDigest: providerRef("exact-candidates"),
  };
}

class BudgetFallbackProvider implements McpRunProvider {
  readonly networkAttempts: string[] = [];

  preflight(): ReturnType<McpRunProvider["preflight"]> {
    return { requireDifferentCheckerFamily: false };
  }

  async plan(input: McpRunPlanRequest): Promise<Awaited<ReturnType<McpRunProvider["plan"]>>> {
    const candidates = [
      { provider: "p1", model: "primary" },
      { provider: "p2", model: "fallback" },
    ];
    for (const [index, identity] of candidates.entries()) {
      const attempt: RoutedCompletionAttempt = {
        attempt: index + 1,
        providerRequestRef: providerRef(`budget-${index + 1}`),
        routingDecision: attemptRoutingDecision("plan", 1),
        identity,
        thinking: "high",
      };
      await input.beforeAttempt(attempt);
      this.networkAttempts.push(`${identity.provider}/${identity.model}`);
      if (index === 0) {
        await input.afterAttempt({ ...attempt, outcome: "failed", failureCode: "http_error" });
        continue;
      }
      await input.afterAttempt({ ...attempt, outcome: "succeeded" });
      return { plan: "fallback plan", routing: routing("plan", 1) };
    }
    throw new Error("all candidates failed");
  }

  async judge(): Promise<Awaited<ReturnType<McpRunProvider["judge"]>>> {
    throw new Error("unused");
  }
}

function scriptedAttempt(stage: "plan" | "fast-judge", call: number): RoutedCompletionAttempt {
  return {
    attempt: 1,
    providerRequestRef: providerRef(`${stage}-${call}`),
    routingDecision: attemptRoutingDecision(stage, call),
    identity: { provider: "test", model: `${stage}-model`, family: `${stage}-family` },
    thinking: "high",
    requestedOutputTokens: 4_096,
    estimatedCostUsd: call / 1_000,
  };
}

function completionAttempt(request: RoutedCompletionRequest, index: number): RoutedCompletionAttempt {
  const candidate = request.candidates[index];
  if (!candidate) throw new Error(`Missing completion candidate ${index}`);
  return {
    attempt: index + 1,
    providerRequestRef: providerRef(`${request.role}-${request.prompt}-${index}`),
    routingDecision: request.routingDecision ?? attemptRoutingDecision(request.role === "planner" ? "plan" : "fast-judge", 1),
    identity: {
      provider: candidate.provider,
      model: candidate.model,
      ...(candidate.family === undefined ? {} : { family: candidate.family }),
    },
    thinking: candidate.thinking,
    ...(candidate.requestedOutputTokens === undefined ? {} : { requestedOutputTokens: candidate.requestedOutputTokens }),
    ...(candidate.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: candidate.estimatedCostUsd }),
  };
}

function routing(stage: "plan" | "fast-judge", call: number) {
  const decision = attemptRoutingDecision(stage, call);
  return {
    decisionId: decision.decisionId,
    stage,
    selectedIndex: 0,
    selectedIdentity: { provider: "test", model: `${stage}-model`, family: `${stage}-family` },
    thinking: "high" as const,
    policyVersion: decision.policyVersion,
    policyDigest: decision.policyDigest,
    configDigest: decision.configDigest,
    candidatesDigest: decision.candidatesDigest,
    fallbackHistory: [],
  };
}

function attemptRoutingDecision(stage: "plan" | "fast-judge", call: number) {
  return {
    decisionId: `${stage}-${call}`,
    policyVersion: "test-policy-v1",
    policyDigest: providerRef(`policy-${stage}-${call}`),
    configDigest: providerRef(`config-${stage}-${call}`),
    candidatesDigest: providerRef(`candidates-${stage}-${call}`),
  };
}

class InMemoryRunRepository implements McpRunRepository {
  private readonly runs = new Map<string, McpRunRecord>();
  private readonly history = new Map<string, Map<number, McpRunRecord>>();
  private readonly startRequests = new Map<string, McpRunRequestRecord>();
  private readonly runRequests = new Map<string, Map<string, McpRunRequestRecord>>();
  private failAttemptSettlement = false;

  failNextProviderAttemptSettlement(): void {
    this.failAttemptSettlement = true;
  }

  async withStartLease<T>(requestRef: string, work: (transaction: McpRunStartTransaction) => Promise<T>): Promise<T> {
    return work({
      getRequest: async () => clone(this.startRequests.get(requestRef)),
      reserve: async (draft, update, beforePublication) => {
        if (this.runs.has(draft.runId) || this.startRequests.has(requestRef)) throw new Error("in-memory create conflict");
        return this.write(undefined, draft, update, true, beforePublication);
      },
      compareAndSwap: async (expectedRevision, draft, update, beforePublication) => this.write(expectedRevision, draft, update, true, beforePublication),
      writeProviderOutput: async (input) => this.writeProviderOutput(input),
    });
  }

  async withRunLease<T>(targetRunId: string, work: (transaction: McpRunTransaction) => Promise<T>): Promise<T> {
    return work({
      get: async () => clone(this.runs.get(targetRunId)),
      getRequest: async (requestRef) => clone(this.runRequests.get(targetRunId)?.get(requestRef)),
      compareAndSwap: async (expectedRevision, draft, update, beforePublication) => this.write(expectedRevision, draft, update, false, beforePublication),
      writeProviderOutput: async (input) => this.writeProviderOutput(input),
    });
  }

  async get(targetRunId: string): Promise<McpRunRecord | undefined> {
    return clone(this.runs.get(targetRunId));
  }

  async getCheckpoint(reference: McpRunCheckpointReference): Promise<McpRunRecord | undefined> {
    return clone(this.history.get(reference.runId)?.get(reference.revision));
  }

  runCount(): number {
    return this.runs.size;
  }

  requestAuthorityBytes(): string {
    return JSON.stringify({
      startRequests: [...this.startRequests.entries()],
      runRequests: [...this.runRequests.entries()].map(([key, requests]) => [key, [...requests.entries()]]),
    });
  }

  requestHashes(): string[] {
    return [
      ...[...this.startRequests.values()].map((request) => request.requestHash),
      ...[...this.runRequests.values()].flatMap((requests) => [...requests.values()].map((request) => request.requestHash)),
    ];
  }

  firstRequest(): McpRunRequestRecord | undefined {
    return clone(this.startRequests.values().next().value as McpRunRequestRecord | undefined);
  }

  private async write(
    expectedRevision: number | undefined,
    draft: McpRunRecordDraft,
    update: McpRunRequestUpdate,
    start: boolean,
    beforePublication: McpRunPublicationGuard,
  ): Promise<McpRunRecord | undefined> {
    if (
      this.failAttemptSettlement
      && update.state === "pending"
      && (update.effect.phase === "attempted" || update.effect.phase === "awaiting_output_commit")
    ) {
      this.failAttemptSettlement = false;
      throw new Error("simulated durable attempt-settlement failure");
    }
    const current = this.runs.get(draft.runId);
    if (expectedRevision !== undefined && (!current || current.revision !== expectedRevision)) return undefined;
    const record = { ...clone(draft), revision: (current?.revision ?? 0) + 1 } satisfies McpRunRecord;
    const request = createMcpRunRequestRecord(update, record);
    beforePublication({ record: clone(record), request: clone(request) });
    this.runs.set(record.runId, clone(record));
    const history = this.history.get(record.runId) ?? new Map<number, McpRunRecord>();
    history.set(record.revision, clone(record));
    this.history.set(record.runId, history);
    const requests = this.runRequests.get(record.runId) ?? new Map<string, McpRunRequestRecord>();
    requests.set(update.requestRef, clone(request));
    this.runRequests.set(record.runId, requests);
    if (start) this.startRequests.set(update.requestRef, clone(request));
    return clone(record);
  }

  private writeProviderOutput(input: McpRunProviderOutput): ArtifactReference {
    const bytes = Buffer.from(input.bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    return {
      planVersion: 1,
      nodeId: "authority",
      contract: input.contract,
      path: `nodes/1/authority/${digest}.artifact`,
      sha256: digest,
      sizeBytes: bytes.byteLength,
    };
  }
}

interface RepositoryProxyHooks {
  get?: (record: McpRunRecord | undefined) => McpRunRecord | undefined;
  transactionGet?: (record: McpRunRecord | undefined) => McpRunRecord | undefined;
  startRequest?: (record: McpRunRequestRecord | undefined, requestRef: string) => McpRunRequestRecord | undefined;
  runRequest?: (record: McpRunRequestRecord | undefined, requestRef: string, runId: string) => McpRunRequestRecord | undefined;
  checkpoint?: (record: McpRunRecord | undefined, reference: McpRunCheckpointReference) => McpRunRecord | undefined;
}

function repositoryProxy(base: McpRunRepository, hooks: RepositoryProxyHooks): McpRunRepository {
  return {
    withStartLease: (requestRef, work) => base.withStartLease(requestRef, (transaction) => work({
      getRequest: async () => {
        const record = await transaction.getRequest();
        return hooks.startRequest ? hooks.startRequest(record, requestRef) : record;
      },
      reserve: (draft, update, beforePublication) => transaction.reserve(draft, update, beforePublication),
      compareAndSwap: (expectedRevision, draft, update, beforePublication) => transaction.compareAndSwap(
        expectedRevision,
        draft,
        update,
        beforePublication,
      ),
      writeProviderOutput: (input) => transaction.writeProviderOutput(input),
    })),
    withRunLease: (targetRunId, work) => base.withRunLease(targetRunId, (transaction) => work({
      get: async () => {
        const record = await transaction.get();
        return hooks.transactionGet ? hooks.transactionGet(record) : record;
      },
      getRequest: async (requestRef) => {
        const record = await transaction.getRequest(requestRef);
        return hooks.runRequest ? hooks.runRequest(record, requestRef, targetRunId) : record;
      },
      compareAndSwap: (expectedRevision, draft, update, beforePublication) => transaction.compareAndSwap(
        expectedRevision,
        draft,
        update,
        beforePublication,
      ),
      writeProviderOutput: (input) => transaction.writeProviderOutput(input),
    })),
    get: async (targetRunId) => {
      const record = await base.get(targetRunId);
      return hooks.get ? hooks.get(record) : record;
    },
    getCheckpoint: async (reference) => {
      const record = await base.getCheckpoint(reference);
      return hooks.checkpoint ? hooks.checkpoint(record, reference) : record;
    },
  };
}

class UnsafePublicationRepository implements McpRunRepository {
  published = false;

  constructor(private readonly corruption: "runId" | "revision" | "revisionJump" | "noncanonicalCoderIdentity" | "yolo") {}

  async withStartLease<T>(
    _requestRef: string,
    work: (transaction: McpRunStartTransaction) => Promise<T>,
  ): Promise<T> {
    return work({
      getRequest: async () => undefined,
      reserve: async (draft, update, beforePublication) => {
        const assignedRunId = this.corruption === "runId" ? "mrun_bbbbbbbbbbbbbbbbbbbbbb" : draft.runId;
        const assignedRevision = this.corruption === "revision"
          ? Number.MAX_SAFE_INTEGER + 1
          : this.corruption === "revisionJump"
            ? 2
            : 1;
        const record = {
          ...clone(draft),
          runId: assignedRunId,
          revision: assignedRevision,
          ...(this.corruption === "noncanonicalCoderIdentity"
            ? { coderIdentity: ` ${draft.coderIdentity}` }
            : {}),
          ...(this.corruption === "yolo" ? { state: { ...clone(draft.state), yolo: true } } : {}),
        } as McpRunRecord;
        const request = createMcpRunRequestRecord(update, record);
        beforePublication({ record, request });
        this.published = true;
        return record;
      },
      compareAndSwap: async () => { throw new Error("unreachable"); },
      writeProviderOutput: async () => { throw new Error("unreachable"); },
    });
  }

  async withRunLease<T>(_runId: string, _work: (transaction: McpRunTransaction) => Promise<T>): Promise<T> {
    throw new Error("unreachable");
  }

  async get(): Promise<McpRunRecord | undefined> {
    return undefined;
  }

  async getCheckpoint(): Promise<McpRunRecord | undefined> {
    return undefined;
  }
}

function providerRef(seed: string): string {
  return Buffer.from(seed).toString("hex").padEnd(64, "0").slice(0, 64);
}

function forgeActiveFallback(record: McpRunRecord): McpRunRecord {
  const authority = record.requestAuthority;
  if (authority.state !== "pending" || authority.effect.phase !== "awaiting_output_commit") {
    throw new Error("Expected returned provider output authority");
  }
  const effect = record.providerEffects.find(({ effectId }) => effectId === authority.effect.effectId);
  if (!effect) throw new Error("Expected provider effect ledger entry");
  const attemptWithoutKey = {
    ...authority.effect.attempt,
    attempt: authority.effect.attempt.attempt + 1,
    providerRequestRef: providerRef("forged-active-fallback"),
  };
  const attempt = {
    ...attemptWithoutKey,
    providerAttemptIdempotencyKey: providerAttemptIdempotencyKey(record.runId, effect, attemptWithoutKey),
  };
  return {
    ...record,
    providerAttempts: record.providerAttempts + 1,
    requestAuthority: {
      ...authority,
      effect: { ...effect, phase: "attempting", attempt },
    },
  };
}

function forgeAbandonedFallback(record: McpRunRecord): McpRunRecord {
  const authority = record.requestAuthority;
  if (authority.state !== "pending" || authority.effect.phase !== "attempted") {
    throw new Error("Expected settled unknown provider attempt authority");
  }
  const effect = record.providerEffects.find(({ effectId }) => effectId === authority.effect.effectId);
  if (!effect) throw new Error("Expected provider effect ledger entry");
  const attemptWithoutKey = {
    ...authority.effect.result,
    attempt: authority.effect.result.attempt + 1,
    providerRequestRef: providerRef("forged-abandoned-fallback"),
  };
  const { outcome: _outcome, failureCode: _failureCode, ...providerAttempt } = attemptWithoutKey;
  const attempt = {
    ...providerAttempt,
    providerAttemptIdempotencyKey: providerAttemptIdempotencyKey(record.runId, effect, providerAttempt),
  };
  return {
    ...record,
    status: "cancelled",
    state: {
      phase: "idle",
      task: "",
      coderIterations: 0,
      consecutiveRejections: 0,
      judgeReports: [],
      yolo: false,
    },
    pendingProviderIntent: false,
    cancelledCheckpoint: structuredClone(record.state),
    abandonedProviderAttempt: { ...effect, attempt },
    providerAttempts: record.providerAttempts + 1,
    requestAuthority: {
      state: "settled",
      requestRef: authority.requestRef,
      requestHash: authority.requestHash,
      mutationEffect: { operation: "cancel" },
      providerEffectIds: [],
      outcome: "cancelled",
    },
  };
}

function mutatePendingEffectOrdinal(record: McpRunRecord): McpRunRecord {
  const authority = record.requestAuthority;
  if (authority.state !== "pending") throw new Error("Expected pending effect authority");
  return {
    ...record,
    requestAuthority: {
      ...authority,
      effect: { ...authority.effect, ordinal: authority.effect.ordinal + 1 },
    },
  };
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}
