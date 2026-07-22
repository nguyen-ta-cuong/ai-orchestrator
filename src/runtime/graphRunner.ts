import type { CompiledGraph } from "../core/graph.js";

export interface GraphExecutionCursor<State> {
  graphId: string;
  graphVersion: string;
  nodeId: string;
  state: State;
  step: number;
}

export interface NodeResult<Event, Output = unknown> {
  event: Event;
  output?: Output;
  evidence?: Record<string, string | number | boolean | null>;
}

export interface GraphRuntime<State, Event, Context> {
  reduce(state: State, event: Event): State;
  resolveEdge(previous: State, event: Event, next: State): string;
  stateNode(state: State): string;
  runNode(nodeId: string, state: State, context: Context): Promise<NodeResult<Event>>;
  isCurrent(cursor: Readonly<GraphExecutionCursor<State>>, context: Context): boolean;
}

export async function executeGraphStep<State, Event, Context>(
  graph: CompiledGraph,
  cursor: Readonly<GraphExecutionCursor<State>>,
  runtime: GraphRuntime<State, Event, Context>,
  context: Context,
): Promise<GraphExecutionCursor<State>> {
  assertCursorMatchesGraph(graph, cursor);
  const node = graph.nodesById.get(cursor.nodeId);
  if (!node) throw new Error(`Graph cursor references unknown node: ${cursor.nodeId}`);
  if (node.terminal) throw new Error(`Cannot execute terminal graph node: ${cursor.nodeId}`);
  if (!runtime.isCurrent(cursor, context)) throw new Error(`Stale graph execution cursor at ${cursor.nodeId}`);

  const result = await runtime.runNode(cursor.nodeId, cursor.state, context);
  if (!runtime.isCurrent(cursor, context)) throw new Error(`Graph execution became stale while running ${cursor.nodeId}`);

  const next = runtime.reduce(cursor.state, result.event);
  const nextNodeId = runtime.stateNode(next);
  const resolvedTarget = runtime.resolveEdge(cursor.state, result.event, next);
  const matches = (graph.outgoingByNode.get(cursor.nodeId) ?? []).filter((edge) => edge.to === resolvedTarget);
  if (matches.length !== 1) {
    throw new Error(`Graph transition from ${cursor.nodeId} resolved ${matches.length} matching edges to ${resolvedTarget}`);
  }
  if (resolvedTarget !== nextNodeId) {
    throw new Error(`Graph edge from ${cursor.nodeId} ends at ${resolvedTarget}, but reducer entered ${nextNodeId}`);
  }

  return {
    graphId: cursor.graphId,
    graphVersion: cursor.graphVersion,
    nodeId: nextNodeId,
    state: next,
    step: cursor.step + 1,
  };
}

function assertCursorMatchesGraph<State>(
  graph: CompiledGraph,
  cursor: Readonly<GraphExecutionCursor<State>>,
): void {
  if (cursor.graphId !== graph.definition.id) {
    throw new Error(`Graph cursor id ${cursor.graphId} does not match ${graph.definition.id}`);
  }
  if (cursor.graphVersion !== graph.definition.version) {
    throw new Error(`Graph cursor version ${cursor.graphVersion} does not match ${graph.definition.version}`);
  }
}
