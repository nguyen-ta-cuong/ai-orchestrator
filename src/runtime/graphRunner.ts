import { createHash } from "node:crypto";
import type { CompiledGraph } from "../core/graph.js";
import {
  applySchedulerEvent,
  assertScheduleValid,
  evaluateExecutionGuard,
  type ArtifactReference,
  type ExecutionLimits,
  type GraphCheckpointRef,
  type GraphEvent,
  type GraphExecutionState,
  type SideEffectExecutionState,
} from "../core/scheduler.js";

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
  usage?: {
    observedCostUsd: number | "unknown";
    inputTokens: number | "unknown";
    outputTokens: number | "unknown";
  };
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

export interface ScheduledSideEffect<Event, Output = unknown> {
  class: SideEffectExecutionState["class"];
  requestRef: string;
  idempotencyKey: string;
  checkpointRef?: GraphCheckpointRef;
  routingDecisionId?: string;
  estimatedUsage?: {
    estimatedCostUsd: number | "unknown";
    inputTokens?: number | "unknown";
    outputTokens?: number | "unknown";
  };
  persistResult(result: Readonly<NodeResult<Event, Output>>): Promise<ArtifactReference>;
  recoverResult(reference: Readonly<ArtifactReference>): Promise<NodeResult<Event, Output>>;
  reconcileIntent?(
    persisted: Readonly<SideEffectExecutionState>,
  ): Promise<
    | { outcome: "succeeded"; resultRef: ArtifactReference; result: NodeResult<Event, Output> }
    | { outcome: "failed" | "unknown" }
  >;
}

export interface ScheduledGraphPersistence {
  checkpoint(
    current: Readonly<GraphExecutionState>,
    event: Readonly<GraphEvent>,
  ): Promise<GraphExecutionState>;
}

export interface ScheduledGraphStepOptions<State, Event, Context, Output = unknown> {
  schedulerState: Readonly<GraphExecutionState>;
  limits: ExecutionLimits;
  unattended: boolean;
  now(): string;
  persistence: ScheduledGraphPersistence;
  prepareSideEffect?(
    nodeId: string,
    state: Readonly<State>,
    context: Context,
  ): Promise<ScheduledSideEffect<Event, Output>> | ScheduledSideEffect<Event, Output>;
  completion?(result: Readonly<NodeResult<Event, Output>>): {
    artifactRefs: ArtifactReference[];
    validatorResult?: GraphEvent["validatorResult"];
  };
}

export interface ScheduledGraphStepResult<State> {
  cursor: GraphExecutionCursor<State>;
  schedulerState: GraphExecutionState;
}

/**
 * Durable additive runner. The caller owns immutable artifact persistence and
 * append-before-snapshot checkpointing; this function owns admission order and
 * refuses to repeat an ambiguous effect.
 */
