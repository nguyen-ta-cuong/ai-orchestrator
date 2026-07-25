import { describe, expect, it, vi } from "vitest";
import { compileBuildPlan, type BuildPlan } from "../src/core/buildPlan.js";
import {
  BUILD_EFFECT_ORDINAL,
  buildEffectIdentity,
  createBuildWorkerBudgetIntent,
  type BuildRunningAction,
} from "../src/core/buildExecution.js";
import {
  DEFAULT_EXECUTION_LIMITS,
  applySchedulerEvent,
  createGraphExecutionState,
  type GraphEvent,
} from "../src/core/scheduler.js";
import {
  createBuildWorkerRequest,
  createRecoveryBuildWorkerRequest,
  dispatchBuildWorker,
  reconcileBuildWorker,
  runBoundedBuildWorkerTasks,
  type BuildWorkerAdapter,
} from "../src/runtime/buildWorker.js";

const now = "2026-07-22T00:00:00.000Z";
const budgetCheckpoint = {
  path: `mutations/${"a".repeat(64)}.json`,
  sha256: "b".repeat(64),
  sizeBytes: 1,
} as const;

function plan(): BuildPlan {
  return {
    schemaVersion: 1,
    id: "worker-plan",
    planVersion: 1,
    summary: "Inspect the repository under one outer BUILD budget.",
    entry: "inspect",
    exit: "inspect",
    nodes: [{
      id: "inspect",
      handler: "inspect",
      priority: 0,
      objective: "Inventory the repository.",
      instructions: ["Inspect the repository structure and relevant source files."],
      acceptanceCriteria: ["A bounded inventory artifact is produced."],
      verificationCommands: [],
      inputContracts: [],
      outputContracts: [{ id: "inventory", kind: "artifact", validation: "sha256" }],
      toolPolicy: "read-only",
      sideEffect: "read",
      workspace: "shared",
      idempotency: "read-replay-safe",
      resourceLocks: [],
      writeSet: [],
      retryLimit: 0,
      timeoutMs: 10,
    }],
    dependencies: [],
    joins: [],
  };
}

function isolatedPlan(): BuildPlan {
  return {
    schemaVersion: 1,
    id: "isolated-worker-plan",
    planVersion: 1,
    summary: "Implement in one isolated candidate and stop for explicit integration review.",
    entry: "implement",
    exit: "integrate",
    nodes: [{
      id: "implement",
      handler: "implement",
      priority: 1,
      objective: "Implement the isolated candidate.",
      instructions: ["Edit only src/a.ts."],
      acceptanceCriteria: ["The declared patch artifact is produced."],
      verificationCommands: [],
      inputContracts: [],
      outputContracts: [{ id: "patch", kind: "file-set", validation: "sha256" }],
      toolPolicy: "declared-writes",
      sideEffect: "write",
      workspace: "isolated-worktree",
      idempotency: "keyed",
      resourceLocks: [{ kind: "path", value: "src/a.ts", mode: "exclusive" }],
      writeSet: ["src/a.ts"],
      retryLimit: 1,
      timeoutMs: 1_000,
    }, {
      id: "validate",
      handler: "validate",
      priority: 0,
      objective: "Validate the isolated candidate.",
      instructions: ["Run the reviewed validator against the owned candidate."],
      acceptanceCriteria: ["The reviewed validator produces evidence."],
      verificationCommands: ["npm test"],
      inputContracts: ["patch"],
      outputContracts: [{ id: "validation", kind: "evidence", validation: "reviewed-command", validatorRef: "test-command" }],
      toolPolicy: "reviewed-validation",
      sideEffect: "read",
      workspace: "isolated-worktree",
      targetWorktreeNodeId: "implement",
      idempotency: "read-replay-safe",
      resourceLocks: [],
      writeSet: [],
      retryLimit: 0,
      timeoutMs: 1_000,
    }, {
      id: "integrate",
      handler: "integrate",
      priority: 0,
      objective: "Record the human integration decision.",
      instructions: ["Present the candidate for explicit review."],
      acceptanceCriteria: ["The decision is durably recorded."],
      verificationCommands: [],
      inputContracts: ["validation"],
      outputContracts: [{ id: "decision", kind: "evidence", validation: "human-review", validatorRef: "integration-gate" }],
      toolPolicy: "human-integration",
      sideEffect: "external",
      workspace: "shared",
      idempotency: "none",
      resourceLocks: [],
      writeSet: [],
      retryLimit: 0,
      timeoutMs: 1_000,
    }],
    dependencies: [
      { from: "implement", to: "validate", contracts: ["patch"] },
      { from: "validate", to: "integrate", contracts: ["validation"] },
    ],
    joins: [],
  };
}

