import { createHash } from "node:crypto";
import type { CompiledGraph, GraphEdgeDefinition } from "./graph.js";

export type NodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "waiting_human"
  | "blocked"
  | "executed"
  | "failed_retryable"
  | "failed"
  | "cancelled"
  | "skipped";

export interface ArtifactReference {
  planVersion: number;
  nodeId: string;
  contract: string;
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface StructuredNodeError {
  category: string;
  retryable: boolean;
  attempt: number;
  recordedAt: string;
}

export interface SideEffectExecutionState {
  visit: number;
  attempt: number;
  idempotencyKey: string;
  class: "model" | "tool" | "write" | "external" | "irreversible";
  status: "intent_recorded" | "succeeded" | "failed" | "unknown";
  requestRef: string;
  outcome?: "succeeded" | "failed" | "unknown";
  resultRef?: ArtifactReference;
}

export interface NodeExecutionState {
  nodeId: string;
  status: NodeStatus;
  visits: number;
  attempts: number;
  retryAttempts: number;
  startedAt?: string;
  completedAt?: string;
  outputRefs: ArtifactReference[];
  idempotencyKey?: string;
  sideEffect?: SideEffectExecutionState;
  lastError?: StructuredNodeError;
}

export interface ExecutionGuardState {
  startedAt: string;
  steps: number;
  runningNodes: string[];
  modelCallsInFlight: number;
  providerCallsInFlight: number;
  estimatedCostUsd: number | "unknown";
  observedCostUsd: number | "unknown";
  inputTokens: number | "unknown";
  outputTokens: number | "unknown";
  sideEffectAttempts: number;
  humanWaitStartedAt?: string;
  noProgressFingerprint?: string;
  noProgressRepeats: number;
  backEdgeRemaining: Record<string, number>;
}

export interface GraphExecutionState {
  schemaVersion: 2;
  runId: string;
  graphId: string;
  graphVersion: string;
  graphDigest: string;
  planVersion: number;
  revision: number;
  lastAppliedEventSequence: number;
  lastAppliedEventId?: string;
  lastAppliedEventHash?: string;
  recentEventIds: string[];
  nodeStates: Record<string, NodeExecutionState>;
  ready: string[];
  schedulerMetadata: SchedulerMetadata;
  metadataFingerprint: string;
  effectiveLimits: ExecutionLimits;
  limitsFingerprint: string;
  guard: ExecutionGuardState;
}

export interface SchedulerMetadata {
  /** Higher numeric values run first; ties are ordered by node id. */
  priorities?: Readonly<Record<string, number>>;
}

export function schedulerMetadataFingerprint(metadata: SchedulerMetadata): string {
  assertSchedulerMetadataShape(metadata);
  return sha256(canonicalJson(normalizeSchedulerMetadata(metadata)));
}

export interface ExecutionLimits {
  maxGraphSteps: number;
  maxNodeAttempts: number;
  maxPlanVersions: number;
  maxGraphNodes: number;
  maxGraphEdges: number;
  maxReadyWidth: number;
  maxConcurrency: number;
  maxModelConcurrency: number;
  maxProviderConcurrency: number;
  maxWallTimeMs: number;
  maxEstimatedCostUsd: number;
  maxObservedCostUsd: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxSideEffectAttempts: number;
  humanWait: "allow" | "deny";
  maxHumanWaitMs: number;
  maxNoProgressRepeats: number;
  backEdgeBudgets: Readonly<Record<string, number>>;
}

export const DEFAULT_EXECUTION_LIMITS: Readonly<ExecutionLimits> = Object.freeze({
  maxGraphSteps: 256,
  maxNodeAttempts: 4,
  maxPlanVersions: 3,
  maxGraphNodes: 256,
  maxGraphEdges: 1_024,
  maxReadyWidth: 32,
  maxConcurrency: 8,
  maxModelConcurrency: 4,
  maxProviderConcurrency: 4,
  maxWallTimeMs: 24 * 60 * 60 * 1_000,
  maxEstimatedCostUsd: 100,
  maxObservedCostUsd: 100,
  maxInputTokens: 10_000_000,
  maxOutputTokens: 2_000_000,
  maxSideEffectAttempts: 32,
  humanWait: "allow",
  maxHumanWaitMs: 7 * 24 * 60 * 60 * 1_000,
  maxNoProgressRepeats: 3,
  backEdgeBudgets: Object.freeze({ "run-transition-budget": 256 }),
});

export function graphDefinitionDigest(graph: CompiledGraph): string {
  return sha256(canonicalJson(graph.definition));
}

export function executionLimitsFingerprint(limits: ExecutionLimits): string {
  assertExecutionLimitsValid(limits);
  return sha256(canonicalJson(limits));
}

export type GraphEventKind = "node-status" | "side-effect-intent" | "side-effect-result" | "progress";

export interface GraphEventEdge {
  from: string;
  to: string;
  event: string;
  guard?: string;
  boundedBy?: string;
}

export interface GraphEvent {
  schemaVersion: 1;
  kind: GraphEventKind;
  sequence: number;
  eventId: string;
  requestRef?: string;
  runId: string;
  graphId: string;
  graphVersion: string;
  graphDigest: string;
  planVersion: number;
  nodeId: string;
  priorStatus: NodeStatus;
  nextStatus: NodeStatus;
  chosenEdge?: GraphEventEdge;
  attempt: number;
  timestamp: string;
  errorCategory?: string;
  validatorResult?: {
    status: "passed" | "failed" | "not_run";
    contracts: string[];
  };
  artifactRefs: ArtifactReference[];
  routingDecisionId?: string;
  recoveryLevel?: "retry" | "repair" | "replan";
  progressFingerprint?: string;
  sideEffect?: {
    phase: "intent" | "result";
    idempotencyKey: string;
    class: "model" | "tool" | "write" | "external" | "irreversible";
    outcome?: "succeeded" | "failed" | "unknown";
    resultRef?: ArtifactReference;
  };
  usage?: {
    estimatedCostUsd?: number | "unknown";
    observedCostUsd?: number | "unknown";
    inputTokens?: number | "unknown";
    outputTokens?: number | "unknown";
  };
  reservation?: {
    modelCalls: -1 | 0 | 1;
    providerCalls: -1 | 0 | 1;
  };
}

export type GuardAction = "node" | "model" | "side_effect" | "human_wait" | "transition" | "plan_version";

export interface ExecutionGuardProbe {
  action: GuardAction;
  nodeId?: string;
  nodeAttempts?: 0 | 1;
  now: string;
  unattended: boolean;
  additionalReady?: number;
  concurrency?: number;
  modelCalls?: number;
  providerCalls?: number;
  estimatedCostUsd?: number | "unknown";
  observedCostUsd?: number | "unknown";
  inputTokens?: number | "unknown";
  outputTokens?: number | "unknown";
  sideEffectAttempts?: number;
  sideEffectClass?: SideEffectExecutionState["class"];
  edge?: GraphEventEdge;
}

export interface ExecutionGuardDecision {
  allowed: boolean;
  code?: string;
  reason?: string;
}

const NODE_STATUSES = new Set<NodeStatus>([
  "pending", "ready", "running", "waiting_human", "blocked", "executed", "failed_retryable", "failed", "cancelled", "skipped",
]);
const TERMINAL_STATUSES = new Set<NodeStatus>(["executed", "failed", "cancelled", "skipped"]);
const EVENT_KINDS = new Set<GraphEventKind>(["node-status", "side-effect-intent", "side-effect-result", "progress"]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const FINGERPRINT = /^[a-f0-9]{16,64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_RECENT_EVENT_IDS = 8_192;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

const ALLOWED_STATUS_TRANSITIONS: Readonly<Record<NodeStatus, ReadonlySet<NodeStatus>>> = {
  pending: new Set(["cancelled", "skipped"]),
  ready: new Set(["running", "waiting_human", "cancelled", "skipped"]),
  running: new Set(["blocked", "executed", "failed_retryable", "failed", "cancelled"]),
  waiting_human: new Set(["blocked", "executed", "failed", "cancelled"]),
  blocked: new Set(["cancelled", "skipped"]),
  executed: new Set(),
  failed_retryable: new Set(["ready", "failed", "cancelled"]),
  failed: new Set(),
  cancelled: new Set(),
  skipped: new Set(),
};

export function createGraphExecutionState(
  graph: CompiledGraph,
  options: {
    runId: string;
    now: string;
    limits: ExecutionLimits;
    planVersion?: number;
    currentNodeId?: string;
    metadata?: SchedulerMetadata;
  },
): GraphExecutionState {
  assertToken(options.runId, "run id");
  assertIsoTimestamp(options.now, "scheduler start timestamp");
  assertExecutionLimitsValid(options.limits);
  assertGraphWithinLimits(graph, options.limits);
  const planVersion = options.planVersion ?? 1;
  assertPositiveInteger(planVersion, "plan version");
  const currentNodeId = options.currentNodeId ?? graph.definition.entry;
  const current = graph.nodesById.get(currentNodeId);
  if (!current) throw new Error(`Scheduler current node does not exist: ${currentNodeId}`);
  const effectiveLimits = cloneExecutionLimits(options.limits);
  const schedulerMetadata = normalizeSchedulerMetadata(options.metadata ?? {});

  const nodeStates = Object.fromEntries(graph.definition.nodes.map((node) => [
    node.id,
    {
      nodeId: node.id,
      status: node.id === currentNodeId ? (node.terminal ? "executed" : "ready") : "pending",
      visits: node.id === currentNodeId ? 1 : 0,
      attempts: 0,
      retryAttempts: 0,
      outputRefs: [],
    } satisfies NodeExecutionState,
  ]));
  const backEdgeRemaining = requiredBackEdgeBudgets(graph, options.limits);
  const state: GraphExecutionState = {
    schemaVersion: 2,
    runId: options.runId,
    graphId: graph.definition.id,
    graphVersion: graph.definition.version,
    graphDigest: graphDefinitionDigest(graph),
    planVersion,
    revision: 0,
    lastAppliedEventSequence: 0,
    recentEventIds: [],
    nodeStates,
    ready: current.terminal ? [] : [currentNodeId],
    schedulerMetadata,
    metadataFingerprint: schedulerMetadataFingerprint(schedulerMetadata),
    effectiveLimits,
    limitsFingerprint: executionLimitsFingerprint(effectiveLimits),
    guard: {
      startedAt: options.now,
      steps: 0,
      runningNodes: [],
      modelCallsInFlight: 0,
      providerCallsInFlight: 0,
      estimatedCostUsd: 0,
      observedCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      sideEffectAttempts: 0,
      noProgressRepeats: 0,
      backEdgeRemaining,
    },
  };
  assertScheduleValid(graph, state);
  return state;
}

export function computeReadySet(
  graph: CompiledGraph,
  state: Readonly<GraphExecutionState>,
  metadata?: SchedulerMetadata,
): string[] {
  const effectiveMetadata = resolveSchedulerMetadata(graph, state, metadata);
  const candidates = graph.definition.kind === "state-machine"
    ? Object.values(state.nodeStates).filter((node) => node.status === "ready").map((node) => node.nodeId)
    : graph.definition.nodes.filter((node) => dagNodeIsReady(graph, state, node.id)).map((node) => node.id);
  return [...new Set(candidates)].sort((left, right) => comparePriority(left, right, effectiveMetadata));
}

export function applySchedulerEvent(
  graph: CompiledGraph,
  state: Readonly<GraphExecutionState>,
  event: Readonly<GraphEvent>,
  metadata?: SchedulerMetadata,
): GraphExecutionState {
  assertScheduleValid(graph, state, metadata);
  assertGraphEventValid(event);
  assertEventIdentity(state, event);
  const eventHash = graphEventHash(event);
  if (event.sequence === state.lastAppliedEventSequence) {
    if (event.eventId === state.lastAppliedEventId && eventHash === state.lastAppliedEventHash) return cloneExecutionState(state);
    throw new Error(`Graph event has conflicting duplicate sequence ${event.sequence}`);
  }
  if (event.sequence !== state.lastAppliedEventSequence + 1) {
    throw new Error(`Graph event sequence ${event.sequence} is out of order; expected ${state.lastAppliedEventSequence + 1}`);
  }
  if (state.recentEventIds.includes(event.eventId)) throw new Error(`Duplicate graph event id: ${event.eventId}`);

  const next = cloneExecutionState(state);
  const node = next.nodeStates[event.nodeId]!;
  if (node.status !== event.priorStatus) {
    throw new Error(`Graph event prior status ${event.priorStatus} does not match ${event.nodeId} status ${node.status}`);
  }
  if (TERMINAL_STATUSES.has(node.status)) throw new Error(`Node status ${node.status} is absorbing for ${event.nodeId}`);

  if (event.kind === "node-status") applyNodeStatusEvent(graph, next, node, event);
  else applyObservationEvent(graph, next, node, event);

  applyUsage(next.guard, event.usage);
  applyReservation(next.guard, event.reservation);
  applyProgress(next.guard, event.progressFingerprint);
  next.guard.runningNodes = Object.values(next.nodeStates)
    .filter((candidate) => candidate.status === "running")
    .map((candidate) => candidate.nodeId)
    .sort();
  const waiting = Object.values(next.nodeStates).find((candidate) => candidate.status === "waiting_human");
  if (waiting && next.guard.humanWaitStartedAt === undefined) next.guard.humanWaitStartedAt = event.timestamp;
  if (!waiting) delete next.guard.humanWaitStartedAt;

  activateDagReadyNodes(graph, next, metadata);
  next.ready = computeReadySet(graph, next, metadata);
  next.lastAppliedEventSequence = event.sequence;
  next.lastAppliedEventId = event.eventId;
  next.lastAppliedEventHash = eventHash;
  next.revision += 1;
  next.recentEventIds = [...next.recentEventIds, event.eventId];
  assertScheduleValid(graph, next, metadata);
  return next;
}

export function evaluateExecutionGuard(
  graph: CompiledGraph,
  state: Readonly<GraphExecutionState>,
  limits: ExecutionLimits,
  probe: ExecutionGuardProbe,
): ExecutionGuardDecision {
  try {
    assertExecutionLimitsValid(limits);
  } catch (error) {
    return denied("invalid-budget-data", errorMessage(error));
  }
  if (executionLimitsFingerprint(limits) !== state.limitsFingerprint ||
      executionLimitsFingerprint(state.effectiveLimits) !== state.limitsFingerprint) {
    return denied("execution-limits-mismatch", "effective execution limits do not match the frozen run policy");
  }
  try {
    assertGuardProbeValid(graph, state, probe);
  } catch (error) {
    return denied("invalid-guard-probe", errorMessage(error));
  }
  if (probe.action === "node" && state.guard.steps + (probe.nodeAttempts ?? 0) > limits.maxGraphSteps) {
    return denied("graph-step-limit", "maximum graph steps reached");
  }
  if (probe.action === "node" && probe.nodeId &&
      (state.nodeStates[probe.nodeId]?.attempts ?? 0) + (probe.nodeAttempts ?? 0) > limits.maxNodeAttempts) {
    return denied("node-attempt-limit", `maximum attempts reached for ${probe.nodeId}`);
  }
  if (state.planVersion > limits.maxPlanVersions || (probe.action === "plan_version" && state.planVersion >= limits.maxPlanVersions)) {
    return denied("plan-version-limit", "maximum plan versions reached");
  }
  if (graph.definition.nodes.length > limits.maxGraphNodes) return denied("graph-node-limit", "graph node limit exceeded");
  if (graph.definition.edges.length > limits.maxGraphEdges) return denied("graph-edge-limit", "graph edge limit exceeded");
  if (state.ready.length + (probe.additionalReady ?? 0) > limits.maxReadyWidth) return denied("ready-width-limit", "ready-set width exceeded");
  if (state.guard.runningNodes.length + (probe.concurrency ?? 0) > limits.maxConcurrency) return denied("concurrency-limit", "graph concurrency exceeded");
  if (state.guard.modelCallsInFlight + (probe.modelCalls ?? 0) > limits.maxModelConcurrency) return denied("model-concurrency-limit", "model concurrency exceeded");
  if (state.guard.providerCallsInFlight + (probe.providerCalls ?? 0) > limits.maxProviderConcurrency) return denied("provider-concurrency-limit", "provider concurrency exceeded");
  if (Date.parse(probe.now) - Date.parse(state.guard.startedAt) >= limits.maxWallTimeMs) return denied("wall-time-limit", "maximum graph wall time reached");

  const unknown = firstUnknownUsage(state.guard, probe);
  if (probe.unattended && unknown) return denied("unknown-budget-data", `${unknown} is unknown in unattended execution`);
  const estimated = sumUsage(state.guard.estimatedCostUsd, probe.estimatedCostUsd);
  if (estimated !== "unknown" && estimated > limits.maxEstimatedCostUsd) return denied("estimated-cost-limit", "estimated cost ceiling reached");
  const observed = sumUsage(state.guard.observedCostUsd, probe.observedCostUsd);
  if (observed !== "unknown" && observed >= limits.maxObservedCostUsd) return denied("observed-cost-limit", "observed cost ceiling reached");
  const inputTokens = sumUsage(state.guard.inputTokens, probe.inputTokens);
  if (inputTokens !== "unknown" && inputTokens >= limits.maxInputTokens) return denied("input-token-limit", "input token ceiling reached");
  const outputTokens = sumUsage(state.guard.outputTokens, probe.outputTokens);
  if (outputTokens !== "unknown" && outputTokens >= limits.maxOutputTokens) return denied("output-token-limit", "output token ceiling reached");
  if (state.guard.sideEffectAttempts + (probe.sideEffectAttempts ?? 0) > limits.maxSideEffectAttempts) {
    return denied("side-effect-limit", "side-effect attempt ceiling reached");
  }
  if (probe.action === "human_wait" && limits.humanWait === "deny") return denied("human-wait-denied", "human waiting is disabled");
  if (state.guard.humanWaitStartedAt && Date.parse(probe.now) - Date.parse(state.guard.humanWaitStartedAt) >= limits.maxHumanWaitMs) {
    return denied("human-wait-timeout", "human wait duration exceeded");
  }
  if (state.guard.noProgressRepeats >= limits.maxNoProgressRepeats) return denied("no-progress-limit", "repeated no-progress fingerprint limit reached");
  if (probe.edge?.boundedBy) {
    const remaining = state.guard.backEdgeRemaining[probe.edge.boundedBy];
    if (!Number.isInteger(remaining) || remaining <= 0) return denied("back-edge-budget", `back-edge budget ${probe.edge.boundedBy} is exhausted`);
  }
  return { allowed: true };
}

export function assertScheduleValid(
  graph: CompiledGraph,
  state: Readonly<GraphExecutionState>,
  metadata?: SchedulerMetadata,
): void {
  const effectiveMetadata = resolveSchedulerMetadata(graph, state, metadata);
  if (state.schemaVersion !== 2) throw new Error(`Unsupported scheduler schema version: ${String(state.schemaVersion)}`);
  assertToken(state.runId, "scheduler run id");
  if (state.graphId !== graph.definition.id) throw new Error(`Scheduler graph id ${state.graphId} does not match ${graph.definition.id}`);
  if (state.graphVersion !== graph.definition.version) throw new Error(`Scheduler graph version ${state.graphVersion} does not match ${graph.definition.version}`);
  if (state.graphDigest !== graphDefinitionDigest(graph)) throw new Error("Scheduler graph digest does not match the compiled graph");
  assertPositiveInteger(state.planVersion, "scheduler plan version");
  assertNonNegativeInteger(state.revision, "scheduler revision");
  assertNonNegativeInteger(state.lastAppliedEventSequence, "last applied event sequence");
  if (state.revision !== state.lastAppliedEventSequence) throw new Error("Scheduler revision must equal its last applied event sequence");
  if (state.lastAppliedEventSequence === 0) {
    if (state.lastAppliedEventId !== undefined || state.lastAppliedEventHash !== undefined) throw new Error("Initial scheduler state cannot have last-event identity");
  } else {
    assertToken(state.lastAppliedEventId, "last applied event id");
    if (typeof state.lastAppliedEventHash !== "string" || !SHA256.test(state.lastAppliedEventHash)) throw new Error("Scheduler last event hash is invalid");
  }
  assertExecutionLimitsValid(state.effectiveLimits);
  if (executionLimitsFingerprint(state.effectiveLimits) !== state.limitsFingerprint) throw new Error("Scheduler execution limits fingerprint is invalid");

  const expectedIds = graph.definition.nodes.map((node) => node.id).sort();
  const actualIds = Object.keys(state.nodeStates).sort();
  if (!sameStrings(expectedIds, actualIds)) throw new Error("Scheduler node states do not match graph nodes");
  for (const id of expectedIds) assertNodeStateValid(graph, state, state.nodeStates[id]!);
  if (new Set(state.ready).size !== state.ready.length) throw new Error("Scheduler ready set contains duplicates");
  if (state.ready.length > state.effectiveLimits.maxReadyWidth) throw new Error("Scheduler ready set exceeds its frozen width limit");
  const active = Object.values(state.nodeStates).filter((node) =>
    node.status === "ready" || node.status === "running" || node.status === "waiting_human");
  if (graph.definition.kind === "state-machine" && active.length > 1) throw new Error("State-machine scheduler allows at most one active node");
  for (const id of state.ready) {
    if (state.nodeStates[id]?.status !== "ready") throw new Error(`Scheduler ready node ${id} is not in ready status`);
    if (graph.definition.kind === "dag") assertDagReadyInputProvenance(graph, state, id);
  }
  const expectedReady = computeReadySet(graph, state, effectiveMetadata);
  if (!sameStrings(state.ready, expectedReady)) throw new Error(`Scheduler ready order is invalid; expected ${expectedReady.join(", ")}`);

  assertGuardStateValid(graph, state.guard);
  const running = Object.values(state.nodeStates).filter((node) => node.status === "running").map((node) => node.nodeId).sort();
  if (!sameStrings(running, state.guard.runningNodes)) throw new Error("Scheduler running-node guard state is inconsistent");
  if (state.recentEventIds.length > MAX_RECENT_EVENT_IDS || new Set(state.recentEventIds).size !== state.recentEventIds.length) {
    throw new Error("Scheduler recent event ids are invalid");
  }
  if (state.recentEventIds.length !== state.lastAppliedEventSequence) throw new Error("Scheduler event id history does not match its applied sequence");
  if (state.lastAppliedEventSequence > 0 && state.recentEventIds.at(-1) !== state.lastAppliedEventId) {
    throw new Error("Scheduler last event id tail is inconsistent");
  }
  state.recentEventIds.forEach((id) => assertToken(id, "recent event id"));
}

export function assertGraphEventValid(value: unknown): asserts value is GraphEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Graph event must be an object");
  const event = value as Record<string, unknown>;
  assertOnlyKeys(event, [
    "schemaVersion", "kind", "sequence", "eventId", "requestRef", "runId", "graphId", "graphVersion", "graphDigest", "planVersion",
    "nodeId", "priorStatus", "nextStatus", "chosenEdge", "attempt", "timestamp", "errorCategory", "validatorResult",
    "artifactRefs", "routingDecisionId", "recoveryLevel", "progressFingerprint", "sideEffect", "usage", "reservation",
  ], "graph event");
  if (event.schemaVersion !== 1) throw new Error(`Unsupported graph event schema version: ${String(event.schemaVersion)}`);
  if (!EVENT_KINDS.has(event.kind as GraphEventKind)) throw new Error(`Invalid graph event kind: ${String(event.kind)}`);
  assertPositiveInteger(event.sequence, "graph event sequence");
  assertToken(event.eventId, "graph event id");
  if (event.requestRef !== undefined && (typeof event.requestRef !== "string" || !SHA256.test(event.requestRef))) {
    throw new Error("Graph event requestRef must be a SHA-256 hash");
  }
  for (const [field, label] of [["runId", "run id"], ["graphId", "graph id"], ["graphVersion", "graph version"], ["nodeId", "node id"]] as const) {
    assertToken(event[field], `graph event ${label}`);
  }
  if (typeof event.graphDigest !== "string" || !SHA256.test(event.graphDigest)) throw new Error("Graph event digest must be a SHA-256 hash");
  assertPositiveInteger(event.planVersion, "graph event plan version");
  if (!NODE_STATUSES.has(event.priorStatus as NodeStatus) || !NODE_STATUSES.has(event.nextStatus as NodeStatus)) {
    throw new Error("Graph event contains an invalid node status");
  }
  assertNonNegativeInteger(event.attempt, "graph event attempt");
  assertIsoTimestamp(event.timestamp, "graph event timestamp");
  if (event.errorCategory !== undefined) assertToken(event.errorCategory, "graph event error category");
  if (event.routingDecisionId !== undefined) assertToken(event.routingDecisionId, "routing decision id");
  if (event.recoveryLevel !== undefined && event.recoveryLevel !== "retry" && event.recoveryLevel !== "repair" && event.recoveryLevel !== "replan") {
    throw new Error("Graph event recovery level is invalid");
  }
  if (event.progressFingerprint !== undefined && (typeof event.progressFingerprint !== "string" || !FINGERPRINT.test(event.progressFingerprint))) {
    throw new Error("Graph event progress fingerprint is invalid");
  }
  if (!Array.isArray(event.artifactRefs)) throw new Error("Graph event artifactRefs must be an array");
  event.artifactRefs.forEach((reference) => assertArtifactReferenceShape(reference));
  if (event.chosenEdge !== undefined) assertEventEdge(event.chosenEdge);
  if (event.validatorResult !== undefined) assertValidatorResult(event.validatorResult);
  if (event.sideEffect !== undefined) assertSideEffect(event.sideEffect);
  if (event.usage !== undefined) assertUsage(event.usage);
  if (event.reservation !== undefined) assertReservation(event.reservation);
  assertGraphEventKindFields(event as unknown as GraphEvent);
}

export function graphEventDigest(event: Readonly<GraphEvent>): string {
  assertGraphEventValid(event);
  return graphEventHash(event);
}

function assertGraphEventKindFields(event: Readonly<GraphEvent>): void {
  if (event.kind === "node-status") {
    assertFieldsAbsent(event, ["requestRef", "progressFingerprint", "sideEffect", "usage", "reservation"], "Node-status event");
    const completion = event.nextStatus === "executed" || event.nextStatus === "blocked";
    if (!completion && (event.artifactRefs.length > 0 || event.validatorResult !== undefined)) {
      throw new Error("Non-completion node-status event cannot carry completion fields");
    }
    if (event.nextStatus === "cancelled" && event.chosenEdge !== undefined) {
      throw new Error("A cancelled node-status event cannot carry a chosen edge");
    }
    if (event.nextStatus !== "blocked" && event.chosenEdge !== undefined) {
      throw new Error(`Node-status ${event.nextStatus} cannot carry a chosen edge`);
    }
    return;
  }

  if (event.priorStatus !== "running" || event.nextStatus !== "running") {
    throw new Error(`${event.kind} event requires a running node without changing status`);
  }
  if (event.artifactRefs.length > 0) throw new Error(`${event.kind} event cannot carry completion artifact references`);
  assertFieldsAbsent(event, ["chosenEdge", "errorCategory", "validatorResult", "routingDecisionId", "recoveryLevel"], `${event.kind} event`);

  if (event.kind === "progress") {
    assertFieldsAbsent(event, ["requestRef", "sideEffect", "usage", "reservation"], "Progress event");
    if (event.progressFingerprint === undefined) throw new Error("Progress event requires a fingerprint");
    return;
  }

  if (event.progressFingerprint !== undefined) throw new Error(`${event.kind} event cannot carry a progress fingerprint`);
  if (!event.requestRef || !event.sideEffect) throw new Error(`${event.kind} event requires requestRef and side-effect data`);
  const expectedRequestRef = sha256(event.sideEffect.idempotencyKey);
  if (event.requestRef !== expectedRequestRef) throw new Error(`${event.kind} event requestRef does not match its idempotency key`);
  if (event.kind === "side-effect-intent") {
    if (event.sideEffect.phase !== "intent") throw new Error("Side-effect intent event requires an intent payload");
    if (event.sideEffect.outcome !== undefined || event.sideEffect.resultRef !== undefined) {
      throw new Error("Side-effect intent cannot carry an outcome or result reference");
    }
    if (event.usage !== undefined) throw new Error("Side-effect intent cannot carry observed usage");
    if (event.reservation && (event.reservation.modelCalls < 0 || event.reservation.providerCalls < 0)) {
      throw new Error("Side-effect intent cannot release concurrency reservations");
    }
    return;
  }
  if (event.sideEffect.phase !== "result") throw new Error("Side-effect result event requires a result payload");
  if (event.sideEffect.outcome === undefined) throw new Error("Side-effect result requires a structured outcome");
  if (event.sideEffect.outcome === "succeeded" && event.sideEffect.resultRef === undefined) {
    throw new Error("Successful side-effect result requires an artifact reference");
  }
  if (event.reservation && (event.reservation.modelCalls > 0 || event.reservation.providerCalls > 0)) {
    throw new Error("Side-effect result cannot acquire concurrency reservations");
  }
}

function assertFieldsAbsent(event: Readonly<GraphEvent>, fields: readonly (keyof GraphEvent)[], label: string): void {
  const present = fields.filter((field) => event[field] !== undefined);
  if (present.length > 0) throw new Error(`${label} contains unrelated fields: ${present.join(", ")}`);
}

function applyNodeStatusEvent(
  graph: CompiledGraph,
  state: GraphExecutionState,
  node: NodeExecutionState,
  event: Readonly<GraphEvent>,
): void {
  if (!ALLOWED_STATUS_TRANSITIONS[node.status].has(event.nextStatus)) {
    throw new Error(`Invalid scheduler status transition ${node.status} -> ${event.nextStatus} for ${node.nodeId}`);
  }
  if (graph.definition.kind === "state-machine" && event.nextStatus === "blocked" && event.chosenEdge === undefined) {
    throw new Error("A completed state-machine transition requires one chosen edge");
  }
  if (graph.definition.kind === "dag" && event.chosenEdge !== undefined) throw new Error("DAG node events cannot carry a chosen edge");
  if (event.nextStatus === "running") {
    if (event.attempt !== node.attempts + 1) throw new Error(`Running attempt for ${node.nodeId} must increment by one`);
    node.attempts = event.attempt;
    node.startedAt = event.timestamp;
    delete node.completedAt;
    delete node.lastError;
    node.outputRefs = [];
    state.guard.steps += 1;
  } else if (node.status === "failed_retryable" && event.nextStatus === "ready") {
    const retryBudget = graph.nodesById.get(node.nodeId)!.retryBudget;
    if (node.retryAttempts >= retryBudget) throw new Error(`Node ${node.nodeId} retry budget is exhausted`);
    node.retryAttempts += 1;
    delete node.startedAt;
    delete node.completedAt;
    node.outputRefs = [];
  } else if (event.attempt !== node.attempts) {
    throw new Error(`Graph event attempt ${event.attempt} does not match ${node.nodeId} attempts ${node.attempts}`);
  }

  assertEventArtifacts(graph, event);
  assertCompletionContracts(graph, event);
  node.status = event.nextStatus;
  if (event.artifactRefs.length > 0) node.outputRefs = event.artifactRefs.map(cloneArtifactReference);
  if (event.errorCategory) {
    node.lastError = {
      category: event.errorCategory,
      retryable: event.nextStatus === "failed_retryable",
      attempt: event.attempt,
      recordedAt: event.timestamp,
    };
  }
  if (event.nextStatus === "blocked" || TERMINAL_STATUSES.has(event.nextStatus)) node.completedAt = event.timestamp;
  if (event.chosenEdge) applyChosenEdge(graph, state, event);
}

function applyObservationEvent(
  graph: CompiledGraph,
  state: GraphExecutionState,
  node: NodeExecutionState,
  event: Readonly<GraphEvent>,
): void {
  if (event.priorStatus !== event.nextStatus) throw new Error(`${event.kind} event cannot change node status`);
  if (event.attempt !== node.attempts) throw new Error(`${event.kind} event attempt does not match node attempts`);
  assertEventArtifacts(graph, event);
  if (event.kind === "side-effect-intent") {
    if (event.sideEffect?.phase !== "intent") throw new Error("Side-effect intent event requires an intent payload");
    assertSideEffectPermitted(graph, node.nodeId, event.sideEffect.class);
    if (node.sideEffect?.visit === node.visits && node.sideEffect.attempt === node.attempts) {
      throw new Error(`Node ${node.nodeId} side-effect intent already recorded for this attempt`);
    }
    if (node.sideEffect?.visit === node.visits && node.sideEffect.idempotencyKey !== event.sideEffect.idempotencyKey) {
      throw new Error(`Node ${node.nodeId} side-effect retry must preserve its idempotency key`);
    }
    node.idempotencyKey = event.sideEffect.idempotencyKey;
    node.sideEffect = {
      visit: node.visits,
      attempt: node.attempts,
      idempotencyKey: event.sideEffect.idempotencyKey,
      class: event.sideEffect.class,
      status: "intent_recorded",
      requestRef: event.requestRef!,
    };
    state.guard.sideEffectAttempts += 1;
  } else if (event.kind === "side-effect-result") {
    if (event.sideEffect?.phase !== "result") throw new Error("Side-effect result event requires a result payload");
    const pending = node.sideEffect;
    if (!pending || pending.status !== "intent_recorded") throw new Error("Side-effect result has no unresolved persisted intent");
    if (pending.visit !== node.visits || pending.attempt !== node.attempts) throw new Error("Side-effect result does not match the active node attempt");
    if (pending.idempotencyKey !== event.sideEffect.idempotencyKey || pending.class !== event.sideEffect.class || pending.requestRef !== event.requestRef) {
      throw new Error("Side-effect result does not match the persisted intent");
    }
    node.sideEffect = {
      ...pending,
      status: event.sideEffect.outcome!,
      outcome: event.sideEffect.outcome,
      ...(event.sideEffect.resultRef ? { resultRef: cloneArtifactReference(event.sideEffect.resultRef) } : {}),
    };
  } else if (event.kind === "progress" && event.sideEffect !== undefined) {
    throw new Error("Progress event cannot carry side-effect data");
  }
}

function applyChosenEdge(graph: CompiledGraph, state: GraphExecutionState, event: Readonly<GraphEvent>): void {
  const selected = event.chosenEdge!;
  if (selected.from !== event.nodeId) throw new Error("Chosen graph edge source does not match event node");
  const matches = (graph.outgoingByNode.get(selected.from) ?? []).filter((candidate) => sameEdge(candidate, selected));
  if (matches.length !== 1) throw new Error(`Chosen graph edge matched ${matches.length} compiled edges`);
  if (selected.boundedBy) {
    const remaining = state.guard.backEdgeRemaining[selected.boundedBy];
    if (!Number.isInteger(remaining) || remaining <= 0) throw new Error(`Back-edge budget ${selected.boundedBy} is exhausted`);
    state.guard.backEdgeRemaining[selected.boundedBy] = remaining - 1;
  }
  if (event.nextStatus === "cancelled" || event.nextStatus === "failed") return;
  if (graph.definition.kind !== "state-machine") return;
  if (event.nextStatus !== "blocked") throw new Error("A successful state-machine edge must leave its source blocked");
  const target = state.nodeStates[selected.to]!;
  if (TERMINAL_STATUSES.has(target.status)) throw new Error(`State-machine target ${selected.to} has absorbing status ${target.status}`);
  if (target.status === "running" || target.status === "waiting_human") throw new Error(`State-machine target ${selected.to} is already active`);
  const definition = graph.nodesById.get(selected.to)!;
  target.status = definition.terminal ? "executed" : "ready";
  target.visits += 1;
  target.retryAttempts = 0;
  delete target.startedAt;
  delete target.lastError;
  delete target.idempotencyKey;
  delete target.sideEffect;
  target.outputRefs = [];
  if (definition.terminal) target.completedAt = event.timestamp;
  else delete target.completedAt;
}

function activateDagReadyNodes(graph: CompiledGraph, state: GraphExecutionState, metadata?: SchedulerMetadata): void {
  if (graph.definition.kind !== "dag") return;
  const ready = computeReadySet(graph, state, metadata);
  for (const id of ready) {
    const node = state.nodeStates[id]!;
    if (node.status !== "pending") continue;
    const definition = graph.nodesById.get(id)!;
    node.visits += 1;
    node.retryAttempts = 0;
    if (definition.terminal) {
      node.status = "executed";
      node.completedAt = latestCompletionTimestamp(state);
    } else node.status = "ready";
  }
}

function dagNodeIsReady(graph: CompiledGraph, state: Readonly<GraphExecutionState>, nodeId: string): boolean {
  const status = state.nodeStates[nodeId]?.status;
  if (status !== "pending" && status !== "ready") return false;
  const incoming = graph.definition.edges.filter((edge) => edge.to === nodeId);
  if (incoming.length === 0) return nodeId === graph.definition.entry;
  if (!incoming.every((edge) => state.nodeStates[edge.from]?.status === "executed")) return false;
  const inputs = graph.nodesById.get(nodeId)!.inputContracts;
  return inputs.every((contract) => incoming.some((edge) =>
    state.nodeStates[edge.from]!.outputRefs.some((reference) => reference.contract === contract)));
}

function comparePriority(left: string, right: string, metadata: SchedulerMetadata): number {
  return (metadata.priorities?.[right] ?? 0) - (metadata.priorities?.[left] ?? 0) || left.localeCompare(right);
}

function assertPriorities(graph: CompiledGraph, metadata: SchedulerMetadata): void {
  for (const [nodeId, priority] of Object.entries(metadata.priorities ?? {})) {
    if (!graph.nodesById.has(nodeId)) throw new Error(`Scheduler priority references unknown node: ${nodeId}`);
    if (!Number.isSafeInteger(priority)) throw new Error(`Scheduler priority for ${nodeId} must be a safe integer`);
  }
}

function resolveSchedulerMetadata(
  graph: CompiledGraph,
  state: Readonly<GraphExecutionState>,
  supplied: SchedulerMetadata | undefined,
): SchedulerMetadata {
  assertSchedulerMetadataShape(state.schedulerMetadata);
  const normalized = normalizeSchedulerMetadata(state.schedulerMetadata);
  if (schedulerMetadataFingerprint(normalized) !== state.metadataFingerprint) {
    throw new Error("Scheduler metadata fingerprint is invalid");
  }
  assertPriorities(graph, normalized);
  if (supplied !== undefined && schedulerMetadataFingerprint(supplied) !== state.metadataFingerprint) {
    throw new Error("Supplied scheduler metadata does not match the frozen run metadata");
  }
  return normalized;
}

function assertSchedulerMetadataShape(metadata: SchedulerMetadata): void {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Scheduler metadata must be an object");
  assertOnlyKeys(metadata as Record<string, unknown>, ["priorities"], "scheduler metadata");
  if (metadata.priorities === undefined) return;
  if (!metadata.priorities || typeof metadata.priorities !== "object" || Array.isArray(metadata.priorities)) {
    throw new Error("Scheduler priorities must be an object");
  }
  for (const [nodeId, priority] of Object.entries(metadata.priorities)) {
    assertToken(nodeId, "scheduler priority node id");
    if (!Number.isSafeInteger(priority)) throw new Error(`Scheduler priority for ${nodeId} must be a safe integer`);
  }
}

function normalizeSchedulerMetadata(metadata: SchedulerMetadata): SchedulerMetadata {
  assertSchedulerMetadataShape(metadata);
  const priorities = Object.fromEntries(Object.entries(metadata.priorities ?? {}).sort(([left], [right]) => left.localeCompare(right)));
  return Object.keys(priorities).length > 0 ? { priorities } : {};
}

function assertNodeStateValid(graph: CompiledGraph, state: Readonly<GraphExecutionState>, node: Readonly<NodeExecutionState>): void {
  const definition = graph.nodesById.get(node.nodeId);
  if (!definition) throw new Error(`Scheduler node state references unknown node: ${node.nodeId}`);
  if (!NODE_STATUSES.has(node.status)) throw new Error(`Scheduler node ${node.nodeId} has invalid status`);
  assertNonNegativeInteger(node.visits, `scheduler visits for ${node.nodeId}`);
  assertNonNegativeInteger(node.attempts, `scheduler attempts for ${node.nodeId}`);
  assertNonNegativeInteger(node.retryAttempts, `scheduler retry attempts for ${node.nodeId}`);
  if (node.retryAttempts > definition.retryBudget) throw new Error(`Scheduler retry budget is invalid for ${node.nodeId}`);
  if (node.status === "pending" && node.visits !== 0) throw new Error(`Pending scheduler node ${node.nodeId} cannot have visits`);
  if (node.status !== "pending" && node.visits === 0) throw new Error(`Activated scheduler node ${node.nodeId} must have a visit`);
  if (definition.terminal && (node.status === "ready" || node.status === "running" || node.status === "waiting_human")) {
    throw new Error(`Terminal scheduler node ${node.nodeId} cannot be scheduled`);
  }
  if (!Array.isArray(node.outputRefs)) throw new Error(`Scheduler outputs for ${node.nodeId} must be an array`);
  for (const reference of node.outputRefs) assertArtifactReference(graph, state.planVersion, node.nodeId, reference);
  assertPersistedNodeOutputs(definition.outputContracts, definition.terminal === true, node);
  if (node.startedAt !== undefined) assertIsoTimestamp(node.startedAt, `startedAt for ${node.nodeId}`);
  if (node.completedAt !== undefined) assertIsoTimestamp(node.completedAt, `completedAt for ${node.nodeId}`);
  if (node.idempotencyKey !== undefined) assertToken(node.idempotencyKey, `idempotency key for ${node.nodeId}`);
  if (node.sideEffect !== undefined) assertPersistedSideEffect(graph, state, node, node.sideEffect);
  if (node.lastError) {
    assertToken(node.lastError.category, `error category for ${node.nodeId}`);
    if (typeof node.lastError.retryable !== "boolean") throw new Error(`Error retryable flag for ${node.nodeId} is invalid`);
    assertNonNegativeInteger(node.lastError.attempt, `error attempt for ${node.nodeId}`);
    assertIsoTimestamp(node.lastError.recordedAt, `error timestamp for ${node.nodeId}`);
  }
}

function assertPersistedNodeOutputs(
  declaredContracts: readonly string[],
  terminal: boolean,
  node: Readonly<NodeExecutionState>,
): void {
  const completed = node.status === "executed" || node.status === "blocked";
  if (!completed && node.outputRefs.length > 0) throw new Error(`Node ${node.nodeId} cannot retain output refs while ${node.status}`);
  if (!completed) return;
  const actual = node.outputRefs.map((reference) => reference.contract);
  if (new Set(actual).size !== actual.length || !sameStrings([...declaredContracts].sort(), [...actual].sort())) {
    throw new Error(`Node ${node.nodeId} completion output refs do not match declared contracts`);
  }
  if (terminal && actual.length > 0) throw new Error(`Terminal node ${node.nodeId} cannot retain output refs`);
}

function assertDagReadyInputProvenance(
  graph: CompiledGraph,
  state: Readonly<GraphExecutionState>,
  nodeId: string,
): void {
  const incoming = graph.definition.edges.filter((edge) => edge.to === nodeId);
  for (const contract of graph.nodesById.get(nodeId)!.inputContracts) {
    const bound = incoming.some((edge) => state.nodeStates[edge.from]!.outputRefs.some((reference) => reference.contract === contract));
    if (!bound) throw new Error(`DAG ready node ${nodeId} is missing validated input contract ${contract}`);
  }
}

function assertPersistedSideEffect(
  graph: CompiledGraph,
  state: Readonly<GraphExecutionState>,
  node: Readonly<NodeExecutionState>,
  sideEffect: Readonly<SideEffectExecutionState>,
): void {
  assertPositiveInteger(sideEffect.visit, `side-effect visit for ${node.nodeId}`);
  assertPositiveInteger(sideEffect.attempt, `side-effect attempt for ${node.nodeId}`);
  if (sideEffect.visit > node.visits || sideEffect.attempt > node.attempts) throw new Error(`Side-effect state is ahead of node ${node.nodeId}`);
  assertToken(sideEffect.idempotencyKey, `side-effect idempotency key for ${node.nodeId}`);
  if (!SHA256.test(sideEffect.requestRef) || sideEffect.requestRef !== sha256(sideEffect.idempotencyKey)) {
    throw new Error(`Side-effect request reference is invalid for ${node.nodeId}`);
  }
  assertSideEffectPermitted(graph, node.nodeId, sideEffect.class);
  if (!new Set(["intent_recorded", "succeeded", "failed", "unknown"]).has(sideEffect.status)) {
    throw new Error(`Side-effect status is invalid for ${node.nodeId}`);
  }
  if (sideEffect.status === "intent_recorded") {
    if (sideEffect.outcome !== undefined || sideEffect.resultRef !== undefined) throw new Error(`Pending side effect for ${node.nodeId} cannot have a result`);
  } else if (sideEffect.outcome !== sideEffect.status) {
    throw new Error(`Settled side-effect outcome is inconsistent for ${node.nodeId}`);
  }
  if (sideEffect.status === "succeeded" && !sideEffect.resultRef) throw new Error(`Successful side effect for ${node.nodeId} requires a result reference`);
  if (sideEffect.resultRef) assertSideEffectArtifactReference(state.planVersion, node.nodeId, sideEffect.resultRef);
  if (node.idempotencyKey !== sideEffect.idempotencyKey) throw new Error(`Node ${node.nodeId} idempotency key does not match side-effect state`);
}

function assertSideEffectPermitted(
  graph: CompiledGraph,
  nodeId: string,
  sideEffectClass: SideEffectExecutionState["class"],
): void {
  const declared = graph.nodesById.get(nodeId)!.sideEffect;
  if (declared === "none") throw new Error(`Node ${nodeId} does not permit side effects`);
  if (sideEffectClass === "write" || sideEffectClass === "external" || sideEffectClass === "irreversible") {
    if (declared !== sideEffectClass) throw new Error(`Node ${nodeId} does not permit ${sideEffectClass} side effects`);
  }
}

function assertGuardStateValid(graph: CompiledGraph, guard: Readonly<ExecutionGuardState>): void {
  assertIsoTimestamp(guard.startedAt, "guard startedAt");
  assertNonNegativeInteger(guard.steps, "guard steps");
  if (!Array.isArray(guard.runningNodes) || new Set(guard.runningNodes).size !== guard.runningNodes.length) throw new Error("Guard running nodes are invalid");
  guard.runningNodes.forEach((node) => {
    if (!graph.nodesById.has(node)) throw new Error(`Guard references unknown running node: ${node}`);
  });
  for (const [value, label] of [
    [guard.modelCallsInFlight, "model calls"], [guard.providerCallsInFlight, "provider calls"],
    [guard.sideEffectAttempts, "side-effect attempts"], [guard.noProgressRepeats, "no-progress repeats"],
  ] as const) assertNonNegativeInteger(value, `guard ${label}`);
  for (const [value, label] of [
    [guard.estimatedCostUsd, "estimated cost"], [guard.observedCostUsd, "observed cost"],
    [guard.inputTokens, "input tokens"], [guard.outputTokens, "output tokens"],
  ] as const) assertUsageValue(value, `guard ${label}`);
  if (guard.humanWaitStartedAt !== undefined) assertIsoTimestamp(guard.humanWaitStartedAt, "human wait timestamp");
  if (guard.noProgressFingerprint !== undefined && !FINGERPRINT.test(guard.noProgressFingerprint)) throw new Error("Guard no-progress fingerprint is invalid");
  const required = [...new Set(graph.definition.edges.map((edge) => edge.boundedBy).filter((value): value is string => value !== undefined))].sort();
  const actual = Object.keys(guard.backEdgeRemaining).sort();
  if (!sameStrings(required, actual)) throw new Error("Guard back-edge budget keys do not match the compiled graph");
  for (const name of required) {
    assertNonNegativeInteger(guard.backEdgeRemaining[name], `back-edge budget ${name}`);
  }
}

function assertExecutionLimitsValid(limits: ExecutionLimits): void {
  for (const key of [
    "maxGraphSteps", "maxNodeAttempts", "maxPlanVersions", "maxGraphNodes", "maxGraphEdges", "maxReadyWidth",
    "maxConcurrency", "maxModelConcurrency", "maxProviderConcurrency", "maxWallTimeMs", "maxInputTokens", "maxOutputTokens",
    "maxSideEffectAttempts", "maxHumanWaitMs", "maxNoProgressRepeats",
  ] as const) assertPositiveInteger(limits[key], `execution limit ${key}`);
  for (const key of ["maxEstimatedCostUsd", "maxObservedCostUsd"] as const) assertNonNegativeFinite(limits[key], `execution limit ${key}`);
  if (limits.humanWait !== "allow" && limits.humanWait !== "deny") throw new Error("execution humanWait policy is invalid");
  if (!limits.backEdgeBudgets || typeof limits.backEdgeBudgets !== "object" || Array.isArray(limits.backEdgeBudgets)) {
    throw new Error("execution backEdgeBudgets must be an object");
  }
  for (const [name, budget] of Object.entries(limits.backEdgeBudgets)) {
    assertToken(name, "back-edge budget name");
    assertPositiveInteger(budget, `back-edge budget ${name}`);
  }
}

function assertGuardProbeValid(
  graph: CompiledGraph,
  state: Readonly<GraphExecutionState>,
  probe: Readonly<ExecutionGuardProbe>,
): void {
  if (!probe || typeof probe !== "object" || Array.isArray(probe)) throw new Error("Guard probe must be an object");
  assertOnlyKeys(probe as unknown as Record<string, unknown>, [
    "action", "nodeId", "now", "unattended", "additionalReady", "concurrency", "modelCalls", "providerCalls",
    "nodeAttempts", "estimatedCostUsd", "observedCostUsd", "inputTokens", "outputTokens", "sideEffectAttempts",
    "sideEffectClass", "edge",
  ], "guard probe");
  if (!new Set<GuardAction>(["node", "model", "side_effect", "human_wait", "transition", "plan_version"]).has(probe.action)) {
    throw new Error(`Guard probe action is invalid: ${String(probe.action)}`);
  }
  assertIsoTimestamp(probe.now, "guard timestamp");
  if (Date.parse(probe.now) < Date.parse(state.guard.startedAt)) throw new Error("Guard timestamp predates graph start");
  if (typeof probe.unattended !== "boolean") throw new Error("Guard unattended flag must be boolean");
  if (probe.nodeId !== undefined) {
    assertToken(probe.nodeId, "guard node id");
    if (!graph.nodesById.has(probe.nodeId)) throw new Error(`Guard references unknown node: ${probe.nodeId}`);
  } else if (probe.action === "node" || probe.action === "model" || probe.action === "side_effect") {
    throw new Error(`Guard action ${probe.action} requires a node id`);
  }
  for (const [value, label] of [
    [probe.nodeAttempts, "node attempts"], [probe.additionalReady, "additional ready"], [probe.concurrency, "concurrency"],
    [probe.modelCalls, "model calls"], [probe.providerCalls, "provider calls"],
    [probe.sideEffectAttempts, "side-effect attempts"],
  ] as const) if (value !== undefined) assertNonNegativeInteger(value, `guard ${label}`);
  for (const [value, label] of [
    [probe.estimatedCostUsd, "estimated cost"], [probe.observedCostUsd, "observed cost"],
    [probe.inputTokens, "input tokens"], [probe.outputTokens, "output tokens"],
  ] as const) if (value !== undefined) assertUsageValue(value, `guard ${label}`);
  if (probe.sideEffectClass !== undefined && !new Set(["model", "tool", "write", "external", "irreversible"]).has(probe.sideEffectClass)) {
    throw new Error("Guard side-effect class is invalid");
  }
  if (probe.edge) {
    assertEventEdge(probe.edge);
    if (probe.nodeId && probe.edge.from !== probe.nodeId) throw new Error("Guard edge source does not match node id");
    const matches = (graph.outgoingByNode.get(probe.edge.from) ?? []).filter((candidate) => sameEdge(candidate, probe.edge!));
    if (matches.length !== 1) throw new Error("Guard edge does not match exactly one compiled edge");
  }
  assertActionSpecificProbe(probe);
}

function assertActionSpecificProbe(probe: Readonly<ExecutionGuardProbe>): void {
  if (probe.action === "node") {
    if (probe.nodeAttempts !== 1 || probe.concurrency !== 1) throw new Error("Node guard requires one prospective attempt and concurrency slot");
    assertProbeFieldsAbsent(probe, [
      "additionalReady", "modelCalls", "providerCalls", "estimatedCostUsd", "observedCostUsd", "inputTokens", "outputTokens",
      "sideEffectAttempts", "sideEffectClass", "edge",
    ]);
    return;
  }
  if (probe.action === "model") {
    if (probe.nodeAttempts !== 0 || probe.concurrency !== 0 || probe.modelCalls !== 1 || probe.providerCalls !== 1 || probe.sideEffectAttempts !== 1) {
      throw new Error("Model guard requires exact attempt and concurrency reservations");
    }
    if (probe.estimatedCostUsd === undefined || probe.observedCostUsd === undefined ||
        probe.inputTokens === undefined || probe.outputTokens === undefined) {
      throw new Error("Model guard requires explicit cost and token estimates");
    }
    assertProbeFieldsAbsent(probe, ["additionalReady", "sideEffectClass", "edge"]);
    return;
  }
  if (probe.action === "side_effect") {
    if (probe.nodeAttempts !== 0 || probe.concurrency !== 0 || probe.sideEffectAttempts !== 1 || probe.sideEffectClass === undefined) {
      throw new Error("Side-effect guard requires one declared attempt and side-effect class");
    }
    assertProbeFieldsAbsent(probe, ["additionalReady", "edge"]);
    return;
  }
  if (probe.action === "human_wait") {
    assertProbeFieldsAbsent(probe, [
      "nodeAttempts", "additionalReady", "concurrency", "modelCalls", "providerCalls", "estimatedCostUsd", "observedCostUsd",
      "inputTokens", "outputTokens", "sideEffectAttempts", "sideEffectClass", "edge",
    ]);
    return;
  }
  if (probe.action === "transition") {
    if (probe.edge === undefined || probe.additionalReady === undefined) throw new Error("Transition guard requires an edge and ready-set delta");
    assertProbeFieldsAbsent(probe, [
      "nodeAttempts", "concurrency", "modelCalls", "providerCalls", "estimatedCostUsd", "observedCostUsd", "inputTokens",
      "outputTokens", "sideEffectAttempts", "sideEffectClass",
    ]);
    return;
  }
  assertProbeFieldsAbsent(probe, [
    "nodeId", "nodeAttempts", "additionalReady", "concurrency", "modelCalls", "providerCalls", "estimatedCostUsd",
    "observedCostUsd", "inputTokens", "outputTokens", "sideEffectAttempts", "sideEffectClass", "edge",
  ]);
}

function assertProbeFieldsAbsent(
  probe: Readonly<ExecutionGuardProbe>,
  fields: readonly (keyof ExecutionGuardProbe)[],
): void {
  const present = fields.filter((field) => probe[field] !== undefined);
  if (present.length > 0) throw new Error(`Guard action ${probe.action} contains unrelated fields: ${present.join(", ")}`);
}

function assertGraphWithinLimits(graph: CompiledGraph, limits: ExecutionLimits): void {
  if (graph.definition.nodes.length > limits.maxGraphNodes) throw new Error("Graph exceeds configured node limit");
  if (graph.definition.edges.length > limits.maxGraphEdges) throw new Error("Graph exceeds configured edge limit");
}

function requiredBackEdgeBudgets(graph: CompiledGraph, limits: ExecutionLimits): Record<string, number> {
  const names = [...new Set(graph.definition.edges.map((edge) => edge.boundedBy).filter((value): value is string => value !== undefined))].sort();
  return Object.fromEntries(names.map((name) => {
    const budget = limits.backEdgeBudgets[name];
    if (!Number.isInteger(budget) || budget <= 0) throw new Error(`Missing positive execution budget for boundedBy ${name}`);
    return [name, budget];
  }));
}

function assertEventIdentity(state: Readonly<GraphExecutionState>, event: Readonly<GraphEvent>): void {
  if (event.runId !== state.runId) throw new Error(`Graph event run id ${event.runId} does not match ${state.runId}`);
  if (event.graphId !== state.graphId) throw new Error(`Graph event graph id ${event.graphId} does not match ${state.graphId}`);
  if (event.graphVersion !== state.graphVersion) throw new Error(`Graph event graph version ${event.graphVersion} does not match ${state.graphVersion}`);
  if (event.graphDigest !== state.graphDigest) throw new Error("Graph event digest does not match the scheduler graph digest");
  if (event.planVersion !== state.planVersion) {
    throw new Error(`Graph event plan version ${event.planVersion} does not match ${state.planVersion}`);
  }
  if (!state.nodeStates[event.nodeId]) throw new Error(`Graph event references unknown node: ${event.nodeId}`);
}

function assertEventArtifacts(graph: CompiledGraph, event: Readonly<GraphEvent>): void {
  for (const reference of event.artifactRefs) assertArtifactReference(graph, event.planVersion, event.nodeId, reference);
  if (event.sideEffect?.resultRef) assertSideEffectArtifactReference(event.planVersion, event.nodeId, event.sideEffect.resultRef);
}

function assertCompletionContracts(graph: CompiledGraph, event: Readonly<GraphEvent>): void {
  if (event.nextStatus !== "executed" && event.nextStatus !== "blocked") return;
  const expected = graph.nodesById.get(event.nodeId)!.outputContracts;
  if (expected.length === 0) {
    if (event.artifactRefs.length > 0 || event.validatorResult !== undefined) {
      throw new Error(`Node ${event.nodeId} declares no completion contracts`);
    }
    return;
  }
  if (event.validatorResult?.status !== "passed") throw new Error(`Node ${event.nodeId} cannot complete before output validation passes`);
  if (new Set(event.validatorResult.contracts).size !== event.validatorResult.contracts.length) {
    throw new Error(`Node ${event.nodeId} has duplicate validated contracts`);
  }
  const validated = new Set(event.validatorResult.contracts);
  const missing = expected.filter((contract) => !validated.has(contract));
  const extra = event.validatorResult.contracts.filter((contract) => !expected.includes(contract));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`Node ${event.nodeId} validated contracts must exactly match declarations`);
  }
  const artifactContracts = event.artifactRefs.map((reference) => reference.contract);
  if (new Set(artifactContracts).size !== artifactContracts.length) {
    throw new Error(`Node ${event.nodeId} has a duplicate artifact contract`);
  }
  const missingArtifacts = expected.filter((contract) => !artifactContracts.includes(contract));
  const extraArtifacts = artifactContracts.filter((contract) => !expected.includes(contract));
  if (missingArtifacts.length > 0 || extraArtifacts.length > 0) {
    throw new Error(`Node ${event.nodeId} artifact contracts must exactly match declarations`);
  }
}

