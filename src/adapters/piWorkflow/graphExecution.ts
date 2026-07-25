import type { ExecutionEngine } from "../../core/config.js";
import { compileGraph, type GraphDefinition } from "../../core/graph.js";
import { executeGraphStep, type GraphExecutionCursor } from "../../runtime/graphRunner.js";

interface PhasedState {
  phase: string;
}

interface TypedEvent {
  type: string;
}

export interface WorkflowTransitionOptions<State extends PhasedState, Event extends TypedEvent> {
  definition: GraphDefinition;
  engine: ExecutionEngine;
  state: State;
  event: Event;
  reduce(state: State, event: Event): State;
  ownsState(state: State): boolean;
  onTrace?(trace: GraphTransitionTrace): void;
  onShadowMismatch?(message: string): void;
}

export interface GraphTransitionTrace {
  graphId: string;
  graphVersion: string;
  nodeId: string;
  edge: string;
  nextNodeId: string;
  step: number;
  engine: ExecutionEngine;
}

export async function applyWorkflowTransition<State extends PhasedState, Event extends TypedEvent>(
  options: WorkflowTransitionOptions<State, Event>,
): Promise<State> {
  if (options.engine === "legacy") return options.reduce(options.state, options.event);

  const graph = compileGraph(options.definition);
  const legacyNext = options.reduce(options.state, options.event);
  const matching = (graph.outgoingByNode.get(options.state.phase) ?? []).filter(
    (edge) => edge.event === options.event.type && edge.to === legacyNext.phase,
  );
  if (matching.length !== 1) {
    const mismatch = sanitizedMismatch(graph.definition.id, options.state.phase, options.event.type, legacyNext.phase, matching.length);
    if (options.engine === "graph-shadow") {
      options.onShadowMismatch?.(mismatch);
      return legacyNext;
    }
    throw new Error(mismatch);
  }

  const edge = matching[0]!;
  if (options.engine === "graph-shadow") {
    options.onTrace?.({
      graphId: graph.definition.id,
      graphVersion: graph.definition.version,
      nodeId: options.state.phase,
      edge: edge.guard ?? edge.event,
      nextNodeId: legacyNext.phase,
      step: 1,
      engine: options.engine,
    });
    return legacyNext;
  }

  const cursor: GraphExecutionCursor<State> = {
    graphId: graph.definition.id,
    graphVersion: graph.definition.version,
    nodeId: options.state.phase,
    state: options.state,
    step: 0,
  };
  const handlerName = graph.nodesById.get(cursor.nodeId)?.handler;
  const handlers = new Map(handlerName ? [[handlerName, async () => ({ event: options.event })]] : []);
  const nextCursor = await executeGraphStep(graph, cursor, {
    reduce: options.reduce,
    resolveEdge: () => edge.to,
    stateNode: (state) => state.phase,
    runNode: async (nodeId) => {
      const selectedHandler = graph.nodesById.get(nodeId)?.handler;
      const handler = selectedHandler && handlers.get(selectedHandler);
      if (!handler) throw new Error(`Unregistered node handler: ${selectedHandler ?? nodeId}`);
      return handler();
    },
    isCurrent: (value) => options.ownsState(value.state),
  }, undefined);
  options.onTrace?.({
    graphId: graph.definition.id,
    graphVersion: graph.definition.version,
    nodeId: cursor.nodeId,
    edge: edge.guard ?? edge.event,
    nextNodeId: nextCursor.nodeId,
    step: nextCursor.step,
    engine: options.engine,
  });
  return nextCursor.state;
}

function sanitizedMismatch(graphId: string, from: string, event: string, to: string, count: number): string {
  return `Graph shadow mismatch in ${graphId}: ${from}/${event} -> ${to} matched ${count} edges`;
}
