import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { BuildResourceLock, CompiledBuildPlan } from "./buildPlan.js";
import {
  assertScheduleValid,
  evaluateExecutionGuard,
  type ArtifactReference,
  type GraphCheckpointRef,
  type GraphEvent,
  type GraphExecutionState,
} from "./scheduler.js";

export type BuildEffectPurpose = "worktree" | "worker" | "validator" | "human-integration" | "cleanup";

export const BUILD_EFFECT_ORDINAL: Readonly<Record<BuildEffectPurpose, number>> = Object.freeze({
  worktree: 1,
  worker: 2,
  validator: 3,
  "human-integration": 4,
  cleanup: 5,
});

export interface BuildWorktreeAuthority {
  intentId: string;
  runId: string;
  planVersion: number;
  planHash: string;
  ownerNodeId: string;
  baseSha: string;
  worktreePath: string;
}

export type BuildWorkspaceIdentity =
  | { kind: "shared" }
  | ({ kind: "planned-worktree" } & BuildWorktreeAuthority)
  | ({ kind: "owned-worktree"; ownershipReceiptHash: string } & BuildWorktreeAuthority);

export interface BuildEffectIdentityInput {
  runId: string;
  planVersion: number;
  planHash: string;
  nodeId: string;
  visit: number;
  attempt: number;
  purpose: BuildEffectPurpose;
  ordinal: number;
  workspace: BuildWorkspaceIdentity;
}

export interface BuildEffectIdentity extends BuildEffectIdentityInput {
  idempotencyKey: string;
  requestRef: string;
}

export interface BuildExecutionPolicy {
  now: string;
  unattended: boolean;
  maxReadOnlyFanOut: number;
  allowParallelWrites: boolean;
  allowWorktreeCreation: boolean;
  trustRepositoryCheckout: boolean;
}

export interface BuildNodeStart {
  nodeId: string;
  handler: "inspect" | "design" | "implement" | "validate";
  workspace: "shared" | "isolated-worktree";
  toolPolicy: "read-only" | "declared-writes" | "reviewed-validation";
  timeoutMs: number;
}

export interface BuildStartBlock {
  nodeId: string;
  code: string;
}

export interface BuildNodeStartPlan {
  start: readonly Readonly<BuildNodeStart>[];
  blocked: readonly Readonly<BuildStartBlock>[];
  humanIntegrationNodeId?: string;
}

export type BuildDispatchCheckpointStatus = "intent-recorded" | "succeeded" | "failed" | "unknown";

export interface BuildDispatchCheckpoint extends BuildEffectIdentity {
  schemaVersion: 1;
  status: BuildDispatchCheckpointStatus;
  recordedAt: string;
  resultRef?: string;
}

export type BuildRunningActionKind =
  | "materialize-worktree"
  | "invoke-worker"
  | "validate-outputs"
  | "record-human-integration"
  | "cleanup-worktree"
  | "reconcile-unknown";

export interface BuildRunningAction extends BuildEffectIdentity {
  kind: BuildRunningActionKind;
}

export interface BuildWorkerBudgetReservation {
  schemaVersion: 1;
  reservationRef: string;
  outerIdempotencyKey: string;
  outerRequestRef: string;
  effectRequestRef: string;
  runId: string;
  planVersion: number;
  planHash: string;
  nodeId: string;
  visit: number;
  attempt: number;
  intentSequence: number;
  eventId: string;
  unattended: boolean;
  estimatedCostUsd: number | "unknown";
  observedCostUsd: number | "unknown";
  inputTokens: number | "unknown";
  outputTokens: number | "unknown";
  modelCalls: 1;
  providerCalls: 1;
}

export interface BuildWorkerBudgetIntent {
  reservation: Readonly<BuildWorkerBudgetReservation>;
  event: Readonly<GraphEvent>;
}

export interface BuildHumanIntegrationDecision {
  schemaVersion: 1;
  runId: string;
  planVersion: number;
  planHash: string;
  nodeId: string;
  decision: "integrated" | "declined";
  selectedCandidateNodeIds: string[];
  mainWorkspaceHeadBefore: string;
  mainWorkspaceHeadAfter: string;
  mainWorkspaceIntegrated: boolean;
  confirmedByUser: boolean;
  recordedAt: string;
}

export interface BuildHumanIntegrationCandidateEvidence {
  nodeId: string;
  ownershipReceiptHash: string;
  candidateHead: string;
  diffSha256: string;
  validationArtifactSha256: readonly string[];
}

export interface BuildHumanIntegrationReceipt {
  schemaVersion: 1;
  kind: "trusted-human-integration";
  decisionRef: string;
  confirmationRef: string;
  inspectedBy: "trusted-runtime-git";
  candidateEvidence: readonly Readonly<BuildHumanIntegrationCandidateEvidence>[];
  mainWorkspaceInspection: {
    headBefore: string;
    headAfter: string;
    statusBeforeSha256: string;
    statusAfterSha256: string;
    conflictCheckSha256: string;
  };
  artifactRef?: Readonly<ArtifactReference>;
  recordedAt: string;
}

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const PURPOSES = new Set<BuildEffectPurpose>(Object.keys(BUILD_EFFECT_ORDINAL) as BuildEffectPurpose[]);
const POLICY_KEYS = [
  "now",
  "unattended",
  "maxReadOnlyFanOut",
  "allowParallelWrites",
  "allowWorktreeCreation",
  "trustRepositoryCheckout",
] as const;
const CHECKPOINT_KEYS = [
  "schemaVersion",
  "runId",
  "planVersion",
  "planHash",
  "nodeId",
  "visit",
  "attempt",
  "purpose",
  "ordinal",
  "workspace",
  "idempotencyKey",
  "requestRef",
  "status",
  "recordedAt",
  "resultRef",
] as const;
const DECISION_KEYS = [
  "schemaVersion",
  "runId",
  "planVersion",
  "planHash",
  "nodeId",
  "decision",
  "selectedCandidateNodeIds",
  "mainWorkspaceHeadBefore",
  "mainWorkspaceHeadAfter",
  "mainWorkspaceIntegrated",
  "confirmedByUser",
  "recordedAt",
] as const;

/**
 * Derive a purpose-scoped effect identity. A node attempt is intentionally not
 * one idempotency domain: worktree creation, model invocation, validation,
 * integration, and cleanup each receive their own immutable ordinal.
 */
export function buildEffectIdentity(inputValue: Readonly<BuildEffectIdentityInput>): BuildEffectIdentity {
  const input = normalizeEffectInput(inputValue);
  const workspaceIdentity = input.workspace.kind === "shared"
    ? "shared"
    : [
        input.workspace.kind,
        input.workspace.intentId,
        input.workspace.runId,
        String(input.workspace.planVersion),
        input.workspace.planHash,
        input.workspace.ownerNodeId,
        input.workspace.baseSha,
        input.workspace.worktreePath,
        ...(input.workspace.kind === "owned-worktree" ? [input.workspace.ownershipReceiptHash] : []),
      ].join("\0");
  const idempotencyKey = sha256([
    "ai-orchestrator/build-effect/v1",
    input.runId,
    String(input.planVersion),
    input.planHash,
    input.nodeId,
    String(input.visit),
    String(input.attempt),
    input.purpose,
    String(input.ordinal),
    workspaceIdentity,
  ].join("\0"));
  return Object.freeze({
    ...input,
    workspace: Object.freeze({ ...input.workspace }),
    idempotencyKey,
    requestRef: sha256(idempotencyKey),
  });
}

/** Select ready nodes only. Ownership is intentionally established after the
 * isolated node becomes running, under a separately durable worktree intent. */
