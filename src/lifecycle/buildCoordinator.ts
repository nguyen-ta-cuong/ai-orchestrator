import { createHash } from "node:crypto";
import type { CompiledBuildPlan } from "../core/buildPlan.js";
import {
  createBuildHumanWaitEvent,
  createBuildWorkerBudgetIntent,
  planBuildNodeStarts,
  planRunningBuildActions,
  recoverBuildWorkerBudgetReservation,
  type BuildExecutionPolicy,
  type BuildRunningAction,
  type BuildWorkerBudgetReservation,
  type BuildWorkspaceIdentity,
} from "../core/buildExecution.js";
import {
  evaluateExecutionGuard,
  type ArtifactReference,
  type ExecutionLimits,
  type GraphEvent,
  type GraphExecutionState,
} from "../core/scheduler.js";
import { readGraphEvents } from "../runtime/graphCheckpoint.js";
import { runBoundedBuildWorkerTasks } from "../runtime/buildWorker.js";
import type { RunPaths } from "./artifacts.js";
import {
  readBuildDispatchLedger,
  sealBuildDispatchLedger,
} from "./buildArtifacts.js";
import {
  checkpointBuildGraphEvent,
  buildGraphExecutionPaths,
  initializeBuildGraphExecution,
} from "./buildGraphExecution.js";
import {
  executeDurableBuildAction,
  type BuildActionExecutionContext,
  type BuildActionExecutor,
  type DurableBuildActionResult,
} from "./buildExecution.js";

export interface BuildWorkerBudgetEstimates {
  unattended: boolean;
  estimatedCostUsd: number | "unknown";
  observedCostUsd: number | "unknown";
  inputTokens: number | "unknown";
  outputTokens: number | "unknown";
}

export interface BuildCoordinatorAdapter extends BuildActionExecutor {
  workspaceForNode(nodeId: string, state: Readonly<GraphExecutionState>): Readonly<BuildWorkspaceIdentity> | undefined;
  workerBudgetEstimates(nodeId: string): Readonly<BuildWorkerBudgetEstimates>;
  onActionSettled?(action: Readonly<BuildRunningAction>, result: Readonly<DurableBuildActionResult>): Promise<void> | void;
  workerUsage?(nodeId: string): Readonly<{
    estimatedCostUsd?: number | "unknown";
    observedCostUsd?: number | "unknown";
    inputTokens?: number | "unknown";
    outputTokens?: number | "unknown";
  }>;
}

export interface BuildCoordinatorOptions {
  owner: string;
  pid: number;
  now(): string;
  limits: Readonly<ExecutionLimits>;
  policy: Omit<BuildExecutionPolicy, "now">;
  maxActionConcurrency: number;
  maxPasses?: number;
  isProcessAlive?(pid: number): boolean;
  signal?: AbortSignal;
}

export interface BuildCoordinatorResult {
  status: "completed" | "waiting-human" | "blocked";
  state: Readonly<GraphExecutionState>;
  reason?: string;
}

/**
 * Durable production coordinator for one immutable BUILD DAG. Graph events are
 * checkpointed serially; independent inner effects may execute through a
 * bounded pool after every required intent and scheduler reservation is durable.
 */
