import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compileGraph, type GraphDefinition, type SideEffectClass } from "../src/core/graph.js";
import {
  DEFAULT_EXECUTION_LIMITS,
  applySchedulerEvent,
  assertScheduleValid,
  computeReadySet,
  createGraphExecutionState,
  evaluateExecutionGuard,
  graphEventDigest,
  migrateLegacyNodePlanVersions,
  type ExecutionLimits,
  type GraphEvent,
  type SchedulerMetadata,
} from "../src/core/scheduler.js";

const now = "2026-07-22T00:00:00.000Z";

function dag(startSideEffect: SideEffectClass = "none") {
  return compileGraph({
    schemaVersion: 1,
    id: "scheduler-dag",
    version: "1",
    kind: "dag",
    entry: "start",
    nodes: [
      node("start", false, startSideEffect),
      node("alpha"),
      node("beta"),
      node("join"),
      node("done", true),
    ],
    edges: [
      { from: "start", to: "alpha", event: "fan-alpha" },
      { from: "start", to: "beta", event: "fan-beta" },
      { from: "alpha", to: "join", event: "complete" },
      { from: "beta", to: "join", event: "complete" },
      { from: "join", to: "done", event: "complete" },
    ],
  } satisfies GraphDefinition);
}

function stateMachine() {
  return compileGraph({
    schemaVersion: 1,
    id: "scheduler-machine",
    version: "1",
    kind: "state-machine",
    entry: "work",
    nodes: [node("work"), node("check"), node("idle"), node("done", true), node("failed", true)],
    edges: [
      { from: "work", to: "check", event: "built", boundedBy: "loop-budget" },
      { from: "work", to: "idle", event: "cancelled", boundedBy: "loop-budget" },
      { from: "check", to: "work", event: "retry", boundedBy: "loop-budget" },
      { from: "check", to: "idle", event: "cancelled", boundedBy: "loop-budget" },
      { from: "check", to: "done", event: "approved", boundedBy: "loop-budget" },
      { from: "check", to: "failed", event: "provider_failed", boundedBy: "loop-budget" },
      { from: "idle", to: "work", event: "start", boundedBy: "loop-budget" },
    ],
  } satisfies GraphDefinition);
}

function node(id: string, terminal = false, sideEffect: SideEffectClass = "none") {
  return {
    id,
    handler: `${id}-handler`,
    ...(terminal ? { terminal: true } : {}),
    inputContracts: [],
    outputContracts: terminal ? [] : [`${id}-output`],
    sideEffect,
    timeoutMs: 1_000,
    retryBudget: 1,
  };
}

function event(
  state: ReturnType<typeof createGraphExecutionState>,
  nodeId: string,
  priorStatus: GraphEvent["priorStatus"],
  nextStatus: GraphEvent["nextStatus"],
  patch: Partial<GraphEvent> = {},
): GraphEvent {
  const contracts = (nextStatus === "executed" || nextStatus === "blocked")
    ? [`${nodeId}-output`]
    : [];
  return {
    schemaVersion: 1,
    kind: "node-status",
    sequence: state.lastAppliedEventSequence + 1,
    eventId: `event-${state.lastAppliedEventSequence + 1}`,
    runId: "opaque-run-id",
    graphId: state.graphId,
    graphVersion: state.graphVersion,
    graphDigest: state.graphDigest,
    planVersion: state.planVersion,
    nodeId,
    priorStatus,
    nextStatus,
    attempt: nextStatus === "running" && priorStatus !== "running"
      ? state.nodeStates[nodeId]!.attempts + 1
      : state.nodeStates[nodeId]!.attempts,
    timestamp: now,
    artifactRefs: contracts.map((contract) => ({
      planVersion: state.planVersion,
      nodeId,
      contract,
      path: `nodes/${state.planVersion}/${nodeId}/${contract}.json`,
      sha256: "a".repeat(64),
      sizeBytes: 12,
    })),
    ...((contracts.length > 0)
      ? { validatorResult: { status: "passed" as const, contracts } }
      : {}),
    ...patch,
  };
}

function requestRef(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest("hex");
}

function mutationCheckpoint(seed: string) {
  const digest = requestRef(`checkpoint:${seed}`);
  return { path: `mutations/${digest}.json`, sha256: digest, sizeBytes: seed.length + 1 };
}