function assertArtifactReference(
  graph: CompiledGraph,
  planVersion: number,
  nodeId: string,
  reference: Readonly<ArtifactReference>,
): void {
  assertArtifactReferenceShape(reference);
  if (reference.planVersion !== planVersion) throw new Error(`Artifact reference plan version ${reference.planVersion} does not match ${planVersion}`);
  if (reference.nodeId !== nodeId) throw new Error(`Artifact reference node ${reference.nodeId} does not match ${nodeId}`);
  if (!graph.nodesById.get(nodeId)!.outputContracts.includes(reference.contract)) {
    throw new Error(`Artifact reference contract ${reference.contract} is not declared by ${nodeId}`);
  }
  const expectedDirectory = `nodes/${planVersion}/${nodeId}/`;
  if (!reference.path.startsWith(expectedDirectory)) {
    throw new Error(`Artifact reference must remain inside node artifact directory ${expectedDirectory}`);
  }
}

/** Side-effect receipts are control-plane evidence, not business output
 * contracts. They remain content-addressed and confined to the exact node
 * artifact directory without impersonating one of the node's declarations. */
function assertSideEffectArtifactReference(
  planVersion: number,
  nodeId: string,
  reference: Readonly<ArtifactReference>,
): void {
  assertArtifactReferenceShape(reference);
  if (reference.planVersion !== planVersion || reference.nodeId !== nodeId) {
    throw new Error("Side-effect artifact reference does not match its node");
  }
  const expectedDirectory = `nodes/${planVersion}/${nodeId}/`;
  if (!reference.path.startsWith(expectedDirectory)) {
    throw new Error(`Side-effect artifact reference must remain inside ${expectedDirectory}`);
  }
}

