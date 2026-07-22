import { describe, expect, it, vi } from "vitest";
import { compileGraph, type GraphDefinition } from "../src/core/graph.js";
import { executeGraphStep, type GraphExecutionCursor, type GraphRuntime } from "../src/runtime/graphRunner.js";

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