export function planBuildNodeStarts(
  compiled: Readonly<CompiledBuildPlan>,
  state: Readonly<GraphExecutionState>,
  policyValue: Readonly<BuildExecutionPolicy>,
): BuildNodeStartPlan {
  assertBuildIdentity(compiled, state);
  assertScheduleValid(compiled.graph, state, compiled.schedulerMetadata);
  const policy = normalizePolicy(policyValue);
  const selected: string[] = [];
  const start: BuildNodeStart[] = [];
  const blocked: BuildStartBlock[] = [];
  let humanIntegrationNodeId: string | undefined;
  const running = [...state.guard.runningNodes];
  const graphCapacity = Math.max(0, state.effectiveLimits.maxConcurrency - running.length);
  const stepCapacity = Math.max(0, state.effectiveLimits.maxGraphSteps - state.guard.steps);
  const activeReadOnly = running.filter((nodeId) => isReadOnlyNode(compiled, nodeId)).length;
  let selectedReadOnly = 0;

  for (const nodeId of state.ready) {
    const definition = buildNode(compiled, nodeId);
    if (definition.handler === "integrate") {
      humanIntegrationNodeId ??= nodeId;
      blocked.push({ nodeId, code: "human-integration-required" });
      continue;
    }
    if (definition.workspace === "isolated-worktree" &&
        (!policy.allowWorktreeCreation || !policy.trustRepositoryCheckout)) {
      blocked.push({ nodeId, code: !policy.allowWorktreeCreation ? "worktree-creation-disabled" : "checkout-trust-required" });
      continue;
    }
    if (start.length >= graphCapacity) {
      blocked.push({ nodeId, code: "concurrency-limit" });
      continue;
    }
    if (start.length >= stepCapacity) {
      blocked.push({ nodeId, code: "graph-step-limit" });
      continue;
    }
    if (isReadOnlyNode(compiled, nodeId) && activeReadOnly + selectedReadOnly >= policy.maxReadOnlyFanOut) {
      blocked.push({ nodeId, code: "read-only-fanout-limit" });
      continue;
    }
    if (sharedWriterConflict(compiled, nodeId, [...running, ...selected])) {
      blocked.push({ nodeId, code: "shared-workspace-busy" });
      continue;
    }
    if (resourceConflict(compiled, nodeId, [...running, ...selected])) {
      blocked.push({ nodeId, code: "resource-conflict" });
      continue;
    }
    if (isIsolatedWriter(compiled, nodeId) && !policy.allowParallelWrites &&
        [...running, ...selected].some((active) => isWriteNode(compiled, active))) {
      blocked.push({ nodeId, code: "parallel-write-disabled" });
      continue;
    }
    const guard = evaluateExecutionGuard(compiled.graph, state, state.effectiveLimits, {
      action: "node",
      nodeId,
      nodeAttempts: 1,
      concurrency: 1,
      now: policy.now,
      unattended: policy.unattended,
    });
    if (!guard.allowed) {
      blocked.push({ nodeId, code: guard.code ?? "execution-guard-denied" });
      continue;
    }
    const nodePolicy = compiled.nodePolicies[nodeId];
    if (!nodePolicy || nodePolicy.toolPolicy === "human-integration") {
      throw new Error(`BUILD start policy is missing or invalid for ${nodeId}`);
    }
    selected.push(nodeId);
    if (isReadOnlyNode(compiled, nodeId)) selectedReadOnly += 1;
    start.push({
      nodeId,
      handler: definition.handler,
      workspace: definition.workspace,
      toolPolicy: nodePolicy.toolPolicy,
      timeoutMs: definition.timeoutMs,
    });
  }

  return Object.freeze({
    start: Object.freeze(start.map((item) => Object.freeze(item))),
    blocked: Object.freeze(blocked.map((item) => Object.freeze(item))),
    ...(humanIntegrationNodeId === undefined ? {} : { humanIntegrationNodeId }),
  });
}

/**
 * Plan the next effect for each running node from immutable checkpoints. An
 * intent without a durable result is never replayed; it becomes an explicit
 * reconciliation action.
 */
export function planRunningBuildActions(
  compiled: Readonly<CompiledBuildPlan>,
  state: Readonly<GraphExecutionState>,
  policyValue: Readonly<BuildExecutionPolicy>,
  checkpointValues: readonly Readonly<BuildDispatchCheckpoint>[],
  workspaceByNode: Readonly<Record<string, Readonly<BuildWorkspaceIdentity>>> = {},
): readonly Readonly<BuildRunningAction>[] {
  assertBuildIdentity(compiled, state);
  assertScheduleValid(compiled.graph, state, compiled.schedulerMetadata);
  const policy = normalizePolicy(policyValue);
  const checkpoints = normalizeCheckpoints(compiled, state, checkpointValues);
  const actions: BuildRunningAction[] = [];

  for (const nodeId of state.guard.runningNodes) {
    const definition = buildNode(compiled, nodeId);
    if (definition.handler === "integrate") {
      throw new Error(`BUILD integration node ${nodeId} must enter waiting_human instead of running`);
    }
    const nodeState = state.nodeStates[nodeId]!;
    const workspace = normalizeWorkspaceForNode(compiled, state, definition, workspaceByNode[nodeId], nodeId);
    const stages = effectStages(definition.handler, definition.workspace);
    for (const stage of stages) {
      if (stage.purpose === "worktree" && (!policy.allowWorktreeCreation || !policy.trustRepositoryCheckout)) {
        throw new Error(`BUILD worktree action for ${nodeId} requires creation consent and trusted checkout behavior`);
      }
      const effectWorkspace = stage.purpose === "worktree" ? plannedWorkspace(workspace, nodeId) : workspace;
      if (stage.purpose !== "worktree" && definition.workspace === "isolated-worktree" && workspace.kind !== "owned-worktree") {
        throw new Error(`BUILD ${stage.purpose} action for ${nodeId} requires a reconciled ownership receipt`);
      }
      const identity = buildEffectIdentity({
        runId: state.runId,
        planVersion: state.planVersion,
        planHash: compiled.hash,
        nodeId,
        visit: nodeState.visits,
        attempt: nodeState.attempts,
        purpose: stage.purpose,
        ordinal: BUILD_EFFECT_ORDINAL[stage.purpose],
        workspace: effectWorkspace,
      });
      const checkpoint = checkpoints.get(identity.idempotencyKey);
      if (!checkpoint) {
        if (stage.purpose === "worktree" && workspace.kind === "owned-worktree") {
          throw new Error(`BUILD isolated node ${nodeId} supplied ownership before its durable worktree receipt`);
        }
        actions.push(Object.freeze({ ...identity, kind: stage.kind }));
        break;
      }
      if (checkpoint.status === "intent-recorded" || checkpoint.status === "unknown") {
        actions.push(Object.freeze({ ...identity, kind: "reconcile-unknown" }));
        break;
      }
      if (checkpoint.status === "failed") break;
      if (stage.purpose === "worktree") {
        if (workspace.kind !== "owned-worktree" || checkpoint.resultRef !== workspace.ownershipReceiptHash) {
          throw new Error(`BUILD isolated node ${nodeId} worktree success is not bound to its ownership receipt`);
        }
      }
    }
  }
  return Object.freeze(actions);
}