function assertArtifactReferenceShape(value: unknown): asserts value is ArtifactReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Artifact reference must be an object");
  const reference = value as Record<string, unknown>;
  assertOnlyKeys(reference, ["planVersion", "nodeId", "contract", "path", "sha256", "sizeBytes"], "artifact reference");
  assertPositiveInteger(reference.planVersion, "artifact reference plan version");
  assertToken(reference.nodeId, "artifact reference node id");
  if (typeof reference.contract !== "string" || reference.contract.trim().length === 0 || reference.contract.length > 128 || /[\u0000-\u001f\u007f]/.test(reference.contract)) {
    throw new Error("Artifact reference contract is invalid");
  }
  if (typeof reference.path !== "string" || !isContainedRelativePath(reference.path)) throw new Error("Artifact reference requires a contained relative path");
  if (typeof reference.sha256 !== "string" || !SHA256.test(reference.sha256)) throw new Error("Artifact reference SHA-256 is invalid");
  if (!Number.isSafeInteger(reference.sizeBytes) || (reference.sizeBytes as number) < 0 || (reference.sizeBytes as number) > MAX_ARTIFACT_BYTES) {
    throw new Error("Artifact reference size is invalid");
  }
}

function assertEventEdge(value: unknown): asserts value is GraphEventEdge {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Graph event edge must be an object");
  const edge = value as Record<string, unknown>;
  assertOnlyKeys(edge, ["from", "to", "event", "guard", "boundedBy"], "graph event edge");
  for (const key of ["from", "to", "event"] as const) assertToken(edge[key], `graph event edge ${key}`);
  if (edge.guard !== undefined) assertToken(edge.guard, "graph event edge guard");
  if (edge.boundedBy !== undefined) assertToken(edge.boundedBy, "graph event edge boundedBy");
}

