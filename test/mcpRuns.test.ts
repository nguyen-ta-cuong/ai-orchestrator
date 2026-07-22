import { describe, expect, it } from "vitest";
import type { RoutedCompletionAttempt, RoutedCompletionRequest, RoutedCompletionResult } from "../mcp/llm.js";
import { createRoutedMcpRunProvider } from "../mcp/runProvider.js";
import { createMcpRunService, type McpRunCheckpointReference, type McpRunPlanRequest, type McpRunPreflightRequest, type McpRunProvider, type McpRunRecord, type McpRunRecordDraft, type McpRunRepository, type McpRunRequestRecord, type McpRunRequestUpdate, type McpRunStartTransaction, type McpRunTransaction, type ProviderEffect } from "../mcp/runService.js";
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
    expect(pendingBytes).not.toContain("plan-1");
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
  });

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
    expect(started.routing[0]?.fallbackHistory).toEqual([
      { identity: "raw/provider", failureCode: "provider_failed" },
    ]);
    const approved = await service.advance({
      requestId: "raw-provider-approve",
      runId: started.runId,
      expectedRevision: started.revision,
      event: { type: "plan_approved" },
    });
    const failed = await service.advance({
      requestId: "raw-provider-submit",
      runId: started.runId,
      expectedRevision: approved.revision,
      event: { type: "code_result_submitted", diff: "safe diff" },
    });
    expect(failed).toMatchObject({ status: "failed", currentNode: "failed" });

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
    const attempt = scriptedAttempt("plan", call);
    await input.beforeAttempt(attempt);
    const plan = this.nextPlan ?? `plan-${call}`;
    this.nextPlan = undefined;
    await input.afterAttempt({ ...attempt, outcome: "succeeded" });
    return { plan, routing: routing("plan", call) };
  }

  async judge(input: Parameters<McpRunProvider["judge"]>[0]): Promise<Awaited<ReturnType<McpRunProvider["judge"]>>> {
    this.judgeCalls.push(input);
    const call = this.judgeCalls.length;
    const attempt = scriptedAttempt("fast-judge", call);
    await input.beforeAttempt(attempt);
    if (this.nextJudgeError) {
      const error = this.nextJudgeError;
      this.nextJudgeError = undefined;
      await input.afterAttempt({ ...attempt, outcome: "failed", failureCode: "provider_failed" });
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
        identity,
        thinking: "high",
      };
      await input.beforeAttempt(attempt);
      this.networkAttempts.push(`${identity.provider}/${identity.model}`);
      if (index === 0) {
        await input.afterAttempt({ ...attempt, outcome: "failed", failureCode: "provider_failed" });
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
  return {
    decisionId: `${stage}-${call}`,
    stage,
    selectedIdentity: { provider: "test", model: `${stage}-model`, family: `${stage}-family` },
    thinking: "high" as const,
    policyVersion: "test-policy-v1",
    fallbackHistory: [],
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
      reserve: async (draft, update) => {
        if (this.runs.has(draft.runId) || this.startRequests.has(requestRef)) throw new Error("in-memory create conflict");
        return this.write(undefined, draft, update, true);
      },
      compareAndSwap: async (expectedRevision, draft, update) => this.write(expectedRevision, draft, update, true),
    });
  }

  async withRunLease<T>(targetRunId: string, work: (transaction: McpRunTransaction) => Promise<T>): Promise<T> {
    return work({
      get: async () => clone(this.runs.get(targetRunId)),
      getRequest: async (requestRef) => clone(this.runRequests.get(targetRunId)?.get(requestRef)),
      compareAndSwap: async (expectedRevision, draft, update) => this.write(expectedRevision, draft, update, false),
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

  private async write(expectedRevision: number | undefined, draft: McpRunRecordDraft, update: McpRunRequestUpdate, start: boolean): Promise<McpRunRecord | undefined> {
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
    const request: McpRunRequestRecord = update.state === "pending"
      ? { ...clone(update), runId: record.runId, reservedRevision: record.revision }
      : { ...clone(update), runId: record.runId, checkpoint: { runId: record.runId, revision: record.revision } };
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
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}
