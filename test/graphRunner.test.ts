import { describe, expect, it, vi } from "vitest";
import { compileGraph, type GraphDefinition } from "../src/core/graph.js";
import {
  executeGraphStep,
  executeScheduledGraphStep,
  type GraphExecutionCursor,
  type GraphRuntime,
} from "../src/runtime/graphRunner.js";
import {
  DEFAULT_EXECUTION_LIMITS,
  applySchedulerEvent,
  createGraphExecutionState,
  type ArtifactReference,
  type GraphEvent,
} from "../src/core/scheduler.js";

type State = { phase: "start" | "next" | "done"; runId: string };
type Event = { type: "advance" } | { type: "finish" };

const graph = compileGraph({
  schemaVersion: 1,
  id: "runner-test",
  version: "1",
  kind: "dag",
  entry: "start",
  nodes: [
    { id: "start", handler: "start-handler", inputContracts: [], outputContracts: [], sideEffect: "none", timeoutMs: 1, retryBudget: 0 },
    { id: "next", handler: "next-handler", inputContracts: [], outputContracts: [], sideEffect: "none", timeoutMs: 1, retryBudget: 0 },
    { id: "done", handler: "done-handler", terminal: true, inputContracts: [], outputContracts: [], sideEffect: "none", timeoutMs: 1, retryBudget: 0 },
  ],
  edges: [
    { from: "start", to: "next", event: "advance" },
    { from: "next", to: "done", event: "finish" },
  ],
} satisfies GraphDefinition);

function cursor(nodeId = "start"): GraphExecutionCursor<State> {
  return { graphId: "runner-test", graphVersion: "1", nodeId, state: { phase: nodeId as State["phase"], runId: "run-1" }, step: 0 };
}

function runtime(overrides: Partial<GraphRuntime<State, Event, { runId: string }>> = {}): GraphRuntime<State, Event, { runId: string }> {
  return {
    reduce: (state, event) => ({ ...state, phase: event.type === "advance" ? "next" : "done" }),
    resolveEdge: (_before, _event, next) => next.phase,
    stateNode: (state) => state.phase,
    runNode: vi.fn(async () => ({ event: { type: "advance" } })),
    isCurrent: (value, context) => value.state.runId === context.runId,
    ...overrides,
  };
}