function assertValidatorResult(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Graph validator result must be an object");
  const result = value as Record<string, unknown>;
  assertOnlyKeys(result, ["status", "contracts"], "graph validator result");
  if (result.status !== "passed" && result.status !== "failed" && result.status !== "not_run") throw new Error("Graph validator status is invalid");
  if (!Array.isArray(result.contracts) || result.contracts.some((contract) => typeof contract !== "string" || contract.length === 0 || contract.length > 128)) {
    throw new Error("Graph validator contracts are invalid");
  }
}

function assertSideEffect(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Graph side-effect data must be an object");
  const sideEffect = value as Record<string, unknown>;
  assertOnlyKeys(sideEffect, ["phase", "idempotencyKey", "class", "outcome", "resultRef"], "graph side effect");
  if (sideEffect.phase !== "intent" && sideEffect.phase !== "result") throw new Error("Graph side-effect phase is invalid");
  assertToken(sideEffect.idempotencyKey, "graph side-effect idempotency key");
  if (!new Set(["model", "tool", "write", "external", "irreversible"]).has(sideEffect.class as string)) throw new Error("Graph side-effect class is invalid");
  if (sideEffect.outcome !== undefined && sideEffect.outcome !== "succeeded" && sideEffect.outcome !== "failed" && sideEffect.outcome !== "unknown") {
    throw new Error("Graph side-effect outcome is invalid");
  }
  if (sideEffect.resultRef !== undefined) assertArtifactReferenceShape(sideEffect.resultRef);
}