export async function executeScheduledGraphStep<State, Event, Context, Output = unknown>(
  graph: CompiledGraph,
  cursor: Readonly<GraphExecutionCursor<State>>,
  runtime: GraphRuntime<State, Event, Context>,
  context: Context,
  options: ScheduledGraphStepOptions<State, Event, Context, Output>,
): Promise<ScheduledGraphStepResult<State>> {
  assertCursorMatchesGraph(graph, cursor);
  assertScheduleValid(graph, options.schedulerState);
  if (options.schedulerState.runId !== schedulerRunId(cursor.state)) {
    throw new Error("Scheduled graph cursor and scheduler run identities differ");
  }
  const definition = graph.nodesById.get(cursor.nodeId);
  if (!definition) throw new Error(`Graph cursor references unknown node: ${cursor.nodeId}`);
  if (definition.terminal) throw new Error(`Cannot execute terminal graph node: ${cursor.nodeId}`);
  if (!runtime.isCurrent(cursor, context)) throw new Error(`Stale graph execution cursor at ${cursor.nodeId}`);

  let scheduler = structuredClone(options.schedulerState) as GraphExecutionState;
  const persist = async (event: GraphEvent): Promise<void> => {
    const expected = applySchedulerEvent(graph, scheduler, event);
    const persisted = await options.persistence.checkpoint(scheduler, event);
    assertScheduleValid(graph, persisted);
    if (canonicalJson(persisted) !== canonicalJson(expected)) {
      throw new Error("Scheduled graph persistence returned a checkpoint with unexpected identity");
    }
    scheduler = persisted;
  };

  let node = scheduler.nodeStates[cursor.nodeId]!;
  if (node.status === "ready") {
    requireScheduledGuard(graph, scheduler, options, {
      action: "node", nodeId: cursor.nodeId, nodeAttempts: 1, concurrency: 1,
    });
    await persist(scheduledEvent(scheduler, options.now(), cursor.nodeId, "node-status", {
      priorStatus: "ready",
      nextStatus: "running",
      attempt: node.attempts + 1,
    }));
    node = scheduler.nodeStates[cursor.nodeId]!;
  } else if (node.status !== "running") {
    throw new Error(`Scheduled graph node ${cursor.nodeId} cannot execute from ${node.status}`);
  }

  const effect = definition.sideEffect === "none"
    ? undefined
    : await options.prepareSideEffect?.(cursor.nodeId, cursor.state, context);
  if (definition.sideEffect !== "none" && !effect) {
    throw new Error(`Scheduled graph node ${cursor.nodeId} requires a durable side-effect declaration`);
  }

  let result: NodeResult<Event, Output>;
  if (effect) {
    const currentEffect = node.sideEffect;
    if (currentEffect?.status === "intent_recorded" || currentEffect?.status === "unknown") {
      assertScheduledEffectIdentity(effect, currentEffect);
      if (!effect.reconcileIntent) {
        throw new Error(`Scheduled graph node ${cursor.nodeId} has an ambiguous side effect requiring reconciliation`);
      }
      const reconciled = await effect.reconcileIntent(currentEffect);
      if (reconciled.outcome === "succeeded") {
        await persist(scheduledEffectResult(
          scheduler,
          options.now(),
          cursor.nodeId,
          effect,
          currentEffect.ordinal,
          "succeeded",
          reconciled.resultRef,
          currentEffect.status === "unknown",
          reconciled.result.usage,
        ));
        result = reconciled.result;
      } else {
        if (currentEffect.status === "intent_recorded" || reconciled.outcome === "failed") {
          await persist(scheduledEffectResult(
            scheduler,
            options.now(),
            cursor.nodeId,
            effect,
            currentEffect.ordinal,
            reconciled.outcome,
            undefined,
            currentEffect.status === "unknown",
          ));
        }
        throw new Error(`Scheduled graph node ${cursor.nodeId} side effect reconciled as ${reconciled.outcome}`);
      }
    } else if (currentEffect?.status === "succeeded") {
      assertScheduledEffectIdentity(effect, currentEffect);
      if (!currentEffect.resultRef) throw new Error("Scheduled graph succeeded effect is missing its result reference");
      result = await effect.recoverResult(currentEffect.resultRef);
    } else {
      if (currentEffect?.status === "failed" && currentEffect.idempotencyKey === effect.idempotencyKey) {
        throw new Error("Scheduled graph failed side-effect retry requires a fresh idempotency key");
      }
      const ordinal = node.sideEffectOrdinal + 1;
      if (requiresMutationCheckpoint(effect.class) && !effect.checkpointRef) {
        throw new Error(`Scheduled graph ${effect.class} side effect requires an exact immutable checkpoint`);
      }
      requireScheduledEffectGuard(graph, scheduler, options, cursor.nodeId, effect);
      await persist(scheduledEvent(scheduler, options.now(), cursor.nodeId, "side-effect-intent", {
        priorStatus: "running",
        nextStatus: "running",
        attempt: node.attempts,
        requestRef: effect.requestRef,
        routingDecisionId: effect.routingDecisionId,
        checkpointRef: effect.checkpointRef,
        sideEffect: {
          phase: "intent",
          ordinal,
          idempotencyKey: effect.idempotencyKey,
          class: effect.class,
        },
        reservation: effect.class === "model" ? { modelCalls: 1, providerCalls: 1 } : undefined,
      }));
      node = scheduler.nodeStates[cursor.nodeId]!;
      try {
        result = await runtime.runNode(cursor.nodeId, cursor.state, context) as NodeResult<Event, Output>;
      } catch (error) {
        const outcome = requiresMutationCheckpoint(effect.class) ? "unknown" : "failed";
        await persist(scheduledEffectResult(scheduler, options.now(), cursor.nodeId, effect, ordinal, outcome));
        throw error;
      }
      if (!runtime.isCurrent(cursor, context)) throw new Error(`Graph execution became stale while running ${cursor.nodeId}`);
      const resultRef = await effect.persistResult(result);
      await persist(scheduledEffectResult(
        scheduler,
        options.now(),
        cursor.nodeId,
        effect,
        ordinal,
        "succeeded",
        resultRef,
        false,
        result.usage,
      ));
    }
  } else {
    result = await runtime.runNode(cursor.nodeId, cursor.state, context) as NodeResult<Event, Output>;
    if (!runtime.isCurrent(cursor, context)) throw new Error(`Graph execution became stale while running ${cursor.nodeId}`);
  }

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

  const declaredContracts = definition.outputContracts;
  const completion = options.completion?.(result) ?? { artifactRefs: [] };
  const completionEvent = scheduledEvent(scheduler, options.now(), cursor.nodeId, "node-status", {
    priorStatus: "running",
    nextStatus: graph.definition.kind === "state-machine" ? "blocked" : "executed",
    attempt: scheduler.nodeStates[cursor.nodeId]!.attempts,
    chosenEdge: graph.definition.kind === "state-machine" ? matches[0] : undefined,
    artifactRefs: completion.artifactRefs,
    validatorResult: completion.validatorResult ?? { status: "passed", contracts: [...declaredContracts] },
  });
  const prospective = applySchedulerEvent(graph, scheduler, completionEvent);
  requireScheduledGuard(graph, scheduler, options, {
    action: "transition",
    nodeId: cursor.nodeId,
    additionalReady: Math.max(0, prospective.ready.length - scheduler.ready.length),
    edge: matches[0],
  });
  await persist(completionEvent);

  return {
    cursor: {
      graphId: cursor.graphId,
      graphVersion: cursor.graphVersion,
      nodeId: nextNodeId,
      state: next,
      step: cursor.step + 1,
    },
    schedulerState: scheduler,
  };
}