describe("durable graph scheduler", () => {
  it("computes deterministic priority then node-id ready sets and all_of joins", () => {
    const graph = dag();
    const metadata: SchedulerMetadata = { priorities: { beta: 10, alpha: 5 } };
    let state = createGraphExecutionState(graph, {
      runId: "opaque-run-id",
      now,
      limits: { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} },
      metadata,
    });
    expect(state.ready).toEqual(["start"]);

    state = applySchedulerEvent(graph, state, event(state, "start", "ready", "running"), metadata);
    state = applySchedulerEvent(graph, state, event(state, "start", "running", "executed"), metadata);
    expect(computeReadySet(graph, state, metadata)).toEqual(["beta", "alpha"]);

    state = applySchedulerEvent(graph, state, event(state, "beta", "ready", "running"), metadata);
    state = applySchedulerEvent(graph, state, event(state, "beta", "running", "executed"), metadata);
    expect(state.ready).toEqual(["alpha"]);
    expect(state.nodeStates.join!.status).toBe("pending");

    state = applySchedulerEvent(graph, state, event(state, "alpha", "ready", "running"), metadata);
    state = applySchedulerEvent(graph, state, event(state, "alpha", "running", "executed"), metadata);
    expect(state.ready).toEqual(["join"]);
  });

  it("auto-completes terminal targets without scheduling a terminal handler", () => {
    const graph = dag();
    let state = createGraphExecutionState(graph, {
      runId: "opaque-run-id", now, limits: { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} },
    });
    for (const nodeId of ["start", "alpha", "beta", "join"] as const) {
      state = applySchedulerEvent(graph, state, event(state, nodeId, "ready", "running"));
      state = applySchedulerEvent(graph, state, event(state, nodeId, "running", "executed"));
    }
    expect(state.nodeStates.done).toMatchObject({ status: "executed", attempts: 0, visits: 1 });
    expect(state.ready).toEqual([]);
  });

  it("enforces strict transitions, absorbing terminal statuses, and plan-scoped outputs", () => {
    const graph = dag();
    let state = createGraphExecutionState(graph, {
      runId: "opaque-run-id", now, limits: { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} },
    });
    expect(() => applySchedulerEvent(graph, state, event(state, "start", "pending", "running"))).toThrow(/prior status/);
    state = applySchedulerEvent(graph, state, event(state, "start", "ready", "running"));
    state = applySchedulerEvent(graph, state, event(state, "start", "running", "executed", {
      validatorResult: { status: "passed", contracts: ["start-output"] },
      artifactRefs: [{
        planVersion: 1, nodeId: "start", contract: "start-output", path: "nodes/1/start/result.json",
        sha256: "a".repeat(64), sizeBytes: 12,
      }],
    }));
    expect(() => applySchedulerEvent(graph, state, event(state, "start", "executed", "ready"))).toThrow(/absorbing/);
    state = applySchedulerEvent(graph, state, event(state, "alpha", "ready", "running"));
    const invalidRefs = [
      [{ planVersion: 2, nodeId: "alpha", contract: "alpha-output", path: "nodes/2/alpha/result.json" }, /plan version/],
      [{ planVersion: 1, nodeId: "beta", contract: "beta-output", path: "nodes/1/beta/result.json" }, /node/],
      [{ planVersion: 1, nodeId: "alpha", contract: "undeclared", path: "nodes/1/alpha/result.json" }, /contract/],
      [{ planVersion: 1, nodeId: "alpha", contract: "alpha-output", path: "../outside" }, /relative path/],
    ] as const;
    for (const [reference, expected] of invalidRefs) {
      expect(() => applySchedulerEvent(graph, state, {
        ...event(state, "alpha", "running", "executed"),
        artifactRefs: [{ ...reference, sha256: "b".repeat(64), sizeBytes: 1 }],
      })).toThrow(expected);
    }
  });

  it("requires exact validated completion artifacts and rejects completion fields on start", () => {
    const graph = dag();
    let state = createGraphExecutionState(graph, {
      runId: "opaque-run-id", now, limits: { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} },
    });
    const forgedStart = event(state, "start", "ready", "running", {
      artifactRefs: [{
        planVersion: 1, nodeId: "start", contract: "start-output", path: "nodes/1/start/start-output.json",
        sha256: "a".repeat(64), sizeBytes: 1,
      }],
    });
    expect(() => applySchedulerEvent(graph, state, forgedStart)).toThrow(/completion fields/);
    state = applySchedulerEvent(graph, state, event(state, "start", "ready", "running"));

    const complete = event(state, "start", "running", "executed");
    expect(() => applySchedulerEvent(graph, state, { ...complete, validatorResult: undefined })).toThrow(/validation/);
    expect(() => applySchedulerEvent(graph, state, { ...complete, artifactRefs: [] })).toThrow(/artifact contracts/);
    expect(() => applySchedulerEvent(graph, state, {
      ...complete,
      artifactRefs: [...complete.artifactRefs, complete.artifactRefs[0]!],
    })).toThrow(/duplicate artifact contract/);
    expect(() => applySchedulerEvent(graph, state, {
      ...complete,
      validatorResult: { status: "passed", contracts: ["start-output", "extra"] },
    })).toThrow(/validated contracts/);
    expect(() => applySchedulerEvent(graph, state, {
      ...complete,
      artifactRefs: [{ ...complete.artifactRefs[0]!, path: "nodes/1/other/result.json" }],
    })).toThrow(/artifact directory/);
    expect(() => applySchedulerEvent(graph, state, {
      ...complete,
      artifactRefs: [{ ...complete.artifactRefs[0]!, sha256: "bad" }],
    })).toThrow(/SHA-256/);
  });

  it("consumes boundedBy on business and cancellation edges and activates the exact cancellation target", () => {
    const graph = stateMachine();
    const limits = { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: { "loop-budget": 2 } };
    let state = createGraphExecutionState(graph, { runId: "opaque-run-id", now, limits });
    state = applySchedulerEvent(graph, state, event(state, "work", "ready", "running"));
    state = applySchedulerEvent(graph, state, event(state, "work", "running", "blocked", {
      chosenEdge: { from: "work", to: "check", event: "built", boundedBy: "loop-budget" },
    }));
    expect(state.ready).toEqual(["check"]);
    expect(state.guard.backEdgeRemaining["loop-budget"]).toBe(1);

    state = applySchedulerEvent(graph, state, event(state, "check", "ready", "running"));
    state = applySchedulerEvent(graph, state, event(state, "check", "running", "blocked", {
      chosenEdge: { from: "check", to: "work", event: "retry", boundedBy: "loop-budget" },
    }));
    expect(state.ready).toEqual(["work"]);
    expect(state.guard.backEdgeRemaining["loop-budget"]).toBe(0);

    state = applySchedulerEvent(graph, state, event(state, "work", "ready", "running"));
    expect(() => applySchedulerEvent(graph, state, event(state, "work", "running", "blocked", {
      chosenEdge: { from: "work", to: "check", event: "built", boundedBy: "loop-budget" },
    }))).toThrow(/loop-budget.*exhausted/);

    const fresh = createGraphExecutionState(graph, { runId: "opaque-run-id", now, limits });
    const wrongCancelEdge = event(fresh, "work", "ready", "cancelled", {
      chosenEdge: { from: "work", to: "check", event: "built", boundedBy: "loop-budget" },
    });
    expect(() => applySchedulerEvent(graph, fresh, wrongCancelEdge)).toThrow(/cancellation edge/i);
    expect(() => applySchedulerEvent(graph, fresh, event(fresh, "work", "ready", "cancelled"))).toThrow(/requires one chosen edge/);
    const cancelled = applySchedulerEvent(graph, fresh, event(fresh, "work", "ready", "cancelled", {
      chosenEdge: { from: "work", to: "idle", event: "cancelled", boundedBy: "loop-budget" },
    }));
    expect(cancelled.ready).toEqual([]);
    expect(cancelled.nodeStates.idle!.status).toBe("pending");
    expect(cancelled.guard.backEdgeRemaining["loop-budget"]).toBe(1);
  });

  it("rejects missing and forged state-machine edges before consuming a budget", () => {
    const graph = stateMachine();
    const limits = { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: { "loop-budget": 2 } };
    let state = createGraphExecutionState(graph, { runId: "opaque-run-id", now, limits });
    state = applySchedulerEvent(graph, state, event(state, "work", "ready", "running"));
    expect(() => applySchedulerEvent(graph, state, {
      ...event(state, "work", "running", "blocked"),
      chosenEdge: undefined,
    })).toThrow(/requires one chosen edge/);
    const valid = { from: "work", to: "check", event: "built", boundedBy: "loop-budget" };
    for (const forged of [
      { ...valid, from: "check" },
      { ...valid, to: "done" },
      { ...valid, event: "approved" },
      { ...valid, guard: "forged" },
      { ...valid, boundedBy: "other" },
    ]) {
      expect(() => applySchedulerEvent(graph, state, event(state, "work", "running", "blocked", {
        chosenEdge: forged,
      }))).toThrow(/chosen graph edge|matched 0/i);
      expect(state.guard.backEdgeRemaining["loop-budget"]).toBe(2);
    }
  });

  it("is idempotent for the last exact event and rejects conflicting or out-of-order events", () => {
    const graph = dag();
    const initial = createGraphExecutionState(graph, {
      runId: "opaque-run-id", now, limits: { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} },
    });
    const started = event(initial, "start", "ready", "running");
    const next = applySchedulerEvent(graph, initial, started);
    expect(next.revision).toBe(initial.revision + 1);
    expect(next.lastAppliedEventHash).toMatch(/^[a-f0-9]{64}$/);
    expect(applySchedulerEvent(graph, next, started)).toEqual(next);
    expect(applySchedulerEvent(graph, next, { ...started, chosenEdge: undefined })).toEqual(next);
    expect(() => applySchedulerEvent(graph, next, { ...started, eventId: "conflict" })).toThrow(/duplicate sequence/);
    expect(() => applySchedulerEvent(graph, initial, { ...started, sequence: 2 })).toThrow(/out of order/);
  });

  it("rejects inherited and accessor-backed graph event fields", () => {
    const graph = dag();
    const state = createGraphExecutionState(graph, {
      runId: "opaque-run-id", now, limits: { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} },
    });
    const inherited = event(state, "start", "ready", "running") as GraphEvent & Record<string, unknown>;
    delete inherited.schemaVersion;
    Object.defineProperty(Object.prototype, "schemaVersion", { value: 1, configurable: true });
    try {
      expect(() => applySchedulerEvent(graph, state, inherited as GraphEvent)).toThrow(/cannot inherit fields/);
    } finally {
      delete (Object.prototype as Record<string, unknown>).schemaVersion;
    }

    const accessor = event(state, "start", "ready", "running");
    Object.defineProperty(accessor, "eventId", { enumerable: true, get: () => "accessor-event" });
    expect(() => applySchedulerEvent(graph, state, accessor)).toThrow(/accessor fields/);

    const hidden = event(state, "start", "ready", "running");
    Object.defineProperty(hidden, "eventId", { value: "hidden-event", enumerable: false });
    expect(() => graphEventDigest(hidden)).toThrow(/non-enumerable fields/);
  });

  it("accounts visits, retries, reservations, usage, side effects, and no-progress events", () => {
    const graph = dag("read");
    let state = createGraphExecutionState(graph, {
      runId: "opaque-run-id", now, limits: { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} },
    });
    expect(state.nodeStates.start).toMatchObject({ visits: 1, attempts: 0, retryAttempts: 0 });
    const beforeStart = structuredClone(state);
    state = applySchedulerEvent(graph, state, event(state, "start", "ready", "running"));
    expect(beforeStart.nodeStates.start!.status).toBe("ready");
    expect(state).toMatchObject({ revision: 1, lastAppliedEventSequence: 1 });
    expect(state.nodeStates.start).toMatchObject({ visits: 1, attempts: 1, retryAttempts: 0, status: "running" });
    expect(state.guard).toMatchObject({ steps: 1, runningNodes: ["start"] });

    const key = "model-request-1";
    const checkpointRef = mutationCheckpoint(key);
    const intent = event(state, "start", "running", "running", {
      kind: "side-effect-intent",
      requestRef: requestRef(key),
      checkpointRef,
      routingDecisionId: "route-model-1",
      sideEffect: { phase: "intent", ordinal: 1, idempotencyKey: key, class: "model" },
      reservation: { modelCalls: 1, providerCalls: 1 },
    });
    state = applySchedulerEvent(graph, state, intent);
    expect(state.nodeStates.start!.sideEffect).toMatchObject({
      status: "intent_recorded", attempt: 1, idempotencyKey: key, class: "model",
    });
    expect(state.guard).toMatchObject({ modelCallsInFlight: 1, providerCallsInFlight: 1, sideEffectAttempts: 1 });
    expect(() => applySchedulerEvent(graph, state, {
      ...intent,
      sequence: state.lastAppliedEventSequence + 1,
      eventId: "duplicate-intent",
    })).toThrow(/unresolved side effect/);

    const resultRef = event(state, "start", "running", "executed").artifactRefs[0]!;
    state = applySchedulerEvent(graph, state, event(state, "start", "running", "running", {
      kind: "side-effect-result",
      requestRef: requestRef(key),
      checkpointRef,
      routingDecisionId: "route-model-1",
      sideEffect: { phase: "result", ordinal: 1, idempotencyKey: key, class: "model", outcome: "succeeded", resultRef },
      reservation: { modelCalls: -1, providerCalls: -1 },
      usage: { estimatedCostUsd: 0.2, observedCostUsd: 0.1, inputTokens: 20, outputTokens: 5 },
    }));
    expect(state.nodeStates.start!.sideEffect).toMatchObject({ status: "succeeded", outcome: "succeeded", resultRef });
    expect(state.guard).toMatchObject({
      modelCallsInFlight: 0, providerCallsInFlight: 0, estimatedCostUsd: 0.2, observedCostUsd: 0.1,
      inputTokens: 20, outputTokens: 5,
    });

    const fingerprint = "1".repeat(16);
    state = applySchedulerEvent(graph, state, event(state, "start", "running", "running", {
      kind: "progress", progressFingerprint: fingerprint,
    }));
    state = applySchedulerEvent(graph, state, event(state, "start", "running", "running", {
      kind: "progress", progressFingerprint: fingerprint,
    }));
    expect(state.guard).toMatchObject({ noProgressFingerprint: fingerprint, noProgressRepeats: 2 });
  });

  it("sequences effects, binds results to request bytes, and never reuses a succeeded key", () => {
    const graph = dag("read");
    let state = createGraphExecutionState(graph, {
      runId: "opaque-run-id", now, limits: { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} },
    });
    state = applySchedulerEvent(graph, state, event(state, "start", "ready", "running"));
    const evidence = (contract: string) => ({
      planVersion: 1,
      nodeId: "start",
      contract,
      path: `nodes/1/start/${contract}.json`,
      sha256: "b".repeat(64),
      sizeBytes: 3,
    });
    const request = (label: string) => createHash("sha256").update(JSON.stringify({ prompt: label })).digest("hex");
    const settle = (key: string, ordinal: number, requestRef: string, contract: string) => {
      state = applySchedulerEvent(graph, state, event(state, "start", "running", "running", {
        kind: "side-effect-intent",
        requestRef,
        sideEffect: { phase: "intent", ordinal, idempotencyKey: key, class: "tool" },
      }));
      state = applySchedulerEvent(graph, state, event(state, "start", "running", "running", {
        kind: "side-effect-result",
        requestRef,
        sideEffect: {
          phase: "result", ordinal, idempotencyKey: key, class: "tool", outcome: "succeeded", resultRef: evidence(contract),
        },
      }));
    };

    settle("key-k", 1, request("request-k"), "tool-result-k");
    settle("key-l", 2, request("request-l"), "tool-result-l");
    expect(state.nodeStates.start).toMatchObject({
      sideEffectOrdinal: 2,
      succeededSideEffectKeys: ["key-k", "key-l"],
    });
    expect(() => applySchedulerEvent(graph, state, event(state, "start", "running", "running", {
      kind: "side-effect-intent",
      requestRef: request("different-request-k"),
      sideEffect: { phase: "intent", ordinal: 3, idempotencyKey: "key-k", class: "tool" },
    }))).toThrow(/repeat a succeeded idempotency key/);

    state = applySchedulerEvent(graph, state, event(state, "start", "running", "running", {
      kind: "side-effect-intent",
      requestRef: request("request-m"),
      sideEffect: { phase: "intent", ordinal: 3, idempotencyKey: "key-m", class: "tool" },
    }));
    expect(() => applySchedulerEvent(graph, state, event(state, "start", "running", "running", {
      kind: "side-effect-result",
      requestRef: request("changed-request-m"),
      sideEffect: {
        phase: "result", ordinal: 3, idempotencyKey: "key-m", class: "tool", outcome: "succeeded", resultRef: evidence("mismatch"),
      },
    }))).toThrow(/does not match the persisted intent/);
  });

  it("blocks unknown effects until an explicit immutable reconciliation settles them", () => {
    const graph = dag("read");
    let state = createGraphExecutionState(graph, {
      runId: "opaque-run-id", now, limits: { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} },
    });
    state = applySchedulerEvent(graph, state, event(state, "start", "ready", "running"));
    const digest = requestRef("actual-request-bytes");
    const checkpointRef = {
      path: `mutations/${"d".repeat(64)}.json`,
      sha256: "d".repeat(64),
      sizeBytes: 27,
    };
    state = applySchedulerEvent(graph, state, event(state, "start", "running", "running", {
      kind: "side-effect-intent",
      requestRef: digest,
      checkpointRef,
      sideEffect: { phase: "intent", ordinal: 1, idempotencyKey: "unknown-key", class: "tool" },
    }));
    expect(() => applySchedulerEvent(graph, state, event(state, "start", "running", "running", {
      kind: "side-effect-result",
      requestRef: digest,
      sideEffect: { phase: "result", ordinal: 1, idempotencyKey: "unknown-key", class: "tool", outcome: "unknown" },
    }))).toThrow(/does not match the persisted intent/);
    state = applySchedulerEvent(graph, state, event(state, "start", "running", "running", {
      kind: "side-effect-result",
      requestRef: digest,
      checkpointRef,
      sideEffect: { phase: "result", ordinal: 1, idempotencyKey: "unknown-key", class: "tool", outcome: "unknown" },
    }));
    expect(() => applySchedulerEvent(graph, state, event(state, "start", "running", "executed"))).toThrow(/succeeded side-effect result/);
    expect(() => applySchedulerEvent(graph, state, event(state, "start", "running", "failed_retryable", {
      errorCategory: "ambiguous",
    }))).toThrow(/unknown.*side effect/);
    expect(() => applySchedulerEvent(graph, state, event(state, "start", "running", "running", {
      kind: "side-effect-intent",
      requestRef: requestRef("next-request"),
      sideEffect: { phase: "intent", ordinal: 2, idempotencyKey: "next-key", class: "tool" },
    }))).toThrow(/requiring reconciliation/);
    expect(() => applySchedulerEvent(graph, state, event(state, "start", "running", "running", {
      kind: "side-effect-result",
      requestRef: digest,
      checkpointRef: { ...checkpointRef, sha256: "e".repeat(64) },
      sideEffect: {
        phase: "result", ordinal: 1, idempotencyKey: "unknown-key", class: "tool", outcome: "succeeded", reconciliation: true,
        resultRef: {
          planVersion: 1, nodeId: "start", contract: "wrong-checkpoint",
          path: "nodes/1/start/wrong-checkpoint.json", sha256: "e".repeat(64), sizeBytes: 4,
        },
      },
    }))).toThrow(/does not match the persisted intent/);

    const resultRef = {
      planVersion: 1, nodeId: "start", contract: "reconciliation-evidence",
      path: "nodes/1/start/reconciliation.json", sha256: "c".repeat(64), sizeBytes: 4,
    };
    state = applySchedulerEvent(graph, state, event(state, "start", "running", "running", {
      kind: "side-effect-result",
      requestRef: digest,
      checkpointRef,
      sideEffect: {
        phase: "result", ordinal: 1, idempotencyKey: "unknown-key", class: "tool",
        outcome: "succeeded", reconciliation: true, resultRef,
      },
    }));
    expect(state.nodeStates.start!.sideEffect).toMatchObject({ status: "succeeded", reconciled: true, resultRef });
  });

  it("mechanically couples model reservations and usage while forbidding them on non-model effects", () => {
    const graph = dag("read");
    let state = createGraphExecutionState(graph, {
      runId: "opaque-run-id", now, limits: { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} },
    });
    state = applySchedulerEvent(graph, state, event(state, "start", "ready", "running"));
    const digest = requestRef("model-request-bytes");
    const checkpointRef = mutationCheckpoint("model-request-bytes");
    const modelIntent = event(state, "start", "running", "running", {
      kind: "side-effect-intent",
      requestRef: digest,
      checkpointRef,
      routingDecisionId: "route-model-2",
      sideEffect: { phase: "intent", ordinal: 1, idempotencyKey: "model-key", class: "model" },
    });
    expect(() => applySchedulerEvent(graph, state, modelIntent)).toThrow(/exact model\/provider reservations/);
    expect(() => applySchedulerEvent(graph, state, {
      ...modelIntent,
      routingDecisionId: undefined,
      sideEffect: { phase: "intent", ordinal: 1, idempotencyKey: "tool-key", class: "tool" },
      reservation: { modelCalls: 1, providerCalls: 1 },
    })).toThrow(/Non-model.*cannot reserve/);

    state = applySchedulerEvent(graph, state, {
      ...modelIntent,
      reservation: { modelCalls: 1, providerCalls: 1 },
    });
    const resultRef = {
      planVersion: 1, nodeId: "start", contract: "provider-result",
      path: "nodes/1/start/provider.json", sha256: "d".repeat(64), sizeBytes: 5,
    };
    const result = event(state, "start", "running", "running", {
      kind: "side-effect-result",
      requestRef: digest,
      checkpointRef,
      routingDecisionId: "route-model-2",
      sideEffect: {
        phase: "result", ordinal: 1, idempotencyKey: "model-key", class: "model", outcome: "succeeded", resultRef,
      },
      reservation: { modelCalls: -1, providerCalls: -1 },
    });
    expect(() => applySchedulerEvent(graph, state, result)).toThrow(/explicit cost and token usage/);
    expect(() => applySchedulerEvent(graph, state, {
      ...result,
      usage: { estimatedCostUsd: 0, observedCostUsd: 0, inputTokens: 1, outputTokens: 1 },
      reservation: { modelCalls: 0, providerCalls: -1 },
    })).toThrow(/exact model\/provider reservation release/);
    expect(() => applySchedulerEvent(graph, state, {
      ...result,
      routingDecisionId: "route-substitution",
      usage: { estimatedCostUsd: 0, observedCostUsd: 0, inputTokens: 1, outputTokens: 1 },
    })).toThrow(/does not match the persisted intent/);
  });

  it("rejects backdated events and guard probes relative to the last durable event", () => {
    const graph = dag();
    const limits = { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} };
    let state = createGraphExecutionState(graph, { runId: "opaque-run-id", now, limits });
    state = applySchedulerEvent(graph, state, event(state, "start", "ready", "running", {
      timestamp: "2026-07-22T00:00:02.000Z",
    }));
    expect(() => applySchedulerEvent(graph, state, event(state, "start", "running", "failed", {
      timestamp: "2026-07-22T00:00:01.000Z",
      errorCategory: "backdated",
    }))).toThrow(/predates the last durable event/);
    expect(evaluateExecutionGuard(graph, state, limits, {
      action: "node", nodeId: "alpha", nodeAttempts: 1, concurrency: 1,
      now: "2026-07-22T00:00:01.000Z", unattended: false,
    })).toMatchObject({ allowed: false, code: "invalid-guard-probe" });
  });

  it("separates business visits from bounded retries and global attempts", () => {
    const graph = stateMachine();
    const limits = { ...DEFAULT_EXECUTION_LIMITS, maxNodeAttempts: 3, backEdgeBudgets: { "loop-budget": 4 } };
    let state = createGraphExecutionState(graph, { runId: "opaque-run-id", now, limits });
    state = applySchedulerEvent(graph, state, event(state, "work", "ready", "running"));
    state = applySchedulerEvent(graph, state, event(state, "work", "running", "failed_retryable", {
      errorCategory: "transient",
    }));
    state = applySchedulerEvent(graph, state, event(state, "work", "failed_retryable", "ready"));
    expect(state.nodeStates.work).toMatchObject({ visits: 1, attempts: 1, retryAttempts: 1, status: "ready" });
    state = applySchedulerEvent(graph, state, event(state, "work", "ready", "running"));
    state = applySchedulerEvent(graph, state, event(state, "work", "running", "failed_retryable", {
      errorCategory: "transient",
    }));
    expect(() => applySchedulerEvent(graph, state, event(state, "work", "failed_retryable", "ready"))).toThrow(/retry budget/);

    const visitGraph = stateMachine();
    let visitState = createGraphExecutionState(visitGraph, { runId: "opaque-run-id", now, limits });
    visitState = applySchedulerEvent(visitGraph, visitState, event(visitState, "work", "ready", "running"));
    visitState = applySchedulerEvent(visitGraph, visitState, event(visitState, "work", "running", "blocked", {
      chosenEdge: { from: "work", to: "check", event: "built", boundedBy: "loop-budget" },
    }));
    visitState = applySchedulerEvent(visitGraph, visitState, event(visitState, "check", "ready", "running"));
    visitState = applySchedulerEvent(visitGraph, visitState, event(visitState, "check", "running", "blocked", {
      chosenEdge: { from: "check", to: "work", event: "retry", boundedBy: "loop-budget" },
    }));
    expect(visitState.nodeStates.work).toMatchObject({ visits: 2, attempts: 1, retryAttempts: 0, status: "ready" });
  });

  it("stops independently before every global ceiling and fails closed on unattended unknown usage", () => {
    const graph = dag();
    const generous: ExecutionLimits = {
      ...DEFAULT_EXECUTION_LIMITS,
      maxGraphNodes: 100,
      maxGraphEdges: 100,
      backEdgeBudgets: {},
    };
    type Probe = Parameters<typeof evaluateExecutionGuard>[3];
    type State = ReturnType<typeof createGraphExecutionState>;
    type Case = {
      code: string;
      mutate?: (state: State) => void;
      limits?: Partial<ExecutionLimits>;
      probe?: Partial<Probe>;
    };
    const modelProbe: Partial<Probe> = {
      action: "model",
      nodeAttempts: 0,
      concurrency: 0,
      modelCalls: 1,
      providerCalls: 1,
      sideEffectAttempts: 1,
      estimatedCostUsd: 0,
      observedCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    const cases: Case[] = [
      { code: "graph-step-limit", mutate: (value) => { value.guard.steps = 1; }, limits: { maxGraphSteps: 1 } },
      { code: "node-attempt-limit", mutate: (value) => { value.nodeStates.start!.attempts = 1; }, limits: { maxNodeAttempts: 1 } },
      { code: "plan-version-limit", mutate: (value) => { value.planVersion = 2; }, limits: { maxPlanVersions: 1 } },
      { code: "graph-node-limit", limits: { maxGraphNodes: graph.definition.nodes.length - 1 } },
      { code: "graph-edge-limit", limits: { maxGraphEdges: graph.definition.edges.length - 1 } },
      {
        code: "ready-width-limit",
        probe: {
          action: "transition", nodeAttempts: undefined, concurrency: undefined, additionalReady: 1,
          edge: { from: "start", to: "alpha", event: "fan-alpha" },
        },
        limits: { maxReadyWidth: 1 },
      },
      {
        code: "concurrency-limit",
        mutate: (value) => {
          value.nodeStates.start!.status = "running";
          value.nodeStates.start!.attempts = 1;
          value.nodeStates.start!.startedAt = now;
          value.ready = [];
          value.guard.steps = 1;
          value.guard.runningNodes = ["start"];
        },
        probe: { concurrency: 1 }, limits: { maxConcurrency: 1 },
      },
      { code: "model-concurrency-limit", mutate: (value) => { value.guard.modelCallsInFlight = 1; }, probe: modelProbe, limits: { maxModelConcurrency: 1 } },
      { code: "provider-concurrency-limit", mutate: (value) => { value.guard.providerCallsInFlight = 1; }, probe: modelProbe, limits: { maxProviderConcurrency: 1 } },
      { code: "wall-time-limit", probe: { now: "2026-07-22T00:00:02.000Z" }, limits: { maxWallTimeMs: 1_000 } },
      { code: "estimated-cost-limit", mutate: (value) => { value.guard.estimatedCostUsd = 1; }, probe: { ...modelProbe, estimatedCostUsd: 0.01 }, limits: { maxEstimatedCostUsd: 1 } },
      { code: "observed-cost-limit", mutate: (value) => { value.guard.observedCostUsd = 1; }, limits: { maxObservedCostUsd: 1 } },
      { code: "input-token-limit", mutate: (value) => { value.guard.inputTokens = 10; }, limits: { maxInputTokens: 10 } },
      { code: "output-token-limit", mutate: (value) => { value.guard.outputTokens = 10; }, limits: { maxOutputTokens: 10 } },
      {
        code: "side-effect-limit",
        mutate: (value) => { value.guard.sideEffectAttempts = 1; },
        probe: { action: "side_effect", nodeAttempts: 0, concurrency: 0, sideEffectAttempts: 1, sideEffectClass: "write" },
        limits: { maxSideEffectAttempts: 1 },
      },
      { code: "human-wait-denied", probe: { action: "human_wait", nodeAttempts: undefined, concurrency: undefined }, limits: { humanWait: "deny" } },
      {
        code: "human-wait-timeout",
        mutate: (value) => { value.guard.humanWaitStartedAt = now; },
        probe: { action: "human_wait", nodeAttempts: undefined, concurrency: undefined, now: "2026-07-22T00:00:02.000Z" },
        limits: { humanWait: "allow", maxHumanWaitMs: 1_000 },
      },
      { code: "no-progress-limit", mutate: (value) => { value.guard.noProgressRepeats = 2; }, limits: { maxNoProgressRepeats: 2 } },
      { code: "unknown-budget-data", probe: { ...modelProbe, unattended: true, estimatedCostUsd: "unknown" } },
    ];
    for (const selected of cases) {
      const limits = { ...generous, ...selected.limits };
      if (selected.code === "graph-node-limit" || selected.code === "graph-edge-limit") {
        expect(() => createGraphExecutionState(graph, { runId: "opaque-run-id", now, limits }), selected.code)
          .toThrow(/configured (node|edge) limit/);
        continue;
      }
      const state = createGraphExecutionState(graph, { runId: "opaque-run-id", now, limits });
      selected.mutate?.(state);
      const decision = evaluateExecutionGuard(graph, state, limits, {
        action: "node",
        nodeId: "start",
        nodeAttempts: 1,
        concurrency: 1,
        now,
        unattended: false,
        ...selected.probe,
      });
      expect(decision, selected.code).toMatchObject({ allowed: false, code: selected.code });
    }
  });

  it("counts a waiting-human phase as an attempt and checkpoints its external intent", () => {
    const graph = dag("external");
    const limits = { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} };
    let state = createGraphExecutionState(graph, { runId: "opaque-run-id", now, limits });
    state = applySchedulerEvent(graph, state, event(state, "start", "ready", "waiting_human", { attempt: 1 }));
    expect(state.nodeStates.start).toMatchObject({ status: "waiting_human", attempts: 1 });
    expect(state.guard).toMatchObject({ steps: 1, humanWaitStartedAt: now });

    const idempotencyKey = "start-visit-1-attempt-1";
    const checkpointRef = mutationCheckpoint(idempotencyKey);
    state = applySchedulerEvent(graph, state, {
      ...event(state, "start", "waiting_human", "waiting_human", { attempt: 1 }),
      kind: "side-effect-intent",
      requestRef: createHash("sha256").update(idempotencyKey).digest("hex"),
      checkpointRef,
      sideEffect: { phase: "intent", ordinal: 1, idempotencyKey, class: "external" },
    });
    expect(state.nodeStates.start!.sideEffect).toMatchObject({ status: "intent_recorded", class: "external", attempt: 1 });
  });

  it("freezes execution limits and rejects malformed or budget-masking guard probes", () => {
    const graph = dag();
    const limits = { ...DEFAULT_EXECUTION_LIMITS, maxGraphSteps: 7, backEdgeBudgets: {} };
    const state = createGraphExecutionState(graph, { runId: "opaque-run-id", now, limits });
    expect(state.effectiveLimits).toEqual(limits);
    expect(state.limitsFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(evaluateExecutionGuard(graph, state, { ...limits, maxGraphSteps: 8 }, {
      action: "node", nodeId: "start", nodeAttempts: 1, concurrency: 1, now, unattended: false,
    })).toMatchObject({ allowed: false, code: "execution-limits-mismatch" });

    const invalid = [
      { probe: { action: "bogus" }, code: "invalid-guard-probe" },
      { probe: { action: "node", nodeId: "missing" }, code: "invalid-guard-probe" },
      { probe: { action: "node", concurrency: -1 }, code: "invalid-guard-probe" },
      { probe: { action: "node", estimatedCostUsd: -1 }, code: "invalid-guard-probe" },
      { probe: { action: "node", now: "2026-07-21T23:59:59.000Z" }, code: "invalid-guard-probe" },
      {
        probe: { action: "transition", edge: { from: "start", to: "done", event: "forged" } },
        code: "invalid-guard-probe",
      },
    ] as const;
    for (const selected of invalid) {
      const decision = evaluateExecutionGuard(graph, state, limits, {
        action: "node", nodeId: "start", nodeAttempts: 1, concurrency: 1, now, unattended: false,
        ...selected.probe,
      } as never);
      expect(decision, JSON.stringify(selected.probe)).toMatchObject({ allowed: false, code: selected.code });
    }

    const unknown = structuredClone(state);
    unknown.guard.estimatedCostUsd = "unknown";
    expect(evaluateExecutionGuard(graph, unknown, limits, {
      action: "model", nodeId: "start", nodeAttempts: 0, concurrency: 0, now, unattended: true,
      modelCalls: 1, providerCalls: 1, sideEffectAttempts: 1,
      estimatedCostUsd: 0.1, observedCostUsd: 0, inputTokens: 0, outputTokens: 0,
    })).toMatchObject({ allowed: false, code: "unknown-budget-data" });

    const bypasses = [
      { action: "node", nodeId: "start", nodeAttempts: 0, concurrency: 0 },
      { action: "model", nodeId: "start", nodeAttempts: 0, concurrency: 0, modelCalls: 1, providerCalls: 1 },
      { action: "side_effect", nodeId: "start", nodeAttempts: 0, concurrency: 0, sideEffectAttempts: 0, sideEffectClass: "write" },
      { action: "transition", nodeId: "start", additionalReady: 1 },
    ] as const;
    for (const bypass of bypasses) {
      expect(evaluateExecutionGuard(graph, state, limits, {
        now, unattended: false, ...bypass,
      } as never), bypass.action).toMatchObject({ allowed: false, code: "invalid-guard-probe" });
    }
  });

  it("admits an exact absorbing cancellation after global ceilings and no further work", () => {
    const graph = stateMachine();
    const edge = { from: "work", to: "idle", event: "cancelled", boundedBy: "loop-budget" } as const;
    const later = "2026-07-22T00:00:02.000Z";
    const cases = [
      {
        name: "wall time",
        limits: { maxWallTimeMs: 1_000 },
        mutate: (_state: ReturnType<typeof createGraphExecutionState>) => {},
        unattended: false,
      },
      {
        name: "human wait",
        limits: { maxHumanWaitMs: 1_000 },
        mutate: (state: ReturnType<typeof createGraphExecutionState>) => { state.guard.humanWaitStartedAt = now; },
        unattended: false,
      },
      {
        name: "unknown cost",
        limits: {},
        mutate: (state: ReturnType<typeof createGraphExecutionState>) => { state.guard.estimatedCostUsd = "unknown"; },
        unattended: true,
      },
      {
        name: "no progress",
        limits: { maxNoProgressRepeats: 1 },
        mutate: (state: ReturnType<typeof createGraphExecutionState>) => { state.guard.noProgressRepeats = 1; },
        unattended: false,
      },
    ];

    for (const selected of cases) {
      const limits: ExecutionLimits = {
        ...DEFAULT_EXECUTION_LIMITS,
        backEdgeBudgets: { "loop-budget": 2 },
        ...selected.limits,
      };
      let state = createGraphExecutionState(graph, { runId: "opaque-run-id", now, limits });
      selected.mutate(state);
      expect(evaluateExecutionGuard(graph, state, limits, {
        action: "transition",
        nodeId: "work",
        additionalReady: 0,
        edge,
        terminalStop: "cancelled",
        now: later,
        unattended: selected.unattended,
      }), selected.name).toEqual({ allowed: true });

      state = applySchedulerEvent(graph, state, event(state, "work", "ready", "cancelled", {
        chosenEdge: edge,
        timestamp: later,
      }));
      expect(state.ready, selected.name).toEqual([]);
      expect(state.nodeStates).toMatchObject({ work: { status: "cancelled" }, idle: { status: "pending" } });
      expect(state.guard.backEdgeRemaining["loop-budget"]).toBe(1);

      const deniedProbes = [
        { action: "node", nodeId: "work", nodeAttempts: 1, concurrency: 1 },
        {
          action: "model", nodeId: "work", nodeAttempts: 0, concurrency: 0, modelCalls: 1, providerCalls: 1,
          sideEffectAttempts: 1, estimatedCostUsd: 0, observedCostUsd: 0, inputTokens: 0, outputTokens: 0,
        },
        { action: "side_effect", nodeId: "work", nodeAttempts: 0, concurrency: 0, sideEffectAttempts: 1, sideEffectClass: "external" },
      ] as const;
      for (const probe of deniedProbes) {
        expect(evaluateExecutionGuard(graph, state, limits, {
          ...probe,
          now: later,
          unattended: false,
        }), `${selected.name}:${probe.action}`).toMatchObject({ allowed: false, code: "invalid-guard-probe" });
      }
    }
  });

  it("reserves the final back-edge unit for exact terminal cleanup", () => {
    const graph = stateMachine();
    const limits = { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: { "loop-budget": 1 } };
    let state = createGraphExecutionState(graph, { runId: "opaque-run-id", now, limits });
    expect(evaluateExecutionGuard(graph, state, limits, {
      action: "transition",
      nodeId: "work",
      additionalReady: 1,
      edge: { from: "work", to: "check", event: "built", boundedBy: "loop-budget" },
      now,
      unattended: false,
    })).toMatchObject({ allowed: false, code: "back-edge-budget" });

    const cancellationEdge = { from: "work", to: "idle", event: "cancelled", boundedBy: "loop-budget" } as const;
    expect(evaluateExecutionGuard(graph, state, limits, {
      action: "transition",
      nodeId: "work",
      additionalReady: 0,
      edge: cancellationEdge,
      terminalStop: "cancelled",
      now,
      unattended: false,
    })).toEqual({ allowed: true });
    state = applySchedulerEvent(graph, state, event(state, "work", "ready", "cancelled", { chosenEdge: cancellationEdge }));
    expect(state.guard.backEdgeRemaining["loop-budget"]).toBe(0);

    const fresh = createGraphExecutionState(graph, { runId: "opaque-run-id", now, limits });
    expect(evaluateExecutionGuard(graph, fresh, limits, {
      action: "transition",
      nodeId: "work",
      additionalReady: 1,
      edge: { from: "work", to: "check", event: "built", boundedBy: "loop-budget" },
      terminalStop: "cancelled",
      now,
      unattended: false,
    })).toMatchObject({ allowed: false, code: "invalid-guard-probe" });
  });

  it("allows the final admitted node's model effect but blocks the next node start", () => {
    const graph = stateMachine();
    const limits = {
      ...DEFAULT_EXECUTION_LIMITS,
      maxGraphSteps: 1,
      backEdgeBudgets: { "loop-budget": 3 },
    };
    let state = createGraphExecutionState(graph, { runId: "opaque-run-id", now, limits });
    expect(evaluateExecutionGuard(graph, state, limits, {
      action: "node", nodeId: "work", nodeAttempts: 1, concurrency: 1, now, unattended: false,
    })).toEqual({ allowed: true });
    state = applySchedulerEvent(graph, state, event(state, "work", "ready", "running"));
    expect(evaluateExecutionGuard(graph, state, limits, {
      action: "model", nodeId: "work", nodeAttempts: 0, concurrency: 0, modelCalls: 1, providerCalls: 1,
      sideEffectAttempts: 1, estimatedCostUsd: 0, observedCostUsd: 0, inputTokens: 0, outputTokens: 0,
      now, unattended: false,
    })).toEqual({ allowed: true });
    state = applySchedulerEvent(graph, state, event(state, "work", "running", "blocked", {
      chosenEdge: { from: "work", to: "check", event: "built", boundedBy: "loop-budget" },
    }));
    expect(evaluateExecutionGuard(graph, state, limits, {
      action: "node", nodeId: "check", nodeAttempts: 1, concurrency: 1, now, unattended: false,
    })).toMatchObject({ allowed: false, code: "graph-step-limit" });
  });

  it("validates persisted ready order, graph identity, and state-machine width", () => {
    const graph = stateMachine();
    const limits = { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: { "loop-budget": 3 } };
    const state = createGraphExecutionState(graph, { runId: "opaque-run-id", now, limits });
    expect(() => assertScheduleValid(graph, state)).not.toThrow();
    expect(() => assertScheduleValid(graph, { ...state, ready: ["check", "work"] })).toThrow(/one active node|not in ready status/);
    expect(() => assertScheduleValid(graph, { ...state, graphVersion: "other" })).toThrow(/graph version/);

    const dagGraph = dag();
    const metadata: SchedulerMetadata = { priorities: { beta: 10, alpha: 5 } };
    let dagState = createGraphExecutionState(dagGraph, {
      runId: "opaque-run-id", now, limits: { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} },
      metadata,
    });
    dagState = applySchedulerEvent(dagGraph, dagState, event(dagState, "start", "ready", "running"), metadata);
    dagState = applySchedulerEvent(dagGraph, dagState, event(dagState, "start", "running", "executed"), metadata);
    expect(() => assertScheduleValid(dagGraph, { ...dagState, ready: ["alpha", "beta"] }, metadata)).toThrow(/ready order/);
  });

  it("fails closed on persisted-state corruption and impossible DAG readiness", () => {
    const graph = dag();
    const limits = { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} };
    const state = createGraphExecutionState(graph, { runId: "opaque-run-id", now, limits });
    const corruptions: Array<[string, ReturnType<typeof structuredClone>, RegExp]> = [];

    const forgedReady = structuredClone(state);
    forgedReady.nodeStates.alpha!.status = "ready";
    forgedReady.nodeStates.alpha!.visits = 1;
    forgedReady.ready = ["alpha", "start"];
    corruptions.push(["unmet predecessor", forgedReady, /predecessor|ready order/]);

    const extraBudget = structuredClone(state);
    extraBudget.guard.backEdgeRemaining.forged = 1;
    corruptions.push(["extra back-edge budget", extraBudget, /back-edge budget keys/]);

    const tamperedLimits = structuredClone(state);
    tamperedLimits.effectiveLimits.maxGraphSteps += 1;
    corruptions.push(["tampered limits", tamperedLimits, /limits fingerprint/]);

    const badHash = structuredClone(state);
    badHash.lastAppliedEventSequence = 1;
    badHash.revision = 1;
    badHash.lastAppliedEventId = "event-1";
    badHash.lastAppliedEventHash = "not-a-hash";
    badHash.recentEventIds = ["event-1"];
    corruptions.push(["bad event hash", badHash, /event hash/]);

    const badDigest = structuredClone(state);
    badDigest.graphDigest = "b".repeat(64);
    corruptions.push(["wrong graph digest", badDigest, /graph digest/]);

    for (const [label, corrupt, expected] of corruptions) {
      expect(() => assertScheduleValid(graph, corrupt), label).toThrow(expected);
    }

    const machine = stateMachine();
    const machineState = createGraphExecutionState(machine, {
      runId: "opaque-run-id", now, limits: { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: { "loop-budget": 2 } },
    });
    machineState.nodeStates.work!.status = "running";
    machineState.guard.runningNodes = ["work"];
    machineState.nodeStates.check!.status = "ready";
    machineState.nodeStates.check!.visits = 1;
    machineState.ready = ["check"];
    expect(() => assertScheduleValid(machine, machineState)).toThrow(/one active node/);
  });

  it("freezes priority metadata and ties revision identity to the applied event tail", () => {
    const graph = dag();
    const metadata: SchedulerMetadata = { priorities: { beta: 10, alpha: 5 } };
    const limits = { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} };
    const initial = createGraphExecutionState(graph, { runId: "opaque-run-id", now, limits, metadata });
    expect(initial.schedulerMetadata).toEqual(metadata);
    expect(initial.metadataFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const next = applySchedulerEvent(graph, initial, event(initial, "start", "ready", "running"));
    expect(next).toMatchObject({ revision: 1, lastAppliedEventSequence: 1, recentEventIds: ["event-1"] });
    expect(next.lastAppliedEventId).toBe(next.recentEventIds.at(-1));

    expect(() => assertScheduleValid(graph, { ...next, revision: 2 })).toThrow(/revision.*sequence/);
    expect(() => assertScheduleValid(graph, { ...next, recentEventIds: ["other"] })).toThrow(/event id tail/);
    expect(() => assertScheduleValid(graph, {
      ...next,
      schedulerMetadata: { priorities: { alpha: 99 } },
    })).toThrow(/metadata fingerprint/);
    expect(() => applySchedulerEvent(graph, next, event(next, "start", "running", "executed"), {
      priorities: { alpha: 99 },
    })).toThrow(/scheduler metadata/);
  });

  it("requires persisted completion outputs and validated predecessor inputs", () => {
    const graph = compileGraph({
      schemaVersion: 1,
      id: "artifact-dag",
      version: "1",
      kind: "dag",
      entry: "producer",
      nodes: [
        { ...node("producer"), outputContracts: ["shared"] },
        { ...node("consumer"), inputContracts: ["shared"] },
        node("done", true),
      ],
      edges: [
        { from: "producer", to: "consumer", event: "produced" },
        { from: "consumer", to: "done", event: "complete" },
      ],
    });
    const limits = { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} };
    let state = createGraphExecutionState(graph, { runId: "opaque-run-id", now, limits });
    state = applySchedulerEvent(graph, state, event(state, "producer", "ready", "running"));
    const completion = event(state, "producer", "running", "executed", {
      validatorResult: { status: "passed", contracts: ["shared"] },
      artifactRefs: [{
        planVersion: 1,
        nodeId: "producer",
        contract: "shared",
        path: "nodes/1/producer/shared.json",
        sha256: "a".repeat(64),
        sizeBytes: 12,
      }],
    });
    const completed = applySchedulerEvent(graph, state, completion);
    expect(completed.ready).toEqual(["consumer"]);

    expect(() => assertScheduleValid(graph, {
      ...completed,
      nodeStates: {
        ...completed.nodeStates,
        producer: { ...completed.nodeStates.producer!, outputRefs: [] },
      },
    })).toThrow(/completion output refs/);
    expect(() => assertScheduleValid(graph, {
      ...completed,
      nodeStates: {
        ...completed.nodeStates,
        consumer: {
          ...completed.nodeStates.consumer!,
          outputRefs: [{
            planVersion: 1,
            nodeId: "consumer",
            contract: "consumer-output",
            path: "nodes/1/consumer/consumer-output.json",
            sha256: "b".repeat(64),
            sizeBytes: 1,
          }],
        },
      },
    })).toThrow(/cannot retain output refs/);

    const unboundGraph = compileGraph({
      ...graph.definition,
      id: "unbound-artifact-dag",
      nodes: graph.definition.nodes.map((definition) => definition.id === "consumer"
        ? { ...definition, inputContracts: ["unbound"] }
        : { ...definition }),
      edges: graph.definition.edges.map((edge) => ({ ...edge })),
    });
    let unbound = createGraphExecutionState(unboundGraph, { runId: "opaque-run-id", now, limits });
    unbound = applySchedulerEvent(unboundGraph, unbound, event(unbound, "producer", "ready", "running"));
    unbound = applySchedulerEvent(unboundGraph, unbound, event(unbound, "producer", "running", "executed", {
      validatorResult: { status: "passed", contracts: ["shared"] },
      artifactRefs: completion.artifactRefs,
    }));
    expect(unbound.nodeStates.consumer!.status).toBe("pending");
    expect(unbound.ready).toEqual([]);
  });

  it("reserves the next plan namespace while retaining prior-version node evidence", () => {
    const graph = stateMachine();
    const limits = { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: { "loop-budget": 8 } };
    let state = createGraphExecutionState(graph, { runId: "opaque-run-id", now, limits });
    state = applySchedulerEvent(graph, state, event(state, "work", "ready", "running"));
    state = applySchedulerEvent(graph, state, event(state, "work", "running", "blocked", {
      chosenEdge: { from: "work", to: "check", event: "built", boundedBy: "loop-budget" },
    }));
    expect(state.nodeStates.work).toMatchObject({ planVersion: 1, status: "blocked" });
    expect(state.nodeStates.work!.outputRefs[0]!.planVersion).toBe(1);

    const activationRef = {
      planVersion: 2,
      nodeId: "check",
      contract: "plan-version-intent",
      path: "nodes/2/check/plan-version-intent.json",
      sha256: "e".repeat(64),
      sizeBytes: 4,
    };
    const reservation = {
      ...event(state, "check", "ready", "ready"),
      kind: "plan-version-reserved",
      priorPlanVersion: 1,
      nextPlanVersion: 2,
      activationRef,
    } as const satisfies GraphEvent;
    state = applySchedulerEvent(graph, state, reservation);
    expect(state.planVersion).toBe(2);
    expect(state.nodeStates.check).toMatchObject({ status: "ready", planVersion: 2 });
    expect(state.nodeStates.work).toMatchObject({ status: "blocked", planVersion: 1 });
    expect(() => assertScheduleValid(graph, state)).not.toThrow();
    expect(applySchedulerEvent(graph, state, reservation)).toEqual(state);
    expect(applySchedulerEvent(graph, state, event(state, "check", "ready", "running")).nodeStates.check!.status).toBe("running");

    expect(() => applySchedulerEvent(graph, state, {
      ...event(state, "check", "ready", "ready"),
      kind: "plan-version-reserved",
      priorPlanVersion: 1,
      nextPlanVersion: 3,
      activationRef: { ...activationRef, planVersion: 3, path: "nodes/3/check/plan-version-intent.json" },
    })).toThrow(/exactly one|current scheduler namespace/);
  });

  it("activates the exact terminal failure edge and rejects unresolved provider reservations", () => {
    const graph = stateMachine();
    const limits = { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: { "loop-budget": 8 } };
    let state = createGraphExecutionState(graph, { runId: "opaque-run-id", now, limits, currentNodeId: "check" });
    state = applySchedulerEvent(graph, state, event(state, "check", "ready", "running"));
    const failed = event(state, "check", "running", "failed", {
      chosenEdge: { from: "check", to: "failed", event: "provider_failed", boundedBy: "loop-budget" },
      errorCategory: "provider-unavailable",
    });
    const terminal = applySchedulerEvent(graph, state, failed);
    expect(terminal.nodeStates.check!.status).toBe("failed");
    expect(terminal.nodeStates.failed).toMatchObject({ status: "executed", visits: 1 });
    expect(terminal.ready).toEqual([]);

    expect(() => applySchedulerEvent(graph, state, { ...failed, chosenEdge: undefined })).toThrow(/requires one chosen edge/);
    expect(() => applySchedulerEvent(graph, state, {
      ...failed,
      chosenEdge: { from: "check", to: "work", event: "retry", boundedBy: "loop-budget" },
    })).toThrow(/terminal target/);

    const modelGraph = compileGraph({
      ...graph.definition,
      id: "scheduler-machine-model",
      nodes: graph.definition.nodes.map((definition) => definition.id === "check"
        ? { ...definition, sideEffect: "read" as const }
        : { ...definition }),
      edges: graph.definition.edges.map((edge) => ({ ...edge })),
    });
    let reserved = createGraphExecutionState(modelGraph, { runId: "opaque-run-id", now, limits, currentNodeId: "check" });
    reserved = applySchedulerEvent(modelGraph, reserved, event(reserved, "check", "ready", "running"));
    const checkpointRef = mutationCheckpoint("provider-call");
    reserved = applySchedulerEvent(modelGraph, reserved, event(reserved, "check", "running", "running", {
      kind: "side-effect-intent",
      requestRef: requestRef("provider-call"),
      checkpointRef,
      routingDecisionId: "route-provider-call",
      sideEffect: { phase: "intent", ordinal: 1, idempotencyKey: "provider-call", class: "model" },
      reservation: { modelCalls: 1, providerCalls: 1 },
    }));
    expect(() => applySchedulerEvent(modelGraph, reserved, event(reserved, "check", "running", "failed", {
      chosenEdge: { from: "check", to: "failed", event: "provider_failed", boundedBy: "loop-budget" },
      errorCategory: "provider-unavailable",
    }))).toThrow(/reservation remains unresolved/);
  });

  it("lets a DAG human node settle its external effect before executing", () => {
    const graph = dag("external");
    let state = createGraphExecutionState(graph, {
      runId: "opaque-run-id", now, limits: { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} },
    });
    state = applySchedulerEvent(graph, state, event(state, "start", "ready", "waiting_human", { attempt: 1 }));
    const digest = requestRef("human-integration");
    const checkpointRef = mutationCheckpoint("human-integration");
    state = applySchedulerEvent(graph, state, event(state, "start", "waiting_human", "waiting_human", {
      kind: "side-effect-intent",
      requestRef: digest,
      checkpointRef,
      sideEffect: { phase: "intent", ordinal: 1, idempotencyKey: "human-integration", class: "external" },
    }));
    const resultRef = event(state, "start", "waiting_human", "executed").artifactRefs[0]!;
    state = applySchedulerEvent(graph, state, event(state, "start", "waiting_human", "waiting_human", {
      kind: "side-effect-result",
      requestRef: digest,
      checkpointRef,
      sideEffect: {
        phase: "result", ordinal: 1, idempotencyKey: "human-integration", class: "external", outcome: "succeeded", resultRef,
      },
    }));
    state = applySchedulerEvent(graph, state, event(state, "start", "waiting_human", "executed"));
    expect(state.nodeStates.start!.status).toBe("executed");
    expect(state.ready).toEqual(["alpha", "beta"]);
  });

  it("migrates legacy node namespaces only when retained evidence is consistent", () => {
    const graph = dag();
    const state = createGraphExecutionState(graph, {
      runId: "opaque-run-id", now, limits: { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} },
    });
    const legacy = structuredClone(state);
    for (const node of Object.values(legacy.nodeStates)) delete (node as typeof node & { planVersion?: number }).planVersion;
    expect(migrateLegacyNodePlanVersions(legacy)).toMatchObject({
      nodeStates: { start: { planVersion: 1 }, alpha: { planVersion: 1 } },
    });

    const mixed = structuredClone(state);
    const rawStart = mixed.nodeStates.start as typeof mixed.nodeStates.start & { planVersion?: number };
    delete rawStart!.planVersion;
    rawStart!.outputRefs = [
      { planVersion: 1, nodeId: "start", contract: "start-output", path: "nodes/1/start/a", sha256: "a".repeat(64), sizeBytes: 1 },
      { planVersion: 2, nodeId: "start", contract: "start-output", path: "nodes/2/start/b", sha256: "b".repeat(64), sizeBytes: 1 },
    ];
    expect(() => migrateLegacyNodePlanVersions(mixed)).toThrow(/mixes artifact plan versions/);
  });
});