function assertUsage(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Graph usage must be an object");
  const usage = value as Record<string, unknown>;
  assertOnlyKeys(usage, ["estimatedCostUsd", "observedCostUsd", "inputTokens", "outputTokens"], "graph usage");
  for (const [key, amount] of Object.entries(usage)) assertUsageValue(amount, `graph usage ${key}`);
}

function assertReservation(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Graph reservation must be an object");
  const reservation = value as Record<string, unknown>;
  assertOnlyKeys(reservation, ["modelCalls", "providerCalls"], "graph reservation");
  for (const key of ["modelCalls", "providerCalls"] as const) {
    if (reservation[key] !== -1 && reservation[key] !== 0 && reservation[key] !== 1) throw new Error(`Graph reservation ${key} is invalid`);
  }
}

function applyUsage(guard: ExecutionGuardState, usage: GraphEvent["usage"]): void {
  if (!usage) return;
  guard.estimatedCostUsd = sumUsage(guard.estimatedCostUsd, usage.estimatedCostUsd);
  guard.observedCostUsd = sumUsage(guard.observedCostUsd, usage.observedCostUsd);
  guard.inputTokens = sumUsage(guard.inputTokens, usage.inputTokens);
  guard.outputTokens = sumUsage(guard.outputTokens, usage.outputTokens);
}