export function assertBuildDispatchCheckpoint(value: unknown): BuildDispatchCheckpoint {
  const record = requireRecord(value, "BUILD dispatch checkpoint");
  assertOnlyKeys(record, CHECKPOINT_KEYS, "BUILD dispatch checkpoint");
  if (record.schemaVersion !== 1 || typeof record.status !== "string" ||
      !new Set<BuildDispatchCheckpointStatus>(["intent-recorded", "succeeded", "failed", "unknown"])
        .has(record.status as BuildDispatchCheckpointStatus)) {
    throw new Error("BUILD dispatch checkpoint schema or status is invalid");
  }
  assertIsoTimestamp(record.recordedAt, "BUILD dispatch checkpoint timestamp");
  if (record.resultRef !== undefined && (typeof record.resultRef !== "string" || !SHA256.test(record.resultRef))) {
    throw new Error("BUILD dispatch checkpoint result reference is invalid");
  }
  if (record.status === "succeeded" && record.resultRef === undefined) {
    throw new Error("BUILD dispatch checkpoint succeeded without a result reference");
  }
  if (record.status !== "succeeded" && record.resultRef !== undefined) {
    throw new Error("BUILD dispatch checkpoint has an unexpected result reference");
  }
  const expected = buildEffectIdentity({
    runId: record.runId as string,
    planVersion: record.planVersion as number,
    planHash: record.planHash as string,
    nodeId: record.nodeId as string,
    visit: record.visit as number,
    attempt: record.attempt as number,
    purpose: record.purpose as BuildEffectPurpose,
    ordinal: record.ordinal as number,
    workspace: record.workspace as BuildWorkspaceIdentity,
  });
  if (record.idempotencyKey !== expected.idempotencyKey || record.requestRef !== expected.requestRef) {
    throw new Error("BUILD dispatch checkpoint effect identity is invalid");
  }
  return Object.freeze({
    ...expected,
    schemaVersion: 1,
    status: record.status as BuildDispatchCheckpointStatus,
    recordedAt: record.recordedAt as string,
    ...(record.resultRef === undefined ? {} : { resultRef: record.resultRef }),
  });
}

export function assertHumanIntegrationDecision(
  compiled: Readonly<CompiledBuildPlan>,
  state: Readonly<GraphExecutionState>,
  value: unknown,
): BuildHumanIntegrationDecision {
  assertBuildIdentity(compiled, state);
  const record = requireRecord(value, "BUILD human integration decision");
  assertOnlyKeys(record, DECISION_KEYS, "BUILD human integration decision");
  if (record.schemaVersion !== 1 || record.runId !== state.runId || record.planVersion !== state.planVersion ||
      record.planHash !== compiled.hash || typeof record.nodeId !== "string") {
    throw new Error("BUILD human integration decision identity is invalid");
  }
  const node = compiled.plan.nodes.find(({ id }) => id === record.nodeId);
  if (!node || node.handler !== "integrate" || node.toolPolicy !== "human-integration") {
    throw new Error("BUILD human integration decision does not target an integration node");
  }
  if (record.decision !== "integrated" && record.decision !== "declined") {
    throw new Error("BUILD human integration decision value is invalid");
  }
  const candidateValues = requireDataArray(record.selectedCandidateNodeIds, "selected candidate nodes", compiled.plan.nodes.length);
  const selectedCandidateNodeIds = candidateValues.map((candidate) => {
    if (typeof candidate !== "string" || !TOKEN.test(candidate)) throw new Error("BUILD integration candidate id is invalid");
    const selected = compiled.plan.nodes.find(({ id }) => id === candidate);
    if (!selected || selected.handler !== "implement" || selected.workspace !== "isolated-worktree") {
      throw new Error(`BUILD integration candidate ${candidate} is not an isolated implement node`);
    }
    return candidate;
  });
  if (new Set(selectedCandidateNodeIds).size !== selectedCandidateNodeIds.length) {
    throw new Error("BUILD integration decision contains duplicate candidates");
  }
  if (typeof record.mainWorkspaceHeadBefore !== "string" || !GIT_SHA.test(record.mainWorkspaceHeadBefore) ||
      typeof record.mainWorkspaceHeadAfter !== "string" || !GIT_SHA.test(record.mainWorkspaceHeadAfter) ||
      typeof record.mainWorkspaceIntegrated !== "boolean" || record.confirmedByUser !== true) {
    throw new Error("BUILD integration decision must be explicitly confirmed with exact workspace heads");
  }
  assertIsoTimestamp(record.recordedAt, "BUILD integration decision timestamp");
  if (record.decision === "integrated") {
    if (!record.mainWorkspaceIntegrated || selectedCandidateNodeIds.length === 0 ||
        record.mainWorkspaceHeadBefore === record.mainWorkspaceHeadAfter) {
      throw new Error("BUILD integrated decision requires confirmed main-workspace integration and a changed HEAD");
    }
  } else if (record.mainWorkspaceIntegrated || selectedCandidateNodeIds.length !== 0 ||
      record.mainWorkspaceHeadBefore !== record.mainWorkspaceHeadAfter) {
    throw new Error("BUILD declined decision must preserve the main workspace and select no candidates");
  }
  return Object.freeze({
    schemaVersion: 1,
    runId: record.runId as string,
    planVersion: record.planVersion as number,
    planHash: record.planHash as string,
    nodeId: record.nodeId,
    decision: record.decision,
    selectedCandidateNodeIds: Object.freeze([...selectedCandidateNodeIds]) as unknown as string[],
    mainWorkspaceHeadBefore: record.mainWorkspaceHeadBefore,
    mainWorkspaceHeadAfter: record.mainWorkspaceHeadAfter,
    mainWorkspaceIntegrated: record.mainWorkspaceIntegrated,
    confirmedByUser: true,
    recordedAt: record.recordedAt as string,
  });
}

export function createBuildHumanWaitEvent(
  compiled: Readonly<CompiledBuildPlan>,
  state: Readonly<GraphExecutionState>,
  nodeId: string,
  input: Readonly<{ now: string; unattended: boolean; eventId: string }>,
): GraphEvent {
  assertBuildIdentity(compiled, state);
  assertScheduleValid(compiled.graph, state, compiled.schedulerMetadata);
  const node = buildNode(compiled, nodeId);
  if (node.handler !== "integrate" || state.nodeStates[nodeId]?.status !== "ready") {
    throw new Error("BUILD human wait requires a ready integration node");
  }
  if (!TOKEN.test(input.eventId)) throw new Error("BUILD human wait event id is invalid");
  const guard = evaluateExecutionGuard(compiled.graph, state, state.effectiveLimits, {
    action: "human_wait",
    now: input.now,
    unattended: input.unattended,
  });
  if (!guard.allowed) throw new Error(`BUILD human integration wait denied: ${guard.code ?? guard.reason ?? "guard"}`);
  return Object.freeze({
    schemaVersion: 1,
    kind: "node-status",
    sequence: state.lastAppliedEventSequence + 1,
    eventId: input.eventId,
    runId: state.runId,
    graphId: state.graphId,
    graphVersion: state.graphVersion,
    graphDigest: state.graphDigest,
    planVersion: state.planVersion,
    nodeId,
    priorStatus: "ready",
    nextStatus: "waiting_human",
    attempt: state.nodeStates[nodeId]!.attempts + 1,
    timestamp: input.now,
    artifactRefs: [],
  });
}

export function createBuildHumanIntegrationAction(
  compiled: Readonly<CompiledBuildPlan>,
  state: Readonly<GraphExecutionState>,
  nodeId: string,
): BuildRunningAction {
  assertBuildIdentity(compiled, state);
  assertScheduleValid(compiled.graph, state, compiled.schedulerMetadata);
  const node = buildNode(compiled, nodeId);
  const nodeState = state.nodeStates[nodeId];
  if (node.handler !== "integrate" || nodeState?.status !== "waiting_human") {
    throw new Error("BUILD human integration effect requires a waiting_human integration node");
  }
  const identity = buildEffectIdentity({
    runId: state.runId,
    planVersion: state.planVersion,
    planHash: compiled.hash,
    nodeId,
    visit: nodeState.visits,
    attempt: nodeState.attempts,
    purpose: "human-integration",
    ordinal: BUILD_EFFECT_ORDINAL["human-integration"],
    workspace: { kind: "shared" },
  });
  return Object.freeze({ ...identity, kind: "record-human-integration" });
}