export async function runBuildCoordinator(
  paths: RunPaths,
  compiled: Readonly<CompiledBuildPlan>,
  adapter: Readonly<BuildCoordinatorAdapter>,
  options: Readonly<BuildCoordinatorOptions>,
): Promise<BuildCoordinatorResult> {
  let state = initializeBuildGraphExecution(paths, compiled, {
    owner: options.owner,
    now: options.now(),
    pid: options.pid,
    limits: options.limits,
    ...(options.isProcessAlive === undefined ? {} : { isProcessAlive: options.isProcessAlive }),
  });
  const maxPasses = options.maxPasses ?? Math.max(16, options.limits.maxGraphSteps * 8);
  const reservations = new Map<string, Readonly<BuildWorkerBudgetReservation>>();

  for (let pass = 0; pass < maxPasses; pass += 1) {
    if (state.nodeStates["build-complete"]?.status === "executed") {
      return Object.freeze({ status: "completed", state });
    }
    const policy: BuildExecutionPolicy = { ...options.policy, now: options.now() };
    const starts = planBuildNodeStarts(compiled, state, policy);
    if (starts.start.length > 0) {
      for (const start of starts.start) {
        state = checkpoint(paths, compiled, state, nodeEvent(state, start.nodeId, "running", options.now()), options, "start");
      }
      continue;
    }
    if (starts.humanIntegrationNodeId) {
      const event = createBuildHumanWaitEvent(compiled, state, starts.humanIntegrationNodeId, {
        now: options.now(),
        unattended: policy.unattended,
        eventId: eventId(state, starts.humanIntegrationNodeId, "human-wait"),
      });
      state = checkpoint(paths, compiled, state, event, options, "human-wait");
      return Object.freeze({ status: "waiting-human", state, reason: starts.humanIntegrationNodeId });
    }

    const workspaceByNode = Object.fromEntries(state.guard.runningNodes.map((nodeId) => [
      nodeId,
      adapter.workspaceForNode(nodeId, state),
    ]).filter((entry): entry is [string, Readonly<BuildWorkspaceIdentity>] => entry[1] !== undefined));
    const checkpoints = state.guard.runningNodes.flatMap((nodeId) =>
      readBuildDispatchLedger(paths, state.planVersion, nodeId).checkpoints);
    const actions = planRunningBuildActions(compiled, state, policy, checkpoints, workspaceByNode);
    if (actions.length > 0) {
      const prepared: Array<{
        action: Readonly<BuildRunningAction>;
        context: Readonly<BuildActionExecutionContext>;
      }> = [];
      for (const action of actions) {
        let reservation: Readonly<BuildWorkerBudgetReservation> | undefined;
        if (action.purpose === "worker") {
          const key = `${action.nodeId}:${action.visit}:${action.attempt}`;
          reservation = reservations.get(key);
          if (!reservation) {
            const sideEffect = state.nodeStates[action.nodeId]?.sideEffect;
            const estimates = adapter.workerBudgetEstimates(action.nodeId);
            if (estimates.unattended !== policy.unattended) {
              throw new Error("BUILD worker budget estimates must preserve the coordinator unattended policy");
            }
            if (!sideEffect || sideEffect.attempt !== action.attempt || sideEffect.status !== "intent_recorded") {
              const aggregate = pendingBudgetTotals(state, adapter, estimates);
              const guard = evaluateExecutionGuard(compiled.graph, state, state.effectiveLimits, {
                action: "model",
                nodeId: action.nodeId,
                nodeAttempts: 0,
                concurrency: 0,
                modelCalls: 1,
                providerCalls: 1,
                estimatedCostUsd: aggregate.estimatedCostUsd,
                observedCostUsd: aggregate.observedCostUsd,
                inputTokens: aggregate.inputTokens,
                outputTokens: aggregate.outputTokens,
                sideEffectAttempts: 1,
                now: options.now(),
                unattended: policy.unattended,
              });
              if (!guard.allowed) continue;
              const budget = createBuildWorkerBudgetIntent(compiled, state, action, {
                ...estimates,
                now: options.now(),
                eventId: eventId(state, action.nodeId, "worker-budget"),
              });
              state = checkpoint(paths, compiled, state, budget.event, options, "worker-budget");
              reservation = budget.reservation;
            } else {
              const intent = readGraphEvents(buildGraphExecutionPaths(paths)).find((event) =>
                event.kind === "side-effect-intent" && event.requestRef === sideEffect.requestRef);
              if (!intent) throw new Error("BUILD worker budget intent is absent from the durable graph event log");
              reservation = recoverBuildWorkerBudgetReservation(compiled, state, action, intent, estimates);
            }
            reservations.set(key, reservation);
          }
        }
        prepared.push({ action, context: reservation ? { workerBudgetReservation: reservation } : {} });
      }
      if (prepared.length === 0) {
        return Object.freeze({ status: "blocked", state, reason: "worker-budget-capacity" });
      }
      const dispatchState = state;
      const results = await runBoundedBuildWorkerTasks(prepared.map(({ action, context }) => async () => ({
        action,
        result: await executeCoordinatorAction(paths, compiled, action, adapter, options, {
          ...context,
          graphState: dispatchState,
        }),
      })), Math.min(options.maxActionConcurrency, state.effectiveLimits.maxConcurrency));
      let unresolved = false;
      for (const { action, result } of results) {
        await adapter.onActionSettled?.(action, result);
        if (result.checkpoint.status === "failed") {
          state = settleOuterEffect(paths, compiled, state, action.nodeId, "failed", undefined, adapter, options);
          state = failNode(paths, compiled, state, action.nodeId, options);
        } else if (result.checkpoint.status !== "succeeded") unresolved = true;
      }
      if (unresolved) return Object.freeze({ status: "blocked", state, reason: "unresolved-effect-reconciliation" });
      continue;
    }

    let completedNode = false;
    for (const nodeId of [...state.guard.runningNodes]) {
      const ledger = readBuildDispatchLedger(paths, state.planVersion, nodeId);
      const nodeState = state.nodeStates[nodeId]!;
      const active = ledger.checkpoints.filter((entry) => entry.visit === nodeState.visits && entry.attempt === nodeState.attempts);
      if (active.some(({ status }) => status === "failed")) {
        state = settleOuterEffect(paths, compiled, state, nodeId, "failed", undefined, adapter, options);
        state = failNode(paths, compiled, state, nodeId, options);
        completedNode = true;
        continue;
      }
      if (!ledger.head) continue;
      const seal = sealBuildDispatchLedger(paths, {
        runId: state.runId,
        planVersion: state.planVersion,
        planHash: compiled.hash,
        nodeId,
        visit: nodeState.visits,
        attempt: nodeState.attempts,
        expectedHead: ledger.head,
      }, { owner: options.owner });
      state = settleOuterEffect(paths, compiled, state, nodeId, "succeeded", {
        planVersion: seal.planVersion,
        nodeId: seal.nodeId,
        contract: seal.contract,
        path: seal.path,
        sha256: seal.sha256,
        sizeBytes: seal.sizeBytes,
      }, adapter, options);
      state = checkpoint(paths, compiled, state, completionEvent(state, nodeId, seal.outputArtifacts, options.now()), options, "complete");
      completedNode = true;
    }
    if (completedNode) continue;
    return Object.freeze({ status: "blocked", state, reason: starts.blocked[0]?.code ?? "no-runnable-build-work" });
  }
  return Object.freeze({ status: "blocked", state, reason: "coordinator-pass-limit" });
}