function applyReservation(guard: ExecutionGuardState, reservation: GraphEvent["reservation"]): void {
  if (!reservation) return;
  guard.modelCallsInFlight += reservation.modelCalls;
  guard.providerCallsInFlight += reservation.providerCalls;
  if (guard.modelCallsInFlight < 0 || guard.providerCallsInFlight < 0) throw new Error("Graph event released an unowned concurrency reservation");
}

function applyProgress(guard: ExecutionGuardState, fingerprint: string | undefined): void {
  if (!fingerprint) return;
  if (guard.noProgressFingerprint === fingerprint) guard.noProgressRepeats += 1;
  else {
    guard.noProgressFingerprint = fingerprint;
    guard.noProgressRepeats = 1;
  }
}

function firstUnknownUsage(guard: Readonly<ExecutionGuardState>, probe: Readonly<ExecutionGuardProbe>): string | undefined {
  for (const [name, current, proposed] of [
    ["estimated cost", guard.estimatedCostUsd, probe.estimatedCostUsd],
    ["observed cost", guard.observedCostUsd, probe.observedCostUsd],
    ["input tokens", guard.inputTokens, probe.inputTokens],
    ["output tokens", guard.outputTokens, probe.outputTokens],
  ] as const) if (current === "unknown" || proposed === "unknown") return name;
  return undefined;
}