export function createBuildHumanIntegrationResultEvent(
  compiled: Readonly<CompiledBuildPlan>,
  state: Readonly<GraphExecutionState>,
  decisionValue: unknown,
  evidenceValue: unknown,
  graphEvidenceValue: unknown,
  receiptValue: unknown,
  checkpointValue: unknown,
  eventId: string,
): GraphEvent {
  assertBuildIdentity(compiled, state);
  assertScheduleValid(compiled.graph, state, compiled.schedulerMetadata);
  if (!TOKEN.test(eventId)) throw new Error("BUILD human integration result event id is invalid");
  const decision = assertHumanIntegrationDecision(compiled, state, decisionValue);
  const nodeState = state.nodeStates[decision.nodeId];
  if (nodeState?.status !== "waiting_human") throw new Error("BUILD integration result requires waiting_human state");
  const action = createBuildHumanIntegrationAction(compiled, state, decision.nodeId);
  const checkpoint = assertBuildDispatchCheckpoint(checkpointValue);
  const receipt = normalizeHumanIntegrationReceipt(compiled, state, decision, evidenceValue, receiptValue);
  if (checkpoint.status !== "succeeded" || checkpoint.idempotencyKey !== action.idempotencyKey ||
      checkpoint.requestRef !== action.requestRef || checkpoint.purpose !== "human-integration" ||
      checkpoint.resultRef !== buildEffectReceiptSha256(action, receipt)) {
    throw new Error("BUILD integration result requires its exact durable human-integration receipt");
  }
  if (decision.decision === "declined") {
    return Object.freeze({
      schemaVersion: 1,
      kind: "node-status",
      sequence: state.lastAppliedEventSequence + 1,
      eventId,
      runId: state.runId,
      graphId: state.graphId,
      graphVersion: state.graphVersion,
      graphDigest: state.graphDigest,
      planVersion: state.planVersion,
      nodeId: decision.nodeId,
      priorStatus: "waiting_human",
      nextStatus: "cancelled",
      attempt: nodeState.attempts,
      timestamp: decision.recordedAt,
      artifactRefs: [],
    });
  }
  const evidence = receipt.artifactRef!;
  const graphEvidence = normalizeHumanEvidence(graphEvidenceValue, state, decision.nodeId);
  if (evidence.planVersion !== graphEvidence.planVersion || evidence.nodeId !== graphEvidence.nodeId ||
      evidence.contract !== graphEvidence.contract || evidence.sha256 !== graphEvidence.sha256 ||
      evidence.sizeBytes !== graphEvidence.sizeBytes) {
    throw new Error("BUILD integration graph evidence does not mirror its trusted receipt artifact");
  }
  const expectedContracts = buildNode(compiled, decision.nodeId).outputContracts.map(({ id }) => id);
  if (expectedContracts.length !== 1 || evidence.contract !== expectedContracts[0]) {
    throw new Error("BUILD integration evidence does not match its human-review output contract");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "node-status",
    sequence: state.lastAppliedEventSequence + 1,
    eventId,
    runId: state.runId,
    graphId: state.graphId,
    graphVersion: state.graphVersion,
    graphDigest: state.graphDigest,
    planVersion: state.planVersion,
    nodeId: decision.nodeId,
    priorStatus: "waiting_human",
    nextStatus: "executed",
    attempt: nodeState.attempts,
    timestamp: decision.recordedAt,
    validatorResult: { status: "passed" as const, contracts: [evidence.contract] },
    artifactRefs: [graphEvidence],
  });
}

/** Canonical receipt bytes shared by the pure completion check and durable artifact adapter. */
export function serializeBuildEffectReceipt(
  effectValue: Readonly<BuildEffectIdentity>,
  receipt: unknown,
): string {
  const effect = buildEffectIdentity({
    runId: effectValue.runId,
    planVersion: effectValue.planVersion,
    planHash: effectValue.planHash,
    nodeId: effectValue.nodeId,
    visit: effectValue.visit,
    attempt: effectValue.attempt,
    purpose: effectValue.purpose,
    ordinal: effectValue.ordinal,
    workspace: effectValue.workspace,
  });
  if (effect.idempotencyKey !== effectValue.idempotencyKey || effect.requestRef !== effectValue.requestRef) {
    throw new Error("BUILD effect receipt identity is invalid");
  }
  return `${stableJson({
    schemaVersion: 1,
    requestRef: effect.requestRef,
    idempotencyKey: effect.idempotencyKey,
    purpose: effect.purpose,
    ordinal: effect.ordinal,
    receipt,
  })}\n`;
}

export function buildEffectReceiptSha256(effect: Readonly<BuildEffectIdentity>, receipt: unknown): string {
  return sha256(serializeBuildEffectReceipt(effect, receipt));
}

function normalizeHumanIntegrationReceipt(
  compiled: Readonly<CompiledBuildPlan>,
  state: Readonly<GraphExecutionState>,
  decision: Readonly<BuildHumanIntegrationDecision>,
  evidenceValue: unknown,
  value: unknown,
): BuildHumanIntegrationReceipt {
  const record = requireRecord(value, "BUILD trusted human-integration receipt");
  assertOnlyKeys(record, [
    "schemaVersion", "kind", "decisionRef", "confirmationRef", "inspectedBy", "candidateEvidence",
    "mainWorkspaceInspection", "artifactRef", "recordedAt",
  ], "BUILD trusted human-integration receipt");
  if (record.schemaVersion !== 1 || record.kind !== "trusted-human-integration" ||
      record.inspectedBy !== "trusted-runtime-git" || typeof record.decisionRef !== "string" ||
      record.decisionRef !== sha256(stableJson(decision)) || typeof record.confirmationRef !== "string" ||
      !SHA256.test(record.confirmationRef)) {
    throw new Error("BUILD trusted human-integration receipt identity is invalid");
  }
  assertIsoTimestamp(record.recordedAt, "BUILD trusted human-integration receipt timestamp");
  if (record.recordedAt !== decision.recordedAt) throw new Error("BUILD integration receipt timestamp does not match the decision");
  const main = requireRecord(record.mainWorkspaceInspection, "BUILD main-workspace inspection");
  assertOnlyKeys(main, [
    "headBefore", "headAfter", "statusBeforeSha256", "statusAfterSha256", "conflictCheckSha256",
  ], "BUILD main-workspace inspection");
  if (main.headBefore !== decision.mainWorkspaceHeadBefore || main.headAfter !== decision.mainWorkspaceHeadAfter ||
      typeof main.statusBeforeSha256 !== "string" || !SHA256.test(main.statusBeforeSha256) ||
      typeof main.statusAfterSha256 !== "string" || !SHA256.test(main.statusAfterSha256) ||
      typeof main.conflictCheckSha256 !== "string" || !SHA256.test(main.conflictCheckSha256)) {
    throw new Error("BUILD main-workspace inspection does not match the confirmed decision");
  }
  const candidateValues = requireDataArray(record.candidateEvidence, "BUILD integration candidate evidence", compiled.plan.nodes.length);
  const candidateEvidence = candidateValues.map((candidate, index) => {
    const item = requireRecord(candidate, `BUILD integration candidate evidence ${index}`);
    assertOnlyKeys(item, [
      "nodeId", "ownershipReceiptHash", "candidateHead", "diffSha256", "validationArtifactSha256",
    ], `BUILD integration candidate evidence ${index}`);
    if (typeof item.nodeId !== "string" || typeof item.ownershipReceiptHash !== "string" ||
        !SHA256.test(item.ownershipReceiptHash) || typeof item.candidateHead !== "string" || !GIT_SHA.test(item.candidateHead) ||
        typeof item.diffSha256 !== "string" || !SHA256.test(item.diffSha256)) {
      throw new Error(`BUILD integration candidate evidence ${index} identity is invalid`);
    }
    const hashes = requireDataArray(item.validationArtifactSha256, `BUILD integration validation hashes ${index}`, 64)
      .map((hash) => {
        if (typeof hash !== "string" || !SHA256.test(hash)) throw new Error("BUILD integration validation artifact hash is invalid");
        return hash;
      }).sort();
    if (new Set(hashes).size !== hashes.length || hashes.length === 0) {
      throw new Error("BUILD integration candidate validation hashes must be non-empty and unique");
    }
    return Object.freeze({
      nodeId: item.nodeId,
      ownershipReceiptHash: item.ownershipReceiptHash,
      candidateHead: item.candidateHead,
      diffSha256: item.diffSha256,
      validationArtifactSha256: Object.freeze(hashes),
    });
  }).sort((left, right) => left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0);
  const isolated = compiled.plan.nodes.filter((node) => node.handler === "implement" && node.workspace === "isolated-worktree")
    .map(({ id }) => id).sort();
  if (!sameStrings(candidateEvidence.map(({ nodeId }) => nodeId), isolated)) {
    throw new Error("BUILD integration receipt must inspect every isolated candidate exactly once");
  }
  for (const candidate of candidateEvidence) {
    const validators = compiled.plan.nodes.filter((node) =>
      node.handler === "validate" && node.targetWorktreeNodeId === candidate.nodeId);
    const expectedHashes = validators.flatMap((node) => state.nodeStates[node.id]?.outputRefs.map(({ sha256 }) => sha256) ?? []).sort();
    if (!sameStrings(candidate.validationArtifactSha256, expectedHashes)) {
      throw new Error(`BUILD integration candidate ${candidate.nodeId} validation evidence is not scheduler-backed`);
    }
  }
  let artifactRef: ArtifactReference | undefined;
  if (decision.decision === "integrated") {
    artifactRef = normalizeHumanEvidence(record.artifactRef, state, decision.nodeId);
    const supplied = normalizeHumanEvidence(evidenceValue, state, decision.nodeId);
    if (stableJson(artifactRef) !== stableJson(supplied)) throw new Error("BUILD integration artifact differs from its trusted receipt");
  } else if (record.artifactRef !== undefined || evidenceValue !== undefined) {
    throw new Error("Declined BUILD integration cannot attach completion evidence");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "trusted-human-integration",
    decisionRef: record.decisionRef,
    confirmationRef: record.confirmationRef,
    inspectedBy: "trusted-runtime-git",
    candidateEvidence: Object.freeze(candidateEvidence),
    mainWorkspaceInspection: Object.freeze({
      headBefore: main.headBefore as string,
      headAfter: main.headAfter as string,
      statusBeforeSha256: main.statusBeforeSha256,
      statusAfterSha256: main.statusAfterSha256,
      conflictCheckSha256: main.conflictCheckSha256,
    }),
    ...(artifactRef === undefined ? {} : { artifactRef }),
    recordedAt: record.recordedAt,
  } as BuildHumanIntegrationReceipt);
}

