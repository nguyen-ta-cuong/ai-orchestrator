import { describe, expect, it } from "vitest";
import {
  compileGraph,
  renderGraphMermaid,
  type GraphDefinition,
  type GraphEdgeDefinition,
  type GraphNodeDefinition,
} from "../src/core/graph.js";

function graph(overrides: Partial<GraphDefinition> = {}): GraphDefinition {
  return {
    schemaVersion: 1,
    id: "test-graph",
    version: "1.0.0",
    kind: "dag",
    entry: "start",
    nodes: [node("start"), node("done", true)],
    edges: [{ from: "start", to: "done", event: "complete" }],
    ...overrides,
  };
}

function node(id: string, terminal = false, overrides: Partial<GraphNodeDefinition> = {}): GraphNodeDefinition {
  return {
    id,
    handler: `${id}-handler`,
    ...(terminal ? { terminal: true } : {}),
    inputContracts: [],
    outputContracts: [],
    sideEffect: "none",
    timeoutMs: 1_000,
    retryBudget: 0,
    ...overrides,
  };
}

describe("compileGraph", () => {
  it("normalizes and freezes a valid definition without mutating its input", () => {
    const input = graph({
      nodes: [node("done", true), node("start")],
      edges: [{ from: "start", to: "done", event: "complete" }],
    });
    const compiled = compileGraph(input);

    expect(compiled.definition.nodes.map(({ id }) => id)).toEqual(["done", "start"]);
    expect(input.nodes.map(({ id }) => id)).toEqual(["done", "start"]);
    expect(compiled.topologicalOrder).toEqual(["start", "done"]);
    expect(Object.isFrozen(compiled.definition)).toBe(true);
    expect(Object.isFrozen(compiled.definition.nodes)).toBe(true);
    expect(Object.isFrozen(compiled.definition.nodes[0])).toBe(true);
    expect(Object.isFrozen(compiled.outgoingByNode.get("start"))).toBe(true);
    expect("set" in compiled.nodesById).toBe(false);
    expect("delete" in compiled.outgoingByNode).toBe(false);
  });

  it.each([
    ["schema version", graph({ schemaVersion: 2 as 1 }), "Unsupported graph schema version"],
    ["graph id", graph({ id: "Bad ID" }), "Malformed graph id"],
    ["version", graph({ version: "" }), "Malformed graph version"],
    ["kind", graph({ kind: "tree" as "dag" }), "Unsupported graph kind"],
    ["entry id", graph({ entry: "Bad Entry" }), "Malformed graph entry"],
    ["empty nodes", graph({ nodes: [], edges: [] }), "at least one node"],
  ])("rejects a malformed %s", (_label, definition, message) => {
    expect(() => compileGraph(definition)).toThrow(message);
  });

  it("rejects duplicate and malformed node identities", () => {
    expect(() => compileGraph(graph({ nodes: [node("start"), node("start", true)] }))).toThrow("Duplicate graph node id");
    expect(() => compileGraph(graph({ nodes: [node("Bad"), node("done", true)] }))).toThrow("Malformed node id");
    expect(() => compileGraph(graph({ nodes: [node("start", false, { handler: "" }), node("done", true)] }))).toThrow(
      "Malformed handler",
    );
  });

  it("rejects missing entry and edge endpoints", () => {
    expect(() => compileGraph(graph({ entry: "missing" }))).toThrow("entry node does not exist");
    expect(() => compileGraph(graph({ edges: [{ from: "missing", to: "done", event: "complete" }] }))).toThrow(
      "edge source does not exist",
    );
    expect(() => compileGraph(graph({ edges: [{ from: "start", to: "missing", event: "complete" }] }))).toThrow(
      "edge target does not exist",
    );
  });

  it("rejects malformed edge data and ambiguous routes", () => {
    expect(() => compileGraph(graph({ edges: [{ from: "start", to: "done", event: "Bad Event" }] }))).toThrow(
      "Malformed edge event",
    );
    expect(() => compileGraph(graph({ edges: [{ from: "start", to: "done", event: "complete", guard: "Bad Guard" }] }))).toThrow(
      "Malformed edge guard",
    );
    const duplicate: GraphEdgeDefinition = { from: "start", to: "done", event: "complete", guard: "ready" };
    expect(() => compileGraph(graph({ edges: [duplicate, { ...duplicate }] }))).toThrow("Ambiguous graph edges");
  });

  it("allows one event to use distinct named guards", () => {
    const compiled = compileGraph(graph({
      nodes: [node("start"), node("left", true), node("right", true)],
      edges: [
        { from: "start", to: "left", event: "complete", guard: "choose-left" },
        { from: "start", to: "right", event: "complete", guard: "choose-right" },
      ],
    }));
    expect(compiled.outgoingByNode.get("start")).toHaveLength(2);
  });

  it("rejects invalid contracts, timing, retries, and side-effect declarations", () => {
    expect(() => compileGraph(graph({ nodes: [node("start", false, { inputContracts: [""] }), node("done", true)] }))).toThrow(
      "empty input contract",
    );
    expect(() => compileGraph(graph({ nodes: [node("start", false, { outputContracts: ["x", "x"] }), node("done", true)] }))).toThrow(
      "duplicate output contracts",
    );
    expect(() => compileGraph(graph({ nodes: [node("start", false, { timeoutMs: 0 }), node("done", true)] }))).toThrow(
      "timeoutMs must be a positive integer",
    );
    expect(() => compileGraph(graph({ nodes: [node("start", false, { retryBudget: -1 }), node("done", true)] }))).toThrow(
      "retryBudget must be a non-negative integer",
    );
    expect(() => compileGraph(graph({ nodes: [node("start", false, { sideEffect: "invalid" as "none" }), node("done", true)] }))).toThrow(
      "Invalid side-effect class",
    );
  });

  it("requires output evidence for high-impact work and rejects speculative joins", () => {
    expect(() => compileGraph(graph({ nodes: [node("start", false, { sideEffect: "external" }), node("done", true)] }))).toThrow(
      "must declare an output contract",
    );
    expect(() => compileGraph(graph({ nodes: [node("start", false, { outputContracts: ["speculative-join"] }), node("done", true)] }))).toThrow(
      "unsupported speculative-join",
    );
  });

  it("rejects unreachable nodes and regions that cannot reach a terminal", () => {
    expect(() => compileGraph(graph({ nodes: [node("start"), node("done", true), node("orphan", true)] }))).toThrow(
      "Unreachable graph nodes: orphan",
    );
    expect(() => compileGraph(graph({
      kind: "state-machine",
      nodes: [node("start"), node("trapped"), node("done", true)],
      edges: [
        { from: "start", to: "done", event: "finish" },
        { from: "start", to: "trapped", event: "trap" },
        { from: "trapped", to: "trapped", event: "repeat", boundedBy: "retry-budget" },
      ],
    }))).toThrow("Graph nodes cannot reach a terminal: trapped");
    expect(() => compileGraph(graph({ nodes: [node("start"), node("done")] }))).toThrow("at least one terminal node");
  });

  it("rejects every DAG cycle and unbounded state-machine back edges", () => {
    const cyclicEdges: GraphEdgeDefinition[] = [
      { from: "start", to: "middle", event: "advance" },
      { from: "middle", to: "start", event: "retry" },
      { from: "middle", to: "done", event: "finish" },
    ];
    const nodes = [node("start"), node("middle"), node("done", true)];
    expect(() => compileGraph(graph({ nodes, edges: cyclicEdges }))).toThrow("DAG graph contains a cycle");
    expect(() => compileGraph(graph({ kind: "state-machine", nodes, edges: cyclicEdges }))).toThrow(
      "must declare boundedBy",
    );
    expect(compileGraph(graph({
      kind: "state-machine",
      nodes,
      edges: cyclicEdges.map((edge) => edge.to === "start" ? { ...edge, boundedBy: "retry-budget" } : edge),
    })).topologicalOrder).toBeUndefined();
  });
});

describe("renderGraphMermaid", () => {
  it("renders canonical byte-stable Mermaid with escaped labels", () => {
    const compiled = compileGraph(graph({
      edges: [{ from: "start", to: "done", event: "complete", guard: "output-ready" }],
    }));
    const first = renderGraphMermaid(compiled);
    const second = renderGraphMermaid(compiled);

    expect(first).toBe(second);
    expect(first).toBe([
      "flowchart TD",
      "    node_done([\"done\"])",
      "    node_start[\"start\"]",
      "    node_start -->|\"complete / output-ready\"| node_done",
      "",
    ].join("\n"));
  });
});