function setup() {
  const compiled = compileBuildPlan(plan());
  let state = createGraphExecutionState(compiled.graph, {
    runId: "build-run-1",
    now,
    planVersion: 1,
    metadata: compiled.schedulerMetadata,
    limits: { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} },
  });
  const event: GraphEvent = {
    schemaVersion: 1,
    kind: "node-status",
    sequence: 1,
    eventId: "start-inspect",
    runId: state.runId,
    graphId: state.graphId,
    graphVersion: state.graphVersion,
    graphDigest: state.graphDigest,
    planVersion: state.planVersion,
    nodeId: "inspect",
    priorStatus: "ready",
    nextStatus: "running",
    attempt: 1,
    timestamp: now,
    artifactRefs: [],
  };
  state = applySchedulerEvent(compiled.graph, state, event, compiled.schedulerMetadata);
  const identity = buildEffectIdentity({
    runId: state.runId,
    planVersion: state.planVersion,
    planHash: compiled.hash,
    nodeId: "inspect",
    visit: 1,
    attempt: 1,
    purpose: "worker",
    ordinal: BUILD_EFFECT_ORDINAL.worker,
    workspace: { kind: "shared" },
  });
  const action: BuildRunningAction = { ...identity, kind: "invoke-worker" };
  const budget = createBuildWorkerBudgetIntent(compiled, state, action, {
    now,
    unattended: false,
    eventId: "budget-inspect",
    estimatedCostUsd: 0.01,
    observedCostUsd: 0,
    inputTokens: 100,
    outputTokens: 100,
    checkpointRef: budgetCheckpoint,
    routingDecisionId: "build-route-1",
  });
  state = applySchedulerEvent(compiled.graph, state, budget.event, compiled.schedulerMetadata);
  return { compiled, state, action, reservation: budget.reservation };
}

function adapter(): BuildWorkerAdapter & { invoke: ReturnType<typeof vi.fn>; reconcile: ReturnType<typeof vi.fn> } {
  const receipt = (requestRef: string) => ({
    schemaVersion: 1,
    requestRef,
    outcome: "succeeded" as const,
    worker: { provider: "local", model: "maker", family: "maker-family" },
    claimedOutputPaths: ["nodes/1/inspect/attempt-1/inventory.json"],
    outputPayloads: [{ contractId: "inventory", content: "Repository inventory." }],
    summary: "Inspected repository.",
    usage: { inputTokens: 10, outputTokens: 5, observedUsd: "unknown" as const },
    completedAt: now,
  });
  return {
    invoke: vi.fn(async (request) => receipt(request.requestRef)),
    reconcile: vi.fn(async (request) => receipt(request.requestRef)),
  };
}