/**
 * Evaluate the frozen scheduler guard before acquiring the one outer model and
 * provider reservation for a BUILD worker. The scheduler idempotency key binds
 * the immutable estimates, so a retry cannot silently increase its allowance.
 */
export function createBuildWorkerBudgetIntent(
  compiled: Readonly<CompiledBuildPlan>,
  state: Readonly<GraphExecutionState>,
  actionValue: Readonly<BuildRunningAction>,
  inputValue: Readonly<{
    now: string;
    unattended: boolean;
    eventId: string;
    estimatedCostUsd: number | "unknown";
    observedCostUsd: number | "unknown";
    inputTokens: number | "unknown";
    outputTokens: number | "unknown";
    checkpointRef: Readonly<GraphCheckpointRef>;
    routingDecisionId: string;
  }>,
): BuildWorkerBudgetIntent {
  assertBuildIdentity(compiled, state);
  assertScheduleValid(compiled.graph, state, compiled.schedulerMetadata);
  const action = normalizeWorkerBudgetAction(actionValue);
  const nodeState = state.nodeStates[action.nodeId];
  if (!nodeState || nodeState.status !== "running" || nodeState.visits !== action.visit ||
      nodeState.attempts !== action.attempt) {
    throw new Error("BUILD worker budget action does not target the active node attempt");
  }
  const input = normalizeBudgetIntentInput(inputValue);
  const decision = evaluateExecutionGuard(compiled.graph, state, state.effectiveLimits, {
    action: "model",
    nodeId: action.nodeId,
    nodeAttempts: 0,
    concurrency: 0,
    modelCalls: 1,
    providerCalls: 1,
    estimatedCostUsd: input.estimatedCostUsd,
    observedCostUsd: input.observedCostUsd,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    sideEffectAttempts: 1,
    now: input.now,
    unattended: input.unattended,
  });
  if (!decision.allowed) {
    throw new Error(`BUILD worker budget denied: ${decision.code ?? decision.reason ?? "execution guard"}`);
  }
  const budgetIdentity = {
    schemaVersion: 1 as const,
    runId: action.runId,
    planVersion: action.planVersion,
    planHash: action.planHash,
    nodeId: action.nodeId,
    visit: action.visit,
    unattended: input.unattended,
    estimatedCostUsd: input.estimatedCostUsd,
    observedCostUsd: input.observedCostUsd,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    modelCalls: 1 as const,
    providerCalls: 1 as const,
  };
  const outerIdempotencyKey = sha256(`ai-orchestrator/build-worker-budget/v1\0${stableJson(budgetIdentity)}`);
  const withoutRef = {
    ...budgetIdentity,
    outerIdempotencyKey,
    outerRequestRef: sha256(outerIdempotencyKey),
    effectRequestRef: action.requestRef,
    attempt: action.attempt,
    intentSequence: state.lastAppliedEventSequence + 1,
    eventId: input.eventId,
  };
  const reservation: BuildWorkerBudgetReservation = {
    ...withoutRef,
    reservationRef: sha256(`ai-orchestrator/build-worker-reservation/v1\0${stableJson(withoutRef)}`),
  };
  const event: GraphEvent = {
    schemaVersion: 1,
    kind: "side-effect-intent",
    sequence: reservation.intentSequence,
    eventId: reservation.eventId,
    requestRef: reservation.outerRequestRef,
    runId: state.runId,
    graphId: state.graphId,
    graphVersion: state.graphVersion,
    graphDigest: state.graphDigest,
    planVersion: state.planVersion,
    nodeId: action.nodeId,
    priorStatus: "running",
    nextStatus: "running",
    attempt: action.attempt,
    timestamp: input.now,
    artifactRefs: [],
    checkpointRef: input.checkpointRef,
    routingDecisionId: input.routingDecisionId,
    sideEffect: {
      phase: "intent",
      ordinal: nodeState.sideEffectOrdinal + 1,
      idempotencyKey: reservation.outerIdempotencyKey,
      class: "model",
    },
    reservation: { modelCalls: 1, providerCalls: 1 },
  };
  return Object.freeze({ reservation: Object.freeze(reservation), event: Object.freeze(event) });
}