describe("executeGraphStep", () => {
  it("runs one registered node and advances only through the reducer-selected edge", async () => {
    const active = runtime();
    const next = await executeGraphStep(graph, cursor(), active, { runId: "run-1" });
    expect(next).toEqual({ graphId: "runner-test", graphVersion: "1", nodeId: "next", state: { phase: "next", runId: "run-1" }, step: 1 });
    expect(active.runNode).toHaveBeenCalledOnce();
  });

  it("offers an additive scheduled entry point that checkpoints every admitted boundary", async () => {
    const durableGraph = compileGraph({
      schemaVersion: 1,
      id: "durable-runner-test",
      version: "1",
      kind: "dag",
      entry: "start",
      nodes: [
        {
          id: "start", handler: "start-handler", inputContracts: [], outputContracts: ["start-output"],
          sideEffect: "external", timeoutMs: 1, retryBudget: 0,
        },
        { id: "done", handler: "done-handler", terminal: true, inputContracts: ["start-output"], outputContracts: [], sideEffect: "none", timeoutMs: 1, retryBudget: 0 },
      ],
      edges: [{ from: "start", to: "done", event: "advance" }],
    } satisfies GraphDefinition);
    const limits = { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} };
    let durable = createGraphExecutionState(durableGraph, { runId: "run-1", now: "2026-07-22T00:00:00.000Z", limits });
    const events: GraphEvent[] = [];
    const checkpoint = vi.fn(async (_current, event: Readonly<GraphEvent>) => {
      durable = applySchedulerEvent(durableGraph, durable, event);
      events.push(structuredClone(event));
      return structuredClone(durable);
    });
    const active = runtime({
      runNode: vi.fn(async () => ({ event: { type: "advance" } })),
      reduce: (state) => ({ ...state, phase: "done" }),
      resolveEdge: () => "done",
      stateNode: () => "done",
    });
    const receipt: ArtifactReference = {
      planVersion: 1, nodeId: "start", contract: "external-receipt",
      path: "nodes/1/start/external-receipt.json", sha256: "a".repeat(64), sizeBytes: 8,
    };
    const output: ArtifactReference = {
      planVersion: 1, nodeId: "start", contract: "start-output",
      path: "nodes/1/start/start-output.json", sha256: "b".repeat(64), sizeBytes: 9,
    };
    const result = await executeScheduledGraphStep(durableGraph, {
      graphId: durableGraph.definition.id,
      graphVersion: durableGraph.definition.version,
      nodeId: "start",
      state: { phase: "start", runId: "run-1" },
      step: 0,
    }, active, { runId: "run-1" }, {
      schedulerState: durable,
      limits,
      unattended: false,
      now: () => "2026-07-22T00:00:00.000Z",
      persistence: { checkpoint },
      prepareSideEffect: () => ({
        class: "external",
        requestRef: "c".repeat(64),
        idempotencyKey: "worktree-create-start",
        checkpointRef: { path: `mutations/${"d".repeat(64)}.json`, sha256: "d".repeat(64), sizeBytes: 10 },
        persistResult: async () => receipt,
        recoverResult: async () => ({ event: { type: "advance" } }),
      }),
      completion: () => ({ artifactRefs: [output] }),
    });

    expect(events.map((event) => event.kind)).toEqual([
      "node-status", "side-effect-intent", "side-effect-result", "node-status",
    ]);
    expect(events[1]!.checkpointRef).toEqual(events[2]!.checkpointRef);
    expect(result.schedulerState.nodeStates.start).toMatchObject({ status: "executed", sideEffect: { status: "succeeded" } });
    expect(result.cursor).toMatchObject({ nodeId: "done", state: { phase: "done", runId: "run-1" }, step: 1 });
  });

  it("persists a thrown mutation-capable side effect as unknown instead of failed", async () => {
    const durableGraph = compileGraph({
      schemaVersion: 1,
      id: "durable-runner-ambiguous-throw",
      version: "1",
      kind: "dag",
      entry: "start",
      nodes: [
        { id: "start", handler: "start-handler", inputContracts: [], outputContracts: ["start-output"], sideEffect: "external", timeoutMs: 1, retryBudget: 0 },
        { id: "done", handler: "done-handler", terminal: true, inputContracts: [], outputContracts: [], sideEffect: "none", timeoutMs: 1, retryBudget: 0 },
      ],
      edges: [{ from: "start", to: "done", event: "advance" }],
    } satisfies GraphDefinition);
    const limits = { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} };
    let durable = createGraphExecutionState(durableGraph, { runId: "run-1", now: "2026-07-22T00:00:00.000Z", limits });
    const events: GraphEvent[] = [];
    const active = runtime({
      runNode: vi.fn(async () => { throw new Error("response lost after dispatch"); }),
      reduce: (state) => ({ ...state, phase: "done" }),
      resolveEdge: () => "done",
      stateNode: () => "done",
    });

    await expect(executeScheduledGraphStep(durableGraph, {
      graphId: durableGraph.definition.id,
      graphVersion: durableGraph.definition.version,
      nodeId: "start",
      state: { phase: "start" as const, runId: "run-1" },
      step: 0,
    }, active, { runId: "run-1" }, {
      schedulerState: durable,
      limits,
      unattended: false,
      now: () => "2026-07-22T00:00:00.000Z",
      persistence: {
        checkpoint: async (_current, event) => {
          durable = applySchedulerEvent(durableGraph, durable, event);
          events.push(structuredClone(event));
          return structuredClone(durable);
        },
      },
      prepareSideEffect: () => ({
        class: "external",
        requestRef: "1".repeat(64),
        idempotencyKey: "ambiguous-external-call",
        checkpointRef: { path: `mutations/${"1".repeat(64)}.json`, sha256: "1".repeat(64), sizeBytes: 1 },
        persistResult: async () => { throw new Error("must not persist a missing result"); },
        recoverResult: async () => ({ event: { type: "advance" as const } }),
      }),
    })).rejects.toThrow("response lost after dispatch");

    expect(durable.nodeStates.start!.sideEffect).toMatchObject({ status: "unknown", outcome: "unknown" });
    expect(events.at(-1)).toMatchObject({
      kind: "side-effect-result",
      sideEffect: { outcome: "unknown" },
    });
  });

  it("rejects mutation-capable execution before dispatch when its exact checkpoint is missing", async () => {
    const durableGraph = compileGraph({
      schemaVersion: 1,
      id: "durable-runner-checkpoint-required",
      version: "1",
      kind: "dag",
      entry: "start",
      nodes: [
        { id: "start", handler: "start-handler", inputContracts: [], outputContracts: ["start-output"], sideEffect: "external", timeoutMs: 1, retryBudget: 0 },
        { id: "done", handler: "done-handler", terminal: true, inputContracts: [], outputContracts: [], sideEffect: "none", timeoutMs: 1, retryBudget: 0 },
      ],
      edges: [{ from: "start", to: "done", event: "advance" }],
    } satisfies GraphDefinition);
    const limits = { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} };
    let durable = createGraphExecutionState(durableGraph, { runId: "run-1", now: "2026-07-22T00:00:00.000Z", limits });
    const runNode = vi.fn(async () => ({ event: { type: "advance" as const } }));

    await expect(executeScheduledGraphStep(durableGraph, {
      graphId: durableGraph.definition.id,
      graphVersion: durableGraph.definition.version,
      nodeId: "start",
      state: { phase: "start" as const, runId: "run-1" },
      step: 0,
    }, runtime({ runNode }), { runId: "run-1" }, {
      schedulerState: durable,
      limits,
      unattended: false,
      now: () => "2026-07-22T00:00:00.000Z",
      persistence: {
        checkpoint: async (_current, event) => {
          durable = applySchedulerEvent(durableGraph, durable, event);
          return structuredClone(durable);
        },
      },
      prepareSideEffect: () => ({
        class: "external",
        requestRef: "2".repeat(64),
        idempotencyKey: "missing-checkpoint",
        persistResult: async () => ({
          planVersion: 1, nodeId: "start", contract: "receipt",
          path: "nodes/1/start/receipt.json", sha256: "2".repeat(64), sizeBytes: 1,
        }),
        recoverResult: async () => ({ event: { type: "advance" as const } }),
      }),
    })).rejects.toThrow(/checkpoint/i);
    expect(runNode).not.toHaveBeenCalled();
  });

  it("records actual model usage returned by the completed node", async () => {
    const durableGraph = compileGraph({
      schemaVersion: 1,
      id: "durable-runner-actual-usage",
      version: "1",
      kind: "dag",
      entry: "start",
      nodes: [
        { id: "start", handler: "start-handler", inputContracts: [], outputContracts: ["start-output"], sideEffect: "external", timeoutMs: 1, retryBudget: 0 },
        { id: "done", handler: "done-handler", terminal: true, inputContracts: [], outputContracts: [], sideEffect: "none", timeoutMs: 1, retryBudget: 0 },
      ],
      edges: [{ from: "start", to: "done", event: "advance" }],
    } satisfies GraphDefinition);
    const limits = { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} };
    let durable = createGraphExecutionState(durableGraph, { runId: "run-1", now: "2026-07-22T00:00:00.000Z", limits });
    const events: GraphEvent[] = [];
    await executeScheduledGraphStep(durableGraph, {
      graphId: durableGraph.definition.id,
      graphVersion: durableGraph.definition.version,
      nodeId: "start",
      state: { phase: "start" as const, runId: "run-1" },
      step: 0,
    }, runtime({
      runNode: vi.fn(async () => ({
        event: { type: "advance" as const },
        usage: { observedCostUsd: 1.25, inputTokens: 120, outputTokens: 30 },
      })),
      reduce: (state) => ({ ...state, phase: "done" }),
      resolveEdge: () => "done",
      stateNode: () => "done",
    }), { runId: "run-1" }, {
      schedulerState: durable,
      limits,
      unattended: false,
      now: () => "2026-07-22T00:00:00.000Z",
      persistence: {
        checkpoint: async (_current, event) => {
          durable = applySchedulerEvent(durableGraph, durable, event);
          events.push(structuredClone(event));
          return structuredClone(durable);
        },
      },
      prepareSideEffect: () => ({
        class: "model",
        requestRef: "3".repeat(64),
        idempotencyKey: "model-with-usage",
        routingDecisionId: "route-with-usage",
        checkpointRef: { path: `mutations/${"3".repeat(64)}.json`, sha256: "3".repeat(64), sizeBytes: 1 },
        estimatedUsage: { estimatedCostUsd: 0.75 },
        persistResult: async () => ({
          planVersion: 1, nodeId: "start", contract: "receipt",
          path: "nodes/1/start/receipt.json", sha256: "3".repeat(64), sizeBytes: 1,
        }),
        recoverResult: async () => ({ event: { type: "advance" as const } }),
      }),
      completion: () => ({
        artifactRefs: [{
          planVersion: 1, nodeId: "start", contract: "start-output",
          path: "nodes/1/start/start-output.json", sha256: "4".repeat(64), sizeBytes: 1,
        }],
      }),
    });

    expect(events.find((event) => event.kind === "side-effect-result")?.usage).toEqual({
      estimatedCostUsd: 0.75,
      observedCostUsd: 1.25,
      inputTokens: 120,
      outputTokens: 30,
    });
  });

  it("does not repeat a side effect after an intent append crashes before its snapshot", async () => {
    const durableGraph = compileGraph({
      schemaVersion: 1,
      id: "durable-runner-crash",
      version: "1",
      kind: "dag",
      entry: "start",
      nodes: [
        { id: "start", handler: "start-handler", inputContracts: [], outputContracts: ["start-output"], sideEffect: "external", timeoutMs: 1, retryBudget: 0 },
        { id: "done", handler: "done-handler", terminal: true, inputContracts: ["start-output"], outputContracts: [], sideEffect: "none", timeoutMs: 1, retryBudget: 0 },
      ],
      edges: [{ from: "start", to: "done", event: "advance" }],
    } satisfies GraphDefinition);
    const limits = { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} };
    let durable = createGraphExecutionState(durableGraph, { runId: "run-1", now: "2026-07-22T00:00:00.000Z", limits });
    const runNode = vi.fn(async () => ({ event: { type: "advance" as const } }));
    const active = runtime({ runNode });
    let failIntent = true;
    const checkpoint = async (_current: unknown, event: Readonly<GraphEvent>) => {
      durable = applySchedulerEvent(durableGraph, durable, event);
      if (event.kind === "side-effect-intent" && failIntent) {
        failIntent = false;
        throw new Error("simulated append-before-snapshot crash");
      }
      return structuredClone(durable);
    };
    const execute = () => executeScheduledGraphStep(durableGraph, {
      graphId: durableGraph.definition.id,
      graphVersion: durableGraph.definition.version,
      nodeId: "start",
      state: { phase: "start" as const, runId: "run-1" },
      step: 0,
    }, active, { runId: "run-1" }, {
      schedulerState: durable,
      limits,
      unattended: false,
      now: () => "2026-07-22T00:00:00.000Z",
      persistence: { checkpoint },
      prepareSideEffect: () => ({
        class: "external" as const,
        requestRef: "e".repeat(64),
        idempotencyKey: "worktree-create-crash",
        checkpointRef: { path: `mutations/${"e".repeat(64)}.json`, sha256: "e".repeat(64), sizeBytes: 12 },
        persistResult: async () => ({
          planVersion: 1, nodeId: "start", contract: "receipt",
          path: "nodes/1/start/receipt.json", sha256: "f".repeat(64), sizeBytes: 1,
        }),
        recoverResult: async () => ({ event: { type: "advance" as const } }),
      }),
    });

    await expect(execute()).rejects.toThrow("simulated append-before-snapshot crash");
    expect(durable.nodeStates.start!.sideEffect?.status).toBe("intent_recorded");
    await expect(execute()).rejects.toThrow(/ambiguous side effect requiring reconciliation/);
    expect(runNode).not.toHaveBeenCalled();
  });

  it("requires the exact full checkpoint returned by durable persistence", async () => {
    const limits = { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} };
    const scheduler = createGraphExecutionState(graph, { runId: "run-1", now: "2026-07-22T00:00:00.000Z", limits });
    const active = runtime();
    await expect(executeScheduledGraphStep(graph, cursor(), active, { runId: "run-1" }, {
      schedulerState: scheduler,
      limits,
      unattended: false,
      now: () => "2026-07-22T00:00:00.000Z",
      persistence: {
        checkpoint: async (current, event) => {
          const forged = applySchedulerEvent(graph, current, event);
          forged.guard.noProgressRepeats += 1;
          return forged;
        },
      },
    })).rejects.toThrow(/unexpected identity/);
    expect(active.runNode).not.toHaveBeenCalled();
  });

  it("reconciles an immutable result created before its result event and binds exact effect identity", async () => {
    const durableGraph = compileGraph({
      schemaVersion: 1,
      id: "durable-result-reconciliation",
      version: "1",
      kind: "dag",
      entry: "start",
      nodes: [
        { id: "start", handler: "start-handler", inputContracts: [], outputContracts: ["start-output"], sideEffect: "external", timeoutMs: 1, retryBudget: 0 },
        { id: "done", handler: "done-handler", terminal: true, inputContracts: ["start-output"], outputContracts: [], sideEffect: "none", timeoutMs: 1, retryBudget: 0 },
      ],
      edges: [{ from: "start", to: "done", event: "advance" }],
    } satisfies GraphDefinition);
    const limits = { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} };
    let durable = createGraphExecutionState(durableGraph, { runId: "run-1", now: "2026-07-22T00:00:00.000Z", limits });
    const resultRef: ArtifactReference = {
      planVersion: 1, nodeId: "start", contract: "worktree-receipt",
      path: "nodes/1/start/worktree-receipt.json", sha256: "1".repeat(64), sizeBytes: 4,
    };
    const outputRef: ArtifactReference = {
      planVersion: 1, nodeId: "start", contract: "start-output",
      path: "nodes/1/start/start-output.json", sha256: "2".repeat(64), sizeBytes: 5,
    };
    const runNode = vi.fn(async () => ({ event: { type: "advance" as const } }));
    const active = runtime({
      runNode,
      reduce: (state) => ({ ...state, phase: "done" }),
      resolveEdge: () => "done",
      stateNode: () => "done",
    });
    let failBeforeResultAppend = true;
    const checkpoint = async (current: Readonly<typeof durable>, event: Readonly<GraphEvent>) => {
      if (event.kind === "side-effect-result" && failBeforeResultAppend) {
        failBeforeResultAppend = false;
        throw new Error("crash after immutable result publish");
      }
      durable = applySchedulerEvent(durableGraph, current, event);
      return structuredClone(durable);
    };
    const baseEffect = {
      class: "external" as const,
      requestRef: "3".repeat(64),
      idempotencyKey: "worktree-create-result-crash",
      checkpointRef: { path: `mutations/${"3".repeat(64)}.json`, sha256: "3".repeat(64), sizeBytes: 11 },
      persistResult: vi.fn(async () => resultRef),
      recoverResult: vi.fn(async () => ({ event: { type: "advance" as const } })),
    };
    const execute = (effect: typeof baseEffect & { reconcileIntent?: typeof reconcileIntent }) => executeScheduledGraphStep(durableGraph, {
      graphId: durableGraph.definition.id,
      graphVersion: durableGraph.definition.version,
      nodeId: "start",
      state: { phase: "start" as const, runId: "run-1" },
      step: 0,
    }, active, { runId: "run-1" }, {
      schedulerState: durable,
      limits,
      unattended: false,
      now: () => "2026-07-22T00:00:00.000Z",
      persistence: { checkpoint },
      prepareSideEffect: () => effect,
      completion: () => ({ artifactRefs: [outputRef] }),
    });
    const reconcileIntent = vi.fn(async () => ({
      outcome: "succeeded" as const,
      resultRef,
      result: { event: { type: "advance" as const } },
    }));

    await expect(execute(baseEffect)).rejects.toThrow("crash after immutable result publish");
    expect(runNode).toHaveBeenCalledOnce();
    expect(durable.nodeStates.start!.sideEffect?.status).toBe("intent_recorded");
    await expect(execute({ ...baseEffect, idempotencyKey: "substituted-key", reconcileIntent })).rejects.toThrow(/does not match its persisted identity/);
    const recovered = await execute({ ...baseEffect, reconcileIntent });
    expect(reconcileIntent).toHaveBeenCalledOnce();
    expect(runNode).toHaveBeenCalledOnce();
    expect(baseEffect.persistResult).toHaveBeenCalledOnce();
    expect(recovered.schedulerState.nodeStates.start).toMatchObject({ status: "executed", sideEffect: { status: "succeeded" } });
  });

  it("rejects unknown handlers before reducing", async () => {
    await expect(executeGraphStep(graph, cursor(), runtime({ runNode: async () => { throw new Error("Unregistered node handler: start"); } }), { runId: "run-1" }))
      .rejects.toThrow("Unregistered node handler");
  });

  it("rejects stale identity before and after an awaited handler", async () => {
    await expect(executeGraphStep(graph, cursor(), runtime(), { runId: "other" })).rejects.toThrow("Stale graph execution cursor");
    let current = true;
    const active = runtime({
      isCurrent: () => current,
      runNode: async () => { current = false; return { event: { type: "advance" } }; },
    });
    await expect(executeGraphStep(graph, cursor(), active, { runId: "run-1" })).rejects.toThrow("became stale");
  });

  it("rejects missing, ambiguous, and reducer-divergent edges", async () => {
    await expect(executeGraphStep(graph, cursor(), runtime({ resolveEdge: () => "done" }), { runId: "run-1" })).rejects.toThrow("0 matching edges");
    await expect(executeGraphStep(graph, cursor(), runtime({ stateNode: () => "done" }), { runId: "run-1" })).rejects.toThrow("reducer entered done");
  });

  it("rejects terminal node execution and graph identity mismatches", async () => {
    await expect(executeGraphStep(graph, cursor("done"), runtime(), { runId: "run-1" })).rejects.toThrow("terminal graph node");
    await expect(executeGraphStep(graph, { ...cursor(), graphVersion: "2" }, runtime(), { runId: "run-1" })).rejects.toThrow("version");
  });
});