function sumUsage(current: number | "unknown", addition: number | "unknown" | undefined): number | "unknown" {
  if (current === "unknown" || addition === "unknown") return "unknown";
  return current + (addition ?? 0);
}

function sameEdge(left: Readonly<GraphEdgeDefinition>, right: Readonly<GraphEventEdge>): boolean {
  return left.from === right.from && left.to === right.to && left.event === right.event &&
    left.guard === right.guard && left.boundedBy === right.boundedBy;
}

function cloneExecutionState(state: Readonly<GraphExecutionState>): GraphExecutionState {
  return {
    ...state,
    recentEventIds: [...state.recentEventIds],
    nodeStates: Object.fromEntries(Object.entries(state.nodeStates).map(([id, node]) => [id, {
      ...node,
      outputRefs: node.outputRefs.map(cloneArtifactReference),
      sideEffect: node.sideEffect ? {
        ...node.sideEffect,
        resultRef: node.sideEffect.resultRef ? cloneArtifactReference(node.sideEffect.resultRef) : undefined,
      } : undefined,
      lastError: node.lastError ? { ...node.lastError } : undefined,
    }])),
    ready: [...state.ready],
    schedulerMetadata: normalizeSchedulerMetadata(state.schedulerMetadata),
    effectiveLimits: cloneExecutionLimits(state.effectiveLimits),
    guard: {
      ...state.guard,
      runningNodes: [...state.guard.runningNodes],
      backEdgeRemaining: { ...state.guard.backEdgeRemaining },
    },
  };
}