/** Verify that the reservation is both self-authenticating and represented by the persisted outer scheduler intent. */
export function assertBuildWorkerBudgetReservation(
  compiled: Readonly<CompiledBuildPlan>,
  state: Readonly<GraphExecutionState>,
  actionValue: Readonly<BuildRunningAction>,
  value: unknown,
): BuildWorkerBudgetReservation {
  assertBuildIdentity(compiled, state);
  assertScheduleValid(compiled.graph, state, compiled.schedulerMetadata);
  const action = normalizeWorkerBudgetAction(actionValue);
  const record = requireRecord(value, "BUILD worker budget reservation");
  assertOnlyKeys(record, [
    "schemaVersion", "reservationRef", "outerIdempotencyKey", "outerRequestRef", "effectRequestRef", "runId",
    "planVersion", "planHash", "nodeId", "visit", "attempt", "intentSequence", "eventId",
    "unattended", "estimatedCostUsd", "observedCostUsd", "inputTokens", "outputTokens", "modelCalls", "providerCalls",
  ], "BUILD worker budget reservation");
  if (record.schemaVersion !== 1 || record.runId !== action.runId || record.planVersion !== action.planVersion ||
      record.planHash !== action.planHash || record.nodeId !== action.nodeId || record.visit !== action.visit ||
      record.attempt !== action.attempt || record.effectRequestRef !== action.requestRef ||
      record.modelCalls !== 1 || record.providerCalls !== 1 || typeof record.unattended !== "boolean") {
    throw new Error("BUILD worker budget reservation identity is invalid");
  }
  assertPositiveInteger(record.intentSequence, "BUILD worker budget intent sequence");
  if (typeof record.eventId !== "string" || !TOKEN.test(record.eventId)) {
    throw new Error("BUILD worker budget reservation checkpoint identity is invalid");
  }
  const usage = {
    estimatedCostUsd: normalizeUsageEstimate(record.estimatedCostUsd, "BUILD worker estimated cost", false),
    observedCostUsd: normalizeUsageEstimate(record.observedCostUsd, "BUILD worker observed cost", false),
    inputTokens: normalizeUsageEstimate(record.inputTokens, "BUILD worker input tokens", true),
    outputTokens: normalizeUsageEstimate(record.outputTokens, "BUILD worker output tokens", true),
  };
  if (record.unattended && Object.values(usage).some((item) => item === "unknown")) {
    throw new Error("BUILD worker unattended budget reservation cannot contain unknown usage");
  }
  const budgetIdentity = {
    schemaVersion: 1 as const,
    runId: action.runId,
    planVersion: action.planVersion,
    planHash: action.planHash,
    nodeId: action.nodeId,
    visit: action.visit,
    unattended: record.unattended,
    ...usage,
    modelCalls: 1 as const,
    providerCalls: 1 as const,
  };
  const outerIdempotencyKey = sha256(`ai-orchestrator/build-worker-budget/v1\0${stableJson(budgetIdentity)}`);
  const withoutRef = {
    ...budgetIdentity,
    outerIdempotencyKey,
    outerRequestRef: sha256(outerIdempotencyKey),
    effectRequestRef: action.requestRef,
    attempt: action.attempt,
    intentSequence: record.intentSequence,
    eventId: record.eventId,
  };
  const reservationRef = sha256(`ai-orchestrator/build-worker-reservation/v1\0${stableJson(withoutRef)}`);
  if (record.outerIdempotencyKey !== outerIdempotencyKey || record.outerRequestRef !== withoutRef.outerRequestRef ||
      record.reservationRef !== reservationRef) {
    throw new Error("BUILD worker budget reservation hash is invalid");
  }
  const sideEffect = state.nodeStates[action.nodeId]?.sideEffect;
  if (!sideEffect || sideEffect.status !== "intent_recorded" || sideEffect.class !== "model" ||
      sideEffect.visit !== action.visit || sideEffect.attempt !== action.attempt ||
      sideEffect.idempotencyKey !== outerIdempotencyKey || sideEffect.requestRef !== withoutRef.outerRequestRef ||
      record.intentSequence > state.lastAppliedEventSequence || !state.recentEventIds.includes(record.eventId as string) ||
      state.guard.modelCallsInFlight < 1 || state.guard.providerCallsInFlight < 1) {
    throw new Error("BUILD worker budget reservation is not backed by the exact durable scheduler intent");
  }
  return Object.freeze({ ...withoutRef, reservationRef });
}

/** Reconstruct a reservation after restart from its immutable scheduler intent and the same configured estimates. */
export function recoverBuildWorkerBudgetReservation(
  compiled: Readonly<CompiledBuildPlan>,
  state: Readonly<GraphExecutionState>,
  actionValue: Readonly<BuildRunningAction>,
  eventValue: Readonly<GraphEvent>,
  estimatesValue: Readonly<{
    unattended: boolean;
    estimatedCostUsd: number | "unknown";
    observedCostUsd: number | "unknown";
    inputTokens: number | "unknown";
    outputTokens: number | "unknown";
  }>,
): BuildWorkerBudgetReservation {
  const action = normalizeWorkerBudgetAction(actionValue);
  const event = eventValue;
  if (event.kind !== "side-effect-intent" || event.nodeId !== action.nodeId || event.attempt !== action.attempt ||
      event.priorStatus !== "running" || event.nextStatus !== "running" || event.sideEffect?.phase !== "intent" ||
      event.sideEffect.class !== "model" || event.reservation?.modelCalls !== 1 || event.reservation.providerCalls !== 1) {
    throw new Error("BUILD worker budget recovery event is not the expected scheduler intent");
  }
  const input = normalizeBudgetIntentInput({
    ...estimatesValue,
    now: event.timestamp,
    eventId: event.eventId,
    checkpointRef: event.checkpointRef,
    routingDecisionId: event.routingDecisionId,
  });
  const budgetIdentity = {
    schemaVersion: 1 as const,
    runId: action.runId,
    planVersion: action.planVersion,
    planHash: action.planHash,
    nodeId: action.nodeId,
    visit: action.visit,
    unattended: input.unattended,
    estimatedCostUsd: input.estimatedCostUsd,
    observedCostUsd: input.observedCostUsd,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    modelCalls: 1 as const,
    providerCalls: 1 as const,
  };
  const outerIdempotencyKey = sha256(`ai-orchestrator/build-worker-budget/v1\0${stableJson(budgetIdentity)}`);
  const withoutRef = {
    ...budgetIdentity,
    outerIdempotencyKey,
    outerRequestRef: sha256(outerIdempotencyKey),
    effectRequestRef: action.requestRef,
    attempt: action.attempt,
    intentSequence: event.sequence,
    eventId: event.eventId,
  };
  const reservation = {
    ...withoutRef,
    reservationRef: sha256(`ai-orchestrator/build-worker-reservation/v1\0${stableJson(withoutRef)}`),
  };
  if (event.requestRef !== reservation.outerRequestRef || event.sideEffect.idempotencyKey !== outerIdempotencyKey) {
    throw new Error("BUILD worker budget recovery estimates do not match the durable scheduler intent");
  }
  return assertBuildWorkerBudgetReservation(compiled, state, action, reservation);
}

function normalizeWorkerBudgetAction(value: Readonly<BuildRunningAction>): BuildRunningAction {
  if ((value.kind !== "invoke-worker" && value.kind !== "reconcile-unknown") || value.purpose !== "worker") {
    throw new Error("BUILD worker budget accepts only worker invocation or reconciliation actions");
  }
  const expected = buildEffectIdentity({
    runId: value.runId,
    planVersion: value.planVersion,
    planHash: value.planHash,
    nodeId: value.nodeId,
    visit: value.visit,
    attempt: value.attempt,
    purpose: value.purpose,
    ordinal: value.ordinal,
    workspace: value.workspace,
  });
  if (expected.idempotencyKey !== value.idempotencyKey || expected.requestRef !== value.requestRef) {
    throw new Error("BUILD worker budget action identity is invalid");
  }
  return Object.freeze({ ...expected, kind: value.kind });
}

function normalizeBudgetIntentInput(value: unknown): {
  now: string;
  unattended: boolean;
  eventId: string;
  estimatedCostUsd: number | "unknown";
  observedCostUsd: number | "unknown";
  inputTokens: number | "unknown";
  outputTokens: number | "unknown";
  checkpointRef: Readonly<GraphCheckpointRef>;
  routingDecisionId: string;
} {
  const record = requireRecord(value, "BUILD worker budget input");
  assertOnlyKeys(record, [
    "now", "unattended", "eventId", "estimatedCostUsd", "observedCostUsd", "inputTokens", "outputTokens",
    "checkpointRef", "routingDecisionId",
  ], "BUILD worker budget input");
  assertIsoTimestamp(record.now, "BUILD worker budget timestamp");
  if (typeof record.unattended !== "boolean" || typeof record.eventId !== "string" || !TOKEN.test(record.eventId) ||
      typeof record.routingDecisionId !== "string" || !TOKEN.test(record.routingDecisionId)) {
    throw new Error("BUILD worker budget execution identity is invalid");
  }
  const checkpointRef = normalizeCheckpointRef(record.checkpointRef);
  const result = {
    now: record.now,
    unattended: record.unattended,
    eventId: record.eventId,
    estimatedCostUsd: normalizeUsageEstimate(record.estimatedCostUsd, "BUILD worker estimated cost", false),
    observedCostUsd: normalizeUsageEstimate(record.observedCostUsd, "BUILD worker observed cost", false),
    inputTokens: normalizeUsageEstimate(record.inputTokens, "BUILD worker input tokens", true),
    outputTokens: normalizeUsageEstimate(record.outputTokens, "BUILD worker output tokens", true),
    checkpointRef,
    routingDecisionId: record.routingDecisionId,
  };
  if (result.unattended && Object.values(result).some((item) => item === "unknown")) {
    throw new Error("BUILD worker unattended budget input cannot contain unknown usage");
  }
  return result;
}