describe("BUILD worker runtime boundary", () => {
  it("derives a deterministic request with read-only tools under the one outer BUILD budget", () => {
    const { compiled, state, action, reservation } = setup();
    const request = createBuildWorkerRequest(compiled, state, action, {
      reservation,
    });
    expect(request).toMatchObject({
      effectRequestRef: action.requestRef,
      planHash: compiled.hash,
      nodeId: "inspect",
      handler: "inspect",
      toolPolicy: "read-only",
      activeTools: ["read", "grep", "find", "ls"],
      outerBuildBudgetRef: reservation.reservationRef,
      workspace: { kind: "shared" },
    });
    expect(request.prompt).toContain("untrusted data");
    expect(request.prompt).toContain("Inventory the repository.");
    expect(request.prompt).toContain("A bounded inventory artifact is produced.");
    expect(request.requestRef).not.toBe(action.requestRef);
    expect(createBuildWorkerRequest(compiled, state, action, { reservation })).toEqual(request);
    expect(() => createBuildWorkerRequest(compiled, state, action, {
      reservation: { ...reservation, reservationRef: "b".repeat(64) },
    })).toThrow(/budget reservation/i);
  });

  it("requires a matching durable intent before invoking and validates the exact receipt", async () => {
    const { compiled, state, action, reservation } = setup();
    const request = createBuildWorkerRequest(compiled, state, action, { reservation });
    const worker = adapter();
    const intent = {
      ...action,
      schemaVersion: 1 as const,
      status: "intent-recorded" as const,
      recordedAt: now,
    };
    const { kind: _kind, ...checkpoint } = intent;
    const receipt = await dispatchBuildWorker(request, checkpoint, worker);
    expect(receipt).toMatchObject({ outcome: "succeeded", requestRef: request.requestRef });
    expect(worker.invoke).toHaveBeenCalledTimes(1);

    await expect(dispatchBuildWorker(request, { ...checkpoint, status: "succeeded", resultRef: "c".repeat(64) }, worker))
      .rejects.toThrow(/intent/i);
    worker.invoke.mockResolvedValueOnce({ ...receipt, requestRef: "d".repeat(64) });
    await expect(dispatchBuildWorker(request, checkpoint, worker)).rejects.toThrow(/request/i);
    worker.invoke.mockResolvedValueOnce({ ...receipt, outputPayloads: [] });
    await expect(dispatchBuildWorker(request, checkpoint, worker)).rejects.toThrow(/payloads/i);
  });

  it("uses reconcile without invoking again after uncertainty", async () => {
    const { compiled, state, action, reservation } = setup();
    const request = createBuildWorkerRequest(compiled, state, action, { reservation });
    const worker = adapter();
    expect(await reconcileBuildWorker(request, worker)).toMatchObject({ outcome: "succeeded" });
    expect(worker.reconcile).toHaveBeenCalledTimes(1);
    expect(worker.invoke).not.toHaveBeenCalled();
    worker.reconcile.mockResolvedValueOnce(undefined);
    expect(await reconcileBuildWorker(request, worker)).toBeUndefined();
  });

  it("aborts a timed-out worker and bounds concurrent worker tasks", async () => {
    const { compiled, state, action, reservation } = setup();
    const request = createBuildWorkerRequest(compiled, state, action, { reservation });
    const intent = {
      ...action,
      schemaVersion: 1 as const,
      status: "intent-recorded" as const,
      recordedAt: now,
    };
    const { kind: _kind, ...checkpoint } = intent;
    let observedAbort = false;
    const never: BuildWorkerAdapter = {
      invoke: async (_request, options) => new Promise((_resolve) => {
        options.signal.addEventListener("abort", () => { observedAbort = true; }, { once: true });
      }),
      reconcile: async () => undefined,
    };
    await expect(dispatchBuildWorker(request, checkpoint, never)).rejects.toThrow(/timed out/i);
    expect(observedAbort).toBe(true);

    let active = 0;
    let peak = 0;
    const results = await runBoundedBuildWorkerTasks([0, 1, 2, 3, 4].map((value) => async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return value;
    }), 2);
    expect(results).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  it("derives the isolated worker path only from the owned-worktree authority", () => {
    const compiled = compileBuildPlan(isolatedPlan());
    let state = createGraphExecutionState(compiled.graph, {
      runId: "isolated-run",
      now,
      planVersion: 1,
      metadata: compiled.schedulerMetadata,
      limits: { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} },
    });
    state = applySchedulerEvent(compiled.graph, state, {
      schemaVersion: 1,
      kind: "node-status",
      sequence: 1,
      eventId: "start-implement",
      runId: state.runId,
      graphId: state.graphId,
      graphVersion: state.graphVersion,
      graphDigest: state.graphDigest,
      planVersion: state.planVersion,
      nodeId: "implement",
      priorStatus: "ready",
      nextStatus: "running",
      attempt: 1,
      timestamp: now,
      artifactRefs: [],
    }, compiled.schedulerMetadata);
    const workspace = {
      kind: "owned-worktree" as const,
      intentId: "a".repeat(64),
      runId: state.runId,
      planVersion: state.planVersion,
      planHash: compiled.hash,
      ownerNodeId: "implement",
      baseSha: "b".repeat(40),
      worktreePath: "/tmp/isolated-run-v1-implement",
      ownershipReceiptHash: "c".repeat(64),
    };
    const identity = buildEffectIdentity({
      runId: state.runId,
      planVersion: state.planVersion,
      planHash: compiled.hash,
      nodeId: "implement",
      visit: 1,
      attempt: 1,
      purpose: "worker",
      ordinal: BUILD_EFFECT_ORDINAL.worker,
      workspace,
    });
    const action: BuildRunningAction = { ...identity, kind: "invoke-worker" };
    const budget = createBuildWorkerBudgetIntent(compiled, state, action, {
      now,
      unattended: false,
      eventId: "budget-implement",
      estimatedCostUsd: 0.02,
      observedCostUsd: 0,
      inputTokens: 200,
      outputTokens: 200,
      checkpointRef: budgetCheckpoint,
      routingDecisionId: "build-route-1",
    });
    state = applySchedulerEvent(compiled.graph, state, budget.event, compiled.schedulerMetadata);
    const request = createBuildWorkerRequest(compiled, state, { ...identity, kind: "invoke-worker" }, {
      reservation: budget.reservation,
    });
    expect(request.workspace).toEqual(workspace);
    expect(() => createBuildWorkerRequest(compiled, state, { ...identity, kind: "invoke-worker" }, {
      reservation: budget.reservation,
      worktreePath: "/tmp/forged",
    } as never)).toThrow(/unsupported|worktree path/i);
  });

  it("creates a topology-preserving repair worker from only the typed directive", () => {
    const failureFingerprint = "d".repeat(64);
    const directive = {
      version: 1 as const,
      failureFingerprint,
      rootCauseCategory: "implementation-defect" as const,
      confidence: "high" as const,
      diagnosisRef: `plan-versions/1/diagnosis/${failureFingerprint}.md`,
      diagnosisHash: "e".repeat(64),
      evidenceRefs: ["nodes/1/verifying/rejection.json"],
      repairScope: ["src/example.ts"],
      validationRequirements: ["verification-commands"],
      topologyAssessment: "preserve" as const,
    };
    const request = createRecoveryBuildWorkerRequest({
      runId: "recovery-run",
      planVersion: 1,
      planHash: "a".repeat(64),
      directive,
      outerEffectRequestRef: "b".repeat(64),
      timeoutMs: 30_000,
    });

    expect(request).toMatchObject({
      handler: "implement",
      toolPolicy: "declared-writes",
      declaredWriteSet: ["src/example.ts"],
      workspace: { kind: "shared" },
      declaredOutputContracts: [],
    });
    expect(request.prompt).toContain(directive.diagnosisRef);
    expect(request.prompt).not.toContain("Local defect prose that was never declared");
    expect(() => createRecoveryBuildWorkerRequest({
      runId: "recovery-run",
      planVersion: 1,
      planHash: "a".repeat(64),
      directive: { ...directive, rootCauseCategory: "missing-dependency", topologyAssessment: "structural" },
      outerEffectRequestRef: "b".repeat(64),
      timeoutMs: 30_000,
    })).toThrow(/topology-preserving/i);
  });
});