function cloneArtifactReference(reference: Readonly<ArtifactReference>): ArtifactReference {
  return { ...reference };
}

function graphEventHash(event: Readonly<GraphEvent>): string {
  return sha256(canonicalJson(event));
}

function canonicalJson(value: unknown): string {
  const normalized = canonicalValue(value);
  const json = JSON.stringify(normalized);
  if (json === undefined) throw new Error("Cannot canonicalize an undefined root value");
  return json;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => item === undefined ? null : canonicalValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function cloneExecutionLimits(limits: ExecutionLimits): ExecutionLimits {
  return { ...limits, backEdgeBudgets: { ...limits.backEdgeBudgets } };
}

function latestCompletionTimestamp(state: Readonly<GraphExecutionState>): string {
  return Object.values(state.nodeStates)
    .map((node) => node.completedAt)
    .filter((value): value is string => value !== undefined)
    .sort()
    .at(-1) ?? state.guard.startedAt;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new Error(`${label} contains unsupported fields: ${extras.join(", ")}`);
}

function isContainedRelativePath(value: string): boolean {
  if (value.length === 0 || value.length > 1_024 || value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const parts = value.replaceAll("\\", "/").split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function assertToken(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !TOKEN.test(value)) throw new Error(`${label} must be a bounded canonical token`);
}

function assertIsoTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(`${label} must be an ISO timestamp`);
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive integer`);
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`);
}

function assertNonNegativeFinite(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative finite number`);
}

function assertUsageValue(value: unknown, label: string): void {
  if (value !== "unknown") assertNonNegativeFinite(value, label);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function denied(code: string, reason: string): ExecutionGuardDecision {
  return { allowed: false, code, reason };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