function schedulerRunId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const runId = (value as { runId?: unknown }).runId;
  return typeof runId === "string" ? runId : undefined;
}

function requireScheduledGuard<State, Event, Context, Output>(
  graph: CompiledGraph,
  scheduler: Readonly<GraphExecutionState>,
  options: ScheduledGraphStepOptions<State, Event, Context, Output>,
  probe: Omit<Parameters<typeof evaluateExecutionGuard>[3], "now" | "unattended">,
): void {
  const decision = evaluateExecutionGuard(graph, scheduler, options.limits, {
    ...probe,
    now: options.now(),
    unattended: options.unattended,
  });
  if (!decision.allowed) throw new Error(`Scheduled graph guard ${decision.code}: ${decision.reason}`);
}

function requireScheduledEffectGuard<State, Event, Context, Output>(
  graph: CompiledGraph,
  scheduler: Readonly<GraphExecutionState>,
  options: ScheduledGraphStepOptions<State, Event, Context, Output>,
  nodeId: string,
  effect: Readonly<ScheduledSideEffect<Event, Output>>,
): void {
  if (effect.class === "model") {
    const usage = effect.estimatedUsage ?? {
      estimatedCostUsd: "unknown", inputTokens: "unknown", outputTokens: "unknown",
    };
    requireScheduledGuard(graph, scheduler, options, {
      action: "model", nodeId, nodeAttempts: 0, concurrency: 0, modelCalls: 1, providerCalls: 1,
      sideEffectAttempts: 1,
      estimatedCostUsd: usage.estimatedCostUsd ?? "unknown",
      observedCostUsd: "unknown",
      inputTokens: usage.inputTokens ?? "unknown",
      outputTokens: usage.outputTokens ?? "unknown",
    });
    return;
  }
  requireScheduledGuard(graph, scheduler, options, {
    action: "side_effect", nodeId, nodeAttempts: 0, concurrency: 0,
    sideEffectAttempts: 1, sideEffectClass: effect.class,
  });
}