async function executeCoordinatorAction(
  paths: RunPaths,
  compiled: Readonly<CompiledBuildPlan>,
  action: Readonly<BuildRunningAction>,
  adapter: Readonly<BuildCoordinatorAdapter>,
  options: Readonly<BuildCoordinatorOptions>,
  context: Readonly<BuildActionExecutionContext>,
): Promise<DurableBuildActionResult> {
  const timeoutMs = compiled.plan.nodes.find(({ id }) => id === action.nodeId)?.timeoutMs;
  if (!timeoutMs) throw new Error(`BUILD action ${action.nodeId} has no immutable timeout`);
  if (options.signal?.aborted) throw new Error(`BUILD action ${action.nodeId} was aborted before dispatch`);
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      executeDurableBuildAction(paths, action, adapter, {
        owner: options.owner,
        recordedAt: options.now(),
        context: { ...context, signal: controller.signal },
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`BUILD action ${action.nodeId}/${action.purpose} timed out after ${timeoutMs}ms`);
          controller.abort(error);
          reject(error);
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

function settleOuterEffect(
  paths: RunPaths,
  compiled: Readonly<CompiledBuildPlan>,
  state: Readonly<GraphExecutionState>,
  nodeId: string,
  outcome: "succeeded" | "failed",
  resultRef: Readonly<ArtifactReference> | undefined,
  adapter: Readonly<BuildCoordinatorAdapter>,
  options: Readonly<BuildCoordinatorOptions>,
): GraphExecutionState {
  const sideEffect = state.nodeStates[nodeId]?.sideEffect;
  if (!sideEffect || sideEffect.attempt !== state.nodeStates[nodeId]!.attempts || sideEffect.status !== "intent_recorded") return state as GraphExecutionState;
  const event: GraphEvent = {
    schemaVersion: 1,
    kind: "side-effect-result",
    sequence: state.lastAppliedEventSequence + 1,
    eventId: eventId(state, nodeId, `outer-${outcome}`),
    requestRef: sideEffect.requestRef,
    runId: state.runId,
    graphId: state.graphId,
    graphVersion: state.graphVersion,
    graphDigest: state.graphDigest,
    planVersion: state.planVersion,
    nodeId,
    priorStatus: "running",
    nextStatus: "running",
    attempt: state.nodeStates[nodeId]!.attempts,
    timestamp: options.now(),
    artifactRefs: [],
    sideEffect: {
      phase: "result",
      idempotencyKey: sideEffect.idempotencyKey,
      class: sideEffect.class,
      outcome,
      ...(resultRef === undefined ? {} : { resultRef }),
    },
    reservation: { modelCalls: -1, providerCalls: -1 },
    ...(adapter.workerUsage === undefined ? {} : { usage: adapter.workerUsage(nodeId) }),
  };
  return checkpoint(paths, compiled, state, event, options, "outer-result");
}

function failNode(
  paths: RunPaths,
  compiled: Readonly<CompiledBuildPlan>,
  state: Readonly<GraphExecutionState>,
  nodeId: string,
  options: Readonly<BuildCoordinatorOptions>,
): GraphExecutionState {
  const definition = compiled.plan.nodes.find((node) => node.id === nodeId)!;
  const node = state.nodeStates[nodeId]!;
  const retryable = node.retryAttempts < definition.retryLimit;
  let next = checkpoint(paths, compiled, state, nodeEvent(state, nodeId, retryable ? "failed_retryable" : "failed", options.now(), "build-action-failed"), options, "failed");
  if (retryable) next = checkpoint(paths, compiled, next, nodeEvent(next, nodeId, "ready", options.now()), options, "retry-ready");
  return next;
}

function nodeEvent(
  state: Readonly<GraphExecutionState>,
  nodeId: string,
  nextStatus: "running" | "ready" | "failed_retryable" | "failed",
  timestamp: string,
  errorCategory?: string,
): GraphEvent {
  const node = state.nodeStates[nodeId]!;
  return {
    schemaVersion: 1,
    kind: "node-status",
    sequence: state.lastAppliedEventSequence + 1,
    eventId: eventId(state, nodeId, nextStatus),
    runId: state.runId,
    graphId: state.graphId,
    graphVersion: state.graphVersion,
    graphDigest: state.graphDigest,
    planVersion: state.planVersion,
    nodeId,
    priorStatus: node.status,
    nextStatus,
    attempt: nextStatus === "running" ? node.attempts + 1 : node.attempts,
    timestamp,
    ...(errorCategory === undefined ? {} : { errorCategory }),
    artifactRefs: [],
  };
}

function completionEvent(
  state: Readonly<GraphExecutionState>,
  nodeId: string,
  artifacts: readonly Readonly<ArtifactReference>[],
  timestamp: string,
): GraphEvent {
  return {
    schemaVersion: 1,
    kind: "node-status",
    sequence: state.lastAppliedEventSequence + 1,
    eventId: eventId(state, nodeId, "executed"),
    runId: state.runId,
    graphId: state.graphId,
    graphVersion: state.graphVersion,
    graphDigest: state.graphDigest,
    planVersion: state.planVersion,
    nodeId,
    priorStatus: state.nodeStates[nodeId]!.status,
    nextStatus: "executed",
    attempt: state.nodeStates[nodeId]!.attempts,
    timestamp,
    artifactRefs: [...artifacts],
    validatorResult: { status: "passed", contracts: artifacts.map(({ contract }) => contract) },
  };
}

function checkpoint(
  paths: RunPaths,
  compiled: Readonly<CompiledBuildPlan>,
  state: Readonly<GraphExecutionState>,
  event: Readonly<GraphEvent>,
  options: Readonly<BuildCoordinatorOptions>,
  label: string,
): GraphExecutionState {
  return checkpointBuildGraphEvent(paths, compiled, state, event, {
    owner: options.owner,
    tempId: `${label}-${event.sequence}`,
  });
}

function eventId(state: Readonly<GraphExecutionState>, nodeId: string, kind: string): string {
  return createHash("sha256")
    .update(`${state.runId}\0${state.planVersion}\0${state.lastAppliedEventSequence + 1}\0${nodeId}\0${kind}`)
    .digest("hex");
}

function pendingBudgetTotals(
  state: Readonly<GraphExecutionState>,
  adapter: Readonly<BuildCoordinatorAdapter>,
  candidate: Readonly<BuildWorkerBudgetEstimates>,
): BuildWorkerBudgetEstimates {
  const pending = Object.values(state.nodeStates)
    .filter((node) => node.sideEffect?.status === "intent_recorded" && node.sideEffect.class === "model")
    .map((node) => adapter.workerBudgetEstimates(node.nodeId));
  return {
    unattended: candidate.unattended,
    estimatedCostUsd: sumBudget([...pending.map((item) => item.estimatedCostUsd), candidate.estimatedCostUsd]),
    observedCostUsd: sumBudget([...pending.map((item) => item.observedCostUsd), candidate.observedCostUsd]),
    inputTokens: sumBudget([...pending.map((item) => item.inputTokens), candidate.inputTokens]),
    outputTokens: sumBudget([...pending.map((item) => item.outputTokens), candidate.outputTokens]),
  };
}

function sumBudget(values: readonly (number | "unknown")[]): number | "unknown" {
  return values.includes("unknown") ? "unknown" : (values as readonly number[]).reduce((total, value) => total + value, 0);
}