function normalizeCheckpointRef(value: unknown): Readonly<GraphCheckpointRef> {
  const record = requireRecord(value, "BUILD worker budget checkpoint");
  assertOnlyKeys(record, ["path", "sha256", "sizeBytes"], "BUILD worker budget checkpoint");
  if (typeof record.path !== "string" || !/^mutations\/[a-f0-9]{64}\.json$/.test(record.path) ||
      typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256) ||
      !Number.isSafeInteger(record.sizeBytes) || (record.sizeBytes as number) < 0 ||
      (record.sizeBytes as number) > 64 * 1024 * 1024) {
    throw new Error("BUILD worker budget checkpoint reference is invalid");
  }
  return Object.freeze({
    path: record.path,
    sha256: record.sha256,
    sizeBytes: record.sizeBytes as number,
  });
}

function normalizeUsageEstimate(value: unknown, label: string, integer: boolean): number | "unknown" {
  if (value === "unknown") return value;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function normalizeEffectInput(value: Readonly<BuildEffectIdentityInput>): BuildEffectIdentityInput {
  const record = requireRecord(value, "BUILD effect identity");
  assertOnlyKeys(record, [
    "runId", "planVersion", "planHash", "nodeId", "visit", "attempt", "purpose", "ordinal", "workspace",
  ], "BUILD effect identity");
  if (typeof record.runId !== "string" || !TOKEN.test(record.runId) ||
      typeof record.nodeId !== "string" || !TOKEN.test(record.nodeId) ||
      typeof record.planHash !== "string" || !SHA256.test(record.planHash)) {
    throw new Error("BUILD effect identity run, plan, or node identity is invalid");
  }
  assertPositiveInteger(record.planVersion, "BUILD effect plan version");
  assertPositiveInteger(record.visit, "BUILD effect visit");
  assertPositiveInteger(record.attempt, "BUILD effect attempt");
  if (typeof record.purpose !== "string" || !PURPOSES.has(record.purpose as BuildEffectPurpose)) {
    throw new Error("BUILD effect purpose is invalid");
  }
  const purpose = record.purpose as BuildEffectPurpose;
  if (record.ordinal !== BUILD_EFFECT_ORDINAL[purpose]) {
    throw new Error(`BUILD effect ordinal does not match purpose ${purpose}`);
  }
  const workspace = normalizeWorkspace(record.workspace, "BUILD effect workspace");
  return {
    runId: record.runId,
    planVersion: record.planVersion as number,
    planHash: record.planHash,
    nodeId: record.nodeId,
    visit: record.visit as number,
    attempt: record.attempt as number,
    purpose,
    ordinal: record.ordinal,
    workspace,
  };
}

function normalizeHumanEvidence(
  value: unknown,
  state: Readonly<GraphExecutionState>,
  nodeId: string,
): ArtifactReference {
  const record = requireRecord(value, "BUILD human integration evidence");
  assertOnlyKeys(record, ["planVersion", "nodeId", "contract", "path", "sha256", "sizeBytes"], "BUILD human integration evidence");
  if (record.planVersion !== state.planVersion || record.nodeId !== nodeId || typeof record.contract !== "string" ||
      typeof record.path !== "string" || !record.path.startsWith(`nodes/${state.planVersion}/${nodeId}/`) ||
      record.path.includes("\\") || record.path.split("/").some((part) => part.length === 0 || part === "." || part === "..") ||
      typeof record.sha256 !== "string" || !SHA256.test(record.sha256) || !Number.isSafeInteger(record.sizeBytes) ||
      (record.sizeBytes as number) < 0 || (record.sizeBytes as number) > 64 * 1024 * 1024) {
    throw new Error("BUILD human integration evidence identity is invalid");
  }
  return Object.freeze({
    planVersion: record.planVersion,
    nodeId: record.nodeId,
    contract: record.contract,
    path: record.path,
    sha256: record.sha256,
    sizeBytes: record.sizeBytes,
  }) as ArtifactReference;
}

function normalizePolicy(value: Readonly<BuildExecutionPolicy>): BuildExecutionPolicy {
  const record = requireRecord(value, "BUILD execution policy");
  assertOnlyKeys(record, POLICY_KEYS, "BUILD execution policy");
  assertIsoTimestamp(record.now, "BUILD execution policy timestamp");
  if (typeof record.unattended !== "boolean" || typeof record.allowParallelWrites !== "boolean" ||
      typeof record.allowWorktreeCreation !== "boolean" || typeof record.trustRepositoryCheckout !== "boolean") {
    throw new Error("BUILD execution policy gates must be boolean");
  }
  assertPositiveInteger(record.maxReadOnlyFanOut, "BUILD read-only fan-out limit");
  return record as unknown as BuildExecutionPolicy;
}

function normalizeCheckpoints(
  compiled: Readonly<CompiledBuildPlan>,
  state: Readonly<GraphExecutionState>,
  values: readonly Readonly<BuildDispatchCheckpoint>[],
): ReadonlyMap<string, Readonly<BuildDispatchCheckpoint>> {
  const data = requireDataArray(values, "BUILD dispatch checkpoints", 1_024);
  const result = new Map<string, Readonly<BuildDispatchCheckpoint>>();
  for (const [index, candidate] of data.entries()) {
    const checkpoint = assertBuildDispatchCheckpoint(candidate);
    if (checkpoint.runId !== state.runId || checkpoint.planVersion !== state.planVersion ||
        checkpoint.planHash !== compiled.hash || !compiled.graph.nodesById.has(checkpoint.nodeId)) {
      throw new Error(`BUILD dispatch checkpoint ${index} identity or status is invalid`);
    }
    if (result.has(checkpoint.idempotencyKey)) throw new Error("BUILD dispatch checkpoints contain a duplicate effect");
    result.set(checkpoint.idempotencyKey, checkpoint);
  }
  return result;
}

function normalizeWorkspaceForNode(
  compiled: Readonly<CompiledBuildPlan>,
  state: Readonly<GraphExecutionState>,
  definition: Readonly<CompiledBuildPlan["plan"]["nodes"][number]>,
  supplied: Readonly<BuildWorkspaceIdentity> | undefined,
  nodeId: string,
): BuildWorkspaceIdentity {
  if (definition.workspace === "shared") {
    if (supplied !== undefined && normalizeWorkspace(supplied, `BUILD workspace for ${nodeId}`).kind !== "shared") {
      throw new Error(`BUILD shared node ${nodeId} cannot bind an isolated workspace`);
    }
    return Object.freeze({ kind: "shared" });
  }
  if (supplied === undefined) throw new Error(`BUILD isolated node ${nodeId} requires a prepared worktree identity`);
  const workspace = normalizeWorkspace(supplied, `BUILD workspace for ${nodeId}`);
  if (workspace.kind === "shared") throw new Error(`BUILD isolated node ${nodeId} requires worktree identity`);
  const expectedOwnerNodeId = definition.handler === "validate" ? definition.targetWorktreeNodeId : nodeId;
  if (!expectedOwnerNodeId || workspace.runId !== state.runId || workspace.planVersion !== state.planVersion ||
      workspace.planHash !== compiled.hash || workspace.ownerNodeId !== expectedOwnerNodeId) {
    throw new Error(`BUILD workspace authority for ${nodeId} must match run, plan, and target ${expectedOwnerNodeId ?? nodeId}`);
  }
  if (definition.handler === "validate" && workspace.kind !== "owned-worktree") {
    throw new Error(`BUILD validator ${nodeId} requires owned authority for target ${expectedOwnerNodeId}`);
  }
  return workspace;
}

function normalizeWorkspace(value: unknown, label: string): BuildWorkspaceIdentity {
  const record = requireRecord(value, label);
  if (record.kind === "shared") {
    assertOnlyKeys(record, ["kind"], label);
    return Object.freeze({ kind: "shared" });
  }
  if (record.kind === "planned-worktree") {
    assertOnlyKeys(record, [
      "kind", "intentId", "runId", "planVersion", "planHash", "ownerNodeId", "baseSha", "worktreePath",
    ], label);
    return Object.freeze({ kind: "planned-worktree", ...normalizeWorktreeAuthority(record, label) });
  }
  assertOnlyKeys(record, [
    "kind", "intentId", "runId", "planVersion", "planHash", "ownerNodeId", "baseSha", "worktreePath",
    "ownershipReceiptHash",
  ], label);
  if (record.kind !== "owned-worktree" || typeof record.ownershipReceiptHash !== "string" ||
      !SHA256.test(record.ownershipReceiptHash)) {
    throw new Error(`${label} ownership identity is invalid`);
  }
  return Object.freeze({
    kind: "owned-worktree",
    ...normalizeWorktreeAuthority(record, label),
    ownershipReceiptHash: record.ownershipReceiptHash,
  });
}

function plannedWorkspace(workspace: Readonly<BuildWorkspaceIdentity>, nodeId: string): BuildWorkspaceIdentity {
  if (workspace.kind === "shared") throw new Error(`BUILD isolated node ${nodeId} requires a planned worktree identity`);
  return Object.freeze({
    kind: "planned-worktree",
    intentId: workspace.intentId,
    runId: workspace.runId,
    planVersion: workspace.planVersion,
    planHash: workspace.planHash,
    ownerNodeId: workspace.ownerNodeId,
    baseSha: workspace.baseSha,
    worktreePath: workspace.worktreePath,
  });
}

function normalizeWorktreeAuthority(record: Record<string, unknown>, label: string): BuildWorktreeAuthority {
  if (typeof record.intentId !== "string" || !SHA256.test(record.intentId) ||
      typeof record.runId !== "string" || !TOKEN.test(record.runId) ||
      !Number.isSafeInteger(record.planVersion) || (record.planVersion as number) <= 0 ||
      typeof record.planHash !== "string" || !SHA256.test(record.planHash) ||
      typeof record.ownerNodeId !== "string" || !TOKEN.test(record.ownerNodeId) ||
      typeof record.baseSha !== "string" || !GIT_SHA.test(record.baseSha) ||
      typeof record.worktreePath !== "string" || !isAbsolute(record.worktreePath) ||
      resolve(record.worktreePath) !== record.worktreePath || Buffer.byteLength(record.worktreePath, "utf8") > 4_096 ||
      /[\u0000-\u001f\u007f]/.test(record.worktreePath)) {
    throw new Error(`${label} worktree authority is invalid`);
  }
  return {
    intentId: record.intentId,
    runId: record.runId,
    planVersion: record.planVersion as number,
    planHash: record.planHash,
    ownerNodeId: record.ownerNodeId,
    baseSha: record.baseSha,
    worktreePath: record.worktreePath,
  };
}

function effectStages(
  handler: "inspect" | "design" | "implement" | "validate" | "integrate",
  workspace: "shared" | "isolated-worktree",
): readonly { purpose: BuildEffectPurpose; kind: Exclude<BuildRunningActionKind, "reconcile-unknown"> }[] {
  if (handler === "integrate") return [];
  if (handler === "validate") return [{ purpose: "validator", kind: "validate-outputs" }];
  return [
    ...(handler === "implement" && workspace === "isolated-worktree"
      ? [{ purpose: "worktree" as const, kind: "materialize-worktree" as const }]
      : []),
    { purpose: "worker", kind: "invoke-worker" },
    { purpose: "validator", kind: "validate-outputs" },
  ];
}

function assertBuildIdentity(compiled: Readonly<CompiledBuildPlan>, state: Readonly<GraphExecutionState>): void {
  if (state.planVersion !== compiled.plan.planVersion || state.graphDigest !== sha256(stableJson(compiled.graph.definition))) {
    throw new Error("BUILD execution state does not match the immutable plan identity");
  }
}

function buildNode(compiled: Readonly<CompiledBuildPlan>, nodeId: string) {
  const definition = compiled.plan.nodes.find((candidate) => candidate.id === nodeId);
  if (!definition) throw new Error(`BUILD execution is missing node policy for ${nodeId}`);
  return definition;
}

function resourceConflict(compiled: Readonly<CompiledBuildPlan>, candidateId: string, activeIds: readonly string[]): boolean {
  const candidate = compiled.nodePolicies[candidateId]!;
  return activeIds.some((activeId) => {
    const active = compiled.nodePolicies[activeId];
    return active !== undefined && candidate.resourceLocks.some((left) =>
      active.resourceLocks.some((right) => locksConflict(left, right)));
  });
}

function locksConflict(left: Readonly<BuildResourceLock>, right: Readonly<BuildResourceLock>): boolean {
  if (left.kind !== right.kind || (left.mode === "shared" && right.mode === "shared")) return false;
  if (left.kind === "logical") return fold(left.value) === fold(right.value);
  return pathsOverlap(left.value, right.value);
}

function sharedWriterConflict(compiled: Readonly<CompiledBuildPlan>, candidateId: string, activeIds: readonly string[]): boolean {
  const candidateShared = isSharedWriter(compiled, candidateId);
  const activeShared = activeIds.some((activeId) => isSharedWriter(compiled, activeId));
  return (candidateShared && activeIds.length > 0) || (!candidateShared && activeShared);
}

function isReadOnlyNode(compiled: Readonly<CompiledBuildPlan>, nodeId: string): boolean {
  const node = buildNode(compiled, nodeId);
  return node.sideEffect === "none" || node.sideEffect === "read";
}

function isWriteNode(compiled: Readonly<CompiledBuildPlan>, nodeId: string): boolean {
  return buildNode(compiled, nodeId).handler === "implement";
}

function isSharedWriter(compiled: Readonly<CompiledBuildPlan>, nodeId: string): boolean {
  const node = buildNode(compiled, nodeId);
  return node.handler === "implement" && node.workspace === "shared";
}

function isIsolatedWriter(compiled: Readonly<CompiledBuildPlan>, nodeId: string): boolean {
  const node = buildNode(compiled, nodeId);
  return node.handler === "implement" && node.workspace === "isolated-worktree";
}

function pathsOverlap(left: string, right: string): boolean {
  const foldedLeft = fold(left);
  const foldedRight = fold(right);
  return foldedLeft === foldedRight || foldedLeft.startsWith(`${foldedRight}/`) || foldedRight.startsWith(`${foldedLeft}/`);
}

function fold(value: string): string {
  return value.toLowerCase();
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.values(Object.getOwnPropertyDescriptors(value));
  if ((prototype !== Object.prototype && prototype !== null) || descriptors.some((descriptor) => !("value" in descriptor))) {
    throw new Error(`${label} must be a plain object containing data properties`);
  }
  return value as Record<string, unknown>;
}

function requireDataArray(value: unknown, label: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) {
    throw new Error(`${label} must be a bounded array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor)) throw new Error(`${label} must be a dense data-property array`);
  }
  const extras = Reflect.ownKeys(descriptors).filter((key) => typeof key !== "string" ||
    (key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)));
  if (extras.length > 0) throw new Error(`${label} contains unsupported properties`);
  return value;
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extras = Reflect.ownKeys(record).filter((key) => typeof key !== "string" || !allowed.includes(key));
  if (extras.length > 0) throw new Error(`${label} contains unsupported fields`);
}

function assertIsoTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive integer`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