function scheduledEvent(
  state: Readonly<GraphExecutionState>,
  timestamp: string,
  nodeId: string,
  kind: GraphEvent["kind"],
  patch: Partial<GraphEvent>,
): GraphEvent {
  const sequence = state.lastAppliedEventSequence + 1;
  const eventId = `runner-${createHash("sha256").update(JSON.stringify({
    runId: state.runId, sequence, nodeId, kind, patch,
  })).digest("hex").slice(0, 32)}`;
  return {
    schemaVersion: 1,
    kind,
    sequence,
    eventId,
    runId: state.runId,
    graphId: state.graphId,
    graphVersion: state.graphVersion,
    graphDigest: state.graphDigest,
    planVersion: state.planVersion,
    nodeId,
    priorStatus: state.nodeStates[nodeId]!.status,
    nextStatus: state.nodeStates[nodeId]!.status,
    attempt: state.nodeStates[nodeId]!.attempts,
    timestamp,
    artifactRefs: [],
    ...patch,
  };
}

function scheduledEffectResult<Event, Output>(
  state: Readonly<GraphExecutionState>,
  timestamp: string,
  nodeId: string,
  effect: Readonly<ScheduledSideEffect<Event, Output>>,
  ordinal: number,
  outcome: "succeeded" | "failed" | "unknown",
  resultRef?: ArtifactReference,
  reconciliation = false,
  actualUsage?: Readonly<NonNullable<NodeResult<Event, Output>["usage"]>>,
): GraphEvent {
  const estimate = effect.estimatedUsage;
  return scheduledEvent(state, timestamp, nodeId, "side-effect-result", {
    priorStatus: "running",
    nextStatus: "running",
    attempt: state.nodeStates[nodeId]!.attempts,
    requestRef: effect.requestRef,
    routingDecisionId: effect.routingDecisionId,
    checkpointRef: effect.checkpointRef,
    sideEffect: {
      phase: "result",
      ordinal,
      idempotencyKey: effect.idempotencyKey,
      class: effect.class,
      outcome,
      ...(reconciliation ? { reconciliation: true } : {}),
      ...(resultRef ? { resultRef } : {}),
    },
    ...(effect.class === "model" && !reconciliation ? {
      reservation: { modelCalls: -1, providerCalls: -1 },
      usage: {
        estimatedCostUsd: estimate?.estimatedCostUsd ?? "unknown",
        observedCostUsd: actualUsage?.observedCostUsd ?? "unknown",
        inputTokens: actualUsage?.inputTokens ?? "unknown",
        outputTokens: actualUsage?.outputTokens ?? "unknown",
      },
    } : {}),
  });
}

function requiresMutationCheckpoint(effectClass: SideEffectExecutionState["class"]): boolean {
  return effectClass === "model" || effectClass === "write" || effectClass === "external" || effectClass === "irreversible";
}

function assertScheduledEffectIdentity<Event, Output>(
  prepared: Readonly<ScheduledSideEffect<Event, Output>>,
  persisted: Readonly<SideEffectExecutionState>,
): void {
  if (prepared.class !== persisted.class || prepared.requestRef !== persisted.requestRef ||
      prepared.idempotencyKey !== persisted.idempotencyKey ||
      prepared.routingDecisionId !== persisted.routingDecisionId ||
      !sameCheckpointReference(prepared.checkpointRef, persisted.checkpointRef)) {
    throw new Error("Prepared scheduled side effect does not match its persisted identity");
  }
}

function sameCheckpointReference(
  left: Readonly<GraphCheckpointRef> | undefined,
  right: Readonly<GraphCheckpointRef> | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.path === right.path && left.sha256 === right.sha256 && left.sizeBytes === right.sizeBytes;
}

function canonicalJson(value: unknown): string {
  const json = JSON.stringify(canonicalValue(value));
  if (json === undefined) throw new Error("Cannot canonicalize an undefined scheduled checkpoint");
  return json;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => item === undefined ? null : canonicalValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  return value;
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
