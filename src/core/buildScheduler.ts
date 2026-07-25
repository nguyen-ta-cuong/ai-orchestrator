import { createHash } from "node:crypto";
import type {
  BuildOutputContract,
  BuildResourceLock,
  BuildValidationKind,
  CompiledBuildPlan,
} from "./buildPlan.js";
import { requireBuildRepositoryPath } from "./repositoryPath.js";
import {
  assertScheduleValid,
  evaluateExecutionGuard,
  type ArtifactReference,
  type GraphExecutionState,
} from "./scheduler.js";

export type BuildDispatchBlockCode =
  | "checkout-trust-required"
  | "concurrency-limit"
  | "graph-step-limit"
  | "human-integration-required"
  | "parallel-write-disabled"
  | "resource-conflict"
  | "shared-workspace-busy"
  | "worktree-not-owned"
  | (string & {});

export interface BuildDispatchPolicy {
  now: string;
  unattended: boolean;
  allowParallelWrites: boolean;
  trustRepositoryCheckout: boolean;
  worktreeOwnerships: readonly Readonly<BuildWorktreeOwnershipProof>[];
}

export interface BuildWorktreeOwnershipProof {
  schemaVersion: 1;
  intentId: string;
  runId: string;
  nodeId: string;
  planVersion: number;
  planHash: string;
  baseSha: string;
  reconciled: true;
  cleanupStatus: "active";
}

export interface BuildDispatchNode {
  nodeId: string;
  handler: "inspect" | "design" | "implement" | "validate";
  workspace: "shared" | "isolated-worktree";
  toolPolicy: "read-only" | "declared-writes" | "reviewed-validation";
  timeoutMs: number;
  idempotencyKey: string;
  worktreeOwnershipId?: string;
  targetWorktreeNodeId?: string;
}

export interface BuildDispatchBlock {
  nodeId: string;
  code: BuildDispatchBlockCode;
}

export interface BuildDispatchPlan {
  dispatch: readonly Readonly<BuildDispatchNode>[];
  blocked: readonly Readonly<BuildDispatchBlock>[];
  humanIntegrationNodeId?: string;
}

export interface BuildOutputObservation {
  contractId: string;
  validation: BuildValidationKind;
  artifact: ArtifactReference;
}

export interface BuildArtifactInspection {
  exists: boolean;
  sha256: string;
  sizeBytes: number;
  structured?: {
    validatorRef: string;
    valid: boolean;
  };
  reviewedCommand?: {
    validatorRef: string;
    approved: boolean;
    exitCode: number;
    evidenceSha256: string;
  };
}

export interface BuildWorkspaceInspection {
  schemaVersion: 1;
  ownership: Readonly<BuildWorktreeOwnershipProof>;
  changedPaths: readonly string[];
  stagedPaths: readonly string[];
}

export interface BuildOutputValidationAdapter {
  /** Trusted runtime boundary: inspect bytes and execute only the pre-reviewed validator reference. */
  inspect(input: Readonly<{
    runId: string;
    planHash: string;
    nodeId: string;
    contract: Readonly<BuildOutputContract>;
    artifact: Readonly<ArtifactReference>;
  }>): unknown;
  /** Trusted runtime boundary: reconcile Git and inspect the target worktree after validators run. */
  inspectWorkspace?(input: Readonly<{
    runId: string;
    planVersion: number;
    planHash: string;
    nodeId: string;
    targetWorktreeNodeId: string;
    declaredWriteSet: readonly string[];
  }>): unknown;
}

const POLICY_KEYS = [
  "now",
  "unattended",
  "allowParallelWrites",
  "trustRepositoryCheckout",
  "worktreeOwnerships",
] as const;
const OWNERSHIP_KEYS = [
  "schemaVersion", "intentId", "runId", "nodeId", "planVersion", "planHash", "baseSha", "reconciled", "cleanupStatus",
] as const;
const OBSERVATION_KEYS = ["contractId", "validation", "artifact"] as const;
const WORKSPACE_INSPECTION_KEYS = ["schemaVersion", "ownership", "changedPaths", "stagedPaths"] as const;
const VALIDATIONS = new Set<BuildValidationKind>([
  "exists",
  "sha256",
  "structured",
  "reviewed-command",
  "human-review",
]);
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACT_PATH_BYTES = 1_024;
const MAX_WORKSPACE_CHANGED_PATHS = 4_096;

/**
 * Select one deterministic dispatch batch without mutating scheduler authority.
 * Model/tool invocation and worktree creation remain separate guarded effects.
 */
export function planBuildDispatch(
  compiled: Readonly<CompiledBuildPlan>,
  state: Readonly<GraphExecutionState>,
  policyValue: Readonly<BuildDispatchPolicy>,
): BuildDispatchPlan {
  assertBuildPlanIdentity(compiled, state);
  assertScheduleValid(compiled.graph, state, compiled.schedulerMetadata);
  const policy = validatePolicy(compiled, state, policyValue);
  const ownerships = new Map(policy.worktreeOwnerships.map((ownership) => [ownership.nodeId, ownership]));
  const running = [...state.guard.runningNodes];
  const selected: string[] = [];
  const dispatch: BuildDispatchNode[] = [];
  const blocked: BuildDispatchBlock[] = [];
  let humanIntegrationNodeId: string | undefined;

  const concurrencyCapacity = Math.max(0, state.effectiveLimits.maxConcurrency - running.length);
  const stepCapacity = Math.max(0, state.effectiveLimits.maxGraphSteps - state.guard.steps);

  for (const nodeId of state.ready) {
    const definition = compiled.plan.nodes.find((candidate) => candidate.id === nodeId);
    const nodePolicy = compiled.nodePolicies[nodeId];
    if (!definition || !nodePolicy) throw new Error(`BUILD dispatch is missing compiled policy for ${nodeId}`);

    if (definition.handler === "integrate") {
      humanIntegrationNodeId ??= nodeId;
      blocked.push({ nodeId, code: "human-integration-required" });
      continue;
    }

    const worktreeNodeId = definition.handler === "implement" && definition.workspace === "isolated-worktree"
      ? nodeId
      : definition.handler === "validate" && definition.workspace === "isolated-worktree"
        ? definition.targetWorktreeNodeId
        : undefined;
    const ownership = worktreeNodeId === undefined ? undefined : ownerships.get(worktreeNodeId);
    if (worktreeNodeId !== undefined) {
      if (!ownership) {
        blocked.push({ nodeId, code: "worktree-not-owned" });
        continue;
      }
      if (!policy.trustRepositoryCheckout) {
        blocked.push({ nodeId, code: "checkout-trust-required" });
        continue;
      }
    }

    if (sharedWorkspaceMutationConflicts(compiled, nodeId, [...running, ...selected])) {
      blocked.push({ nodeId, code: "shared-workspace-busy" });
      continue;
    }
    if (resourceConflicts(compiled, nodeId, [...running, ...selected])) {
      blocked.push({ nodeId, code: "resource-conflict" });
      continue;
    }
    if (isIsolatedWrite(definition) && !policy.allowParallelWrites &&
        [...running, ...selected].some((active) => isWriteNode(compiled, active))) {
      blocked.push({ nodeId, code: "parallel-write-disabled" });
      continue;
    }
    if (selected.length >= concurrencyCapacity) {
      blocked.push({ nodeId, code: "concurrency-limit" });
      continue;
    }
    if (selected.length >= stepCapacity) {
      blocked.push({ nodeId, code: "graph-step-limit" });
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

    selected.push(nodeId);
    if (nodePolicy.toolPolicy === "human-integration") {
      throw new Error(`BUILD dispatch cannot execute human-integration policy for ${nodeId}`);
    }
    dispatch.push({
      nodeId,
      handler: definition.handler,
      workspace: nodePolicy.workspace,
      toolPolicy: nodePolicy.toolPolicy,
      timeoutMs: definition.timeoutMs,
      idempotencyKey: buildNodeIdempotencyKey(compiled, state, nodeId, ownership),
      ...(ownership === undefined ? {} : {
        worktreeOwnershipId: ownership.intentId,
        targetWorktreeNodeId: worktreeNodeId,
      }),
    });
  }

  return Object.freeze({
    dispatch: Object.freeze(dispatch.map((item) => Object.freeze(item))),
    blocked: Object.freeze(blocked.map((item) => Object.freeze(item))),
    ...(humanIntegrationNodeId === undefined ? {} : { humanIntegrationNodeId }),
  });
}

/**
 * Convert already-inspected validator evidence to scheduler artifact refs.
 * This function never infers success from file existence or model prose.
 */
export function validateBuildNodeOutputs(
  compiled: Readonly<CompiledBuildPlan>,
  state: Readonly<GraphExecutionState>,
  nodeId: string,
  observationsValue: readonly Readonly<BuildOutputObservation>[],
  adapter: Readonly<BuildOutputValidationAdapter>,
): readonly Readonly<ArtifactReference>[] {
  assertBuildPlanIdentity(compiled, state);
  assertScheduleValid(compiled.graph, state, compiled.schedulerMetadata);
  const definition = compiled.plan.nodes.find((candidate) => candidate.id === nodeId);
  if (!definition) throw new Error(`Unknown BUILD output node ${nodeId}`);
  if (state.nodeStates[nodeId]?.status !== "running") {
    throw new Error(`BUILD output validation requires running node ${nodeId}`);
  }
  const adapterRecord = requireRecord(adapter, "BUILD output validation adapter");
  assertOnlyKeys(adapterRecord, ["inspect", "inspectWorkspace"], "BUILD output validation adapter");
  if (typeof adapterRecord.inspect !== "function") throw new Error("BUILD output validation adapter inspect must be a function");
  if (adapterRecord.inspectWorkspace !== undefined && typeof adapterRecord.inspectWorkspace !== "function") {
    throw new Error("BUILD output validation adapter inspectWorkspace must be a function");
  }
  if (targetWorktreeNodeIdForOutput(definition) !== undefined && typeof adapterRecord.inspectWorkspace !== "function") {
    throw new Error(`BUILD isolated node ${definition.id} requires trusted workspace inspection`);
  }
  const observationValues = requireDataArray(
    observationsValue,
    "BUILD output observations",
    definition.outputContracts.length + 1,
  );
  const observations = observationValues.map((value, index) => validateObservation(value, index));
  const ids = observations.map(({ contractId }) => contractId);
  if (new Set(ids).size !== ids.length) throw new Error("BUILD output observations contain a duplicate contract");
  const declaredIds = definition.outputContracts.map(({ id }) => id).sort();
  const actualIds = [...ids].sort();
  if (!sameStrings(declaredIds, actualIds)) {
    throw new Error(`BUILD output observations must exactly match declared contracts for ${nodeId}`);
  }

  const references = observations.map((observation) => {
    const contract = definition.outputContracts.find(({ id }) => id === observation.contractId)!;
    if (observation.validation !== contract.validation) {
      throw new Error(`BUILD output ${contract.id} validation policy does not match the immutable plan`);
    }
    const artifact = normalizeArtifactIdentity(observation.artifact, state, nodeId, contract.id);
    const inspection = validateInspection(adapter.inspect(Object.freeze({
      runId: state.runId,
      planHash: compiled.hash,
      nodeId,
      contract,
      artifact,
    })), contract);
    assertInspectionMatchesArtifact(inspection, artifact, contract);
    return artifact;
  });
  references.sort((left, right) => compareCodeUnits(left.contract, right.contract));
  validateIsolatedWorkspace(compiled, state, definition, adapterRecord.inspectWorkspace);
  return Object.freeze(references);
}

function validatePolicy(
  compiled: Readonly<CompiledBuildPlan>,
  state: Readonly<GraphExecutionState>,
  value: Readonly<BuildDispatchPolicy>,
): BuildDispatchPolicy {
  const record = requireRecord(value, "BUILD dispatch policy");
  assertOnlyKeys(record, POLICY_KEYS, "BUILD dispatch policy");
  if (typeof record.now !== "string" || !Number.isFinite(Date.parse(record.now)) ||
      new Date(record.now).toISOString() !== record.now) {
    throw new Error("BUILD dispatch policy now must be an ISO timestamp");
  }
  for (const key of ["unattended", "allowParallelWrites", "trustRepositoryCheckout"] as const) {
    if (typeof record[key] !== "boolean") throw new Error(`BUILD dispatch policy ${key} must be boolean`);
  }
  const unattended = record.unattended as boolean;
  const allowParallelWrites = record.allowParallelWrites as boolean;
  const trustRepositoryCheckout = record.trustRepositoryCheckout as boolean;
  const ownedValues = requireDataArray(
    record.worktreeOwnerships,
    "BUILD dispatch worktree ownership proofs",
    compiled.plan.nodes.length,
  );
  const worktreeOwnerships = ownedValues.map((candidate, index) => normalizeOwnershipProof(
    compiled,
    state,
    candidate,
    `BUILD dispatch worktree ownership ${index}`,
  ));
  if (new Set(worktreeOwnerships.map(({ nodeId }) => nodeId)).size !== worktreeOwnerships.length) {
    throw new Error("BUILD dispatch worktree ownership proofs contain duplicate nodes");
  }
  return {
    now: record.now,
    unattended,
    allowParallelWrites,
    trustRepositoryCheckout,
    worktreeOwnerships: Object.freeze([...worktreeOwnerships].sort((left, right) => compareCodeUnits(left.nodeId, right.nodeId))),
  };
}

function validateIsolatedWorkspace(
  compiled: Readonly<CompiledBuildPlan>,
  state: Readonly<GraphExecutionState>,
  definition: Readonly<CompiledBuildPlan["plan"]["nodes"][number]>,
  inspectWorkspace: unknown,
): void {
  const targetWorktreeNodeId = targetWorktreeNodeIdForOutput(definition);
  if (targetWorktreeNodeId === undefined) return;
  if (typeof inspectWorkspace !== "function") {
    throw new Error(`BUILD isolated node ${definition.id} requires trusted workspace inspection`);
  }
  const target = compiled.plan.nodes.find(({ id }) => id === targetWorktreeNodeId);
  if (!target || target.handler !== "implement" || target.workspace !== "isolated-worktree") {
    throw new Error(`BUILD isolated node ${definition.id} has an invalid target worktree`);
  }
  const declaredWriteSet = Object.freeze([...target.writeSet]);
  const rawInspection = inspectWorkspace(Object.freeze({
    runId: state.runId,
    planVersion: state.planVersion,
    planHash: compiled.hash,
    nodeId: definition.id,
    targetWorktreeNodeId,
    declaredWriteSet,
  }));
  const inspection = requireRecord(rawInspection, `BUILD node ${definition.id} workspace inspection`);
  assertOnlyKeys(inspection, WORKSPACE_INSPECTION_KEYS, `BUILD node ${definition.id} workspace inspection`);
  if (inspection.schemaVersion !== 1) throw new Error(`BUILD node ${definition.id} workspace inspection version is invalid`);
  const ownership = normalizeOwnershipProof(
    compiled,
    state,
    inspection.ownership,
    `BUILD node ${definition.id} workspace ownership`,
  );
  if (ownership.nodeId !== targetWorktreeNodeId) {
    throw new Error(`BUILD node ${definition.id} workspace ownership targets the wrong implement node`);
  }
  buildNodeIdempotencyKey(compiled, state, definition.id, ownership);

  const changedValues = requireDataArray(
    inspection.changedPaths,
    `BUILD node ${definition.id} changed paths`,
    MAX_WORKSPACE_CHANGED_PATHS,
  );
  const changedPaths = changedValues.map((path, index) =>
    requireBuildRepositoryPath(path, `BUILD node ${definition.id} changed path ${index}`));
  if (new Set(changedPaths).size !== changedPaths.length) {
    throw new Error(`BUILD node ${definition.id} workspace inspection contains duplicate changed paths`);
  }
  for (const changed of changedPaths) {
    if (!declaredWriteSet.some((allowed) => pathContains(allowed, changed))) {
      throw new Error(`BUILD node ${definition.id} workspace inspection contains undeclared write ${changed}`);
    }
  }
  const stagedPaths = requireDataArray(
    inspection.stagedPaths,
    `BUILD node ${definition.id} staged paths`,
    MAX_WORKSPACE_CHANGED_PATHS,
  );
  if (stagedPaths.length > 0) throw new Error(`BUILD node ${definition.id} workspace inspection contains staged changes`);
}

function targetWorktreeNodeIdForOutput(
  definition: Readonly<CompiledBuildPlan["plan"]["nodes"][number]>,
): string | undefined {
  if (definition.handler === "implement" && definition.workspace === "isolated-worktree") return definition.id;
  if (definition.handler === "validate" && definition.workspace === "isolated-worktree") {
    return definition.targetWorktreeNodeId;
  }
  return undefined;
}

function normalizeOwnershipProof(
  compiled: Readonly<CompiledBuildPlan>,
  state: Readonly<GraphExecutionState>,
  value: unknown,
  label: string,
): Readonly<BuildWorktreeOwnershipProof> {
  const proof = requireRecord(value, label);
  assertOnlyKeys(proof, OWNERSHIP_KEYS, label);
  if (proof.schemaVersion !== 1 || typeof proof.intentId !== "string" || !SHA256.test(proof.intentId) ||
      proof.runId !== state.runId || typeof proof.nodeId !== "string" ||
      proof.planVersion !== state.planVersion || proof.planHash !== compiled.hash ||
      typeof proof.baseSha !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(proof.baseSha) ||
      proof.reconciled !== true || proof.cleanupStatus !== "active") {
    throw new Error(`${label} identity is invalid`);
  }
  const node = compiled.plan.nodes.find(({ id }) => id === proof.nodeId);
  if (!node || node.handler !== "implement" || node.workspace !== "isolated-worktree") {
    throw new Error(`${label} is not an isolated implement node`);
  }
  return Object.freeze({ ...proof }) as unknown as Readonly<BuildWorktreeOwnershipProof>;
}

function validateObservation(value: unknown, index: number): BuildOutputObservation {
  const record = requireRecord(value, `BUILD output observation ${index}`);
  assertOnlyKeys(record, OBSERVATION_KEYS, `BUILD output observation ${index}`);
  if (typeof record.contractId !== "string" || record.contractId.length === 0 ||
      record.contractId.length > 128 || /[\u0000-\u001f\u007f]/.test(record.contractId)) {
    throw new Error(`BUILD output observation ${index} contract is invalid`);
  }
  if (typeof record.validation !== "string" || !VALIDATIONS.has(record.validation as BuildValidationKind)) {
    throw new Error(`BUILD output observation ${index} validation is invalid`);
  }
  requireRecord(record.artifact, `BUILD output observation ${index} artifact`);
  return {
    contractId: record.contractId,
    validation: record.validation as BuildValidationKind,
    artifact: record.artifact as ArtifactReference,
  };
}

function validateInspection(value: unknown, contract: Readonly<BuildOutputContract>): BuildArtifactInspection {
  const inspection = requireRecord(value, `BUILD output ${contract.id} inspection`);
  assertOnlyKeys(inspection, ["exists", "sha256", "sizeBytes", "structured", "reviewedCommand"], `BUILD output ${contract.id} inspection`);
  if (typeof inspection.exists !== "boolean" || typeof inspection.sha256 !== "string" || !SHA256.test(inspection.sha256) ||
      !Number.isSafeInteger(inspection.sizeBytes) || (inspection.sizeBytes as number) < 0 ||
      (inspection.sizeBytes as number) > MAX_ARTIFACT_BYTES) {
    throw new Error(`BUILD output ${contract.id} inspection is invalid`);
  }
  const normalized: BuildArtifactInspection = {
    exists: inspection.exists,
    sha256: inspection.sha256,
    sizeBytes: inspection.sizeBytes as number,
  };
  if (inspection.structured !== undefined) {
    const structured = requireRecord(inspection.structured, `BUILD output ${contract.id} structured inspection`);
    assertOnlyKeys(structured, ["validatorRef", "valid"], `BUILD output ${contract.id} structured inspection`);
    if (typeof structured.validatorRef !== "string" || typeof structured.valid !== "boolean") {
      throw new Error(`BUILD output ${contract.id} structured inspection is invalid`);
    }
    normalized.structured = { validatorRef: structured.validatorRef, valid: structured.valid };
  }
  if (inspection.reviewedCommand !== undefined) {
    const command = requireRecord(inspection.reviewedCommand, `BUILD output ${contract.id} command inspection`);
    assertOnlyKeys(command, ["validatorRef", "approved", "exitCode", "evidenceSha256"], `BUILD output ${contract.id} command inspection`);
    if (typeof command.validatorRef !== "string" || typeof command.approved !== "boolean" ||
        !Number.isSafeInteger(command.exitCode) || typeof command.evidenceSha256 !== "string" ||
        !SHA256.test(command.evidenceSha256)) {
      throw new Error(`BUILD output ${contract.id} command inspection is invalid`);
    }
    normalized.reviewedCommand = {
      validatorRef: command.validatorRef,
      approved: command.approved,
      exitCode: command.exitCode as number,
      evidenceSha256: command.evidenceSha256,
    };
  }
  return normalized;
}

function assertInspectionMatchesArtifact(
  inspection: Readonly<BuildArtifactInspection>,
  artifact: Readonly<ArtifactReference>,
  contract: Readonly<BuildOutputContract>,
): void {
  if (!inspection.exists || inspection.sha256 !== artifact.sha256 || inspection.sizeBytes !== artifact.sizeBytes) {
    throw new Error(`BUILD output ${contract.id} inspected bytes do not match artifact identity`);
  }
  if (contract.validation === "structured") {
    if (!inspection.structured?.valid || inspection.structured.validatorRef !== contract.validatorRef ||
        inspection.reviewedCommand !== undefined) {
      throw new Error(`BUILD output ${contract.id} failed its structured validator`);
    }
  } else if (contract.validation === "reviewed-command") {
    const command = inspection.reviewedCommand;
    if (!command?.approved || command.exitCode !== 0 || command.validatorRef !== contract.validatorRef ||
        command.evidenceSha256 !== artifact.sha256 || inspection.structured !== undefined) {
      throw new Error(`BUILD output ${contract.id} failed its reviewed command`);
    }
  } else if (contract.validation === "human-review") {
    throw new Error(`BUILD output ${contract.id} requires an explicit human review gate`);
  } else if (inspection.structured !== undefined || inspection.reviewedCommand !== undefined) {
    throw new Error(`BUILD output ${contract.id} inspection contains an undeclared validator result`);
  }
}

function normalizeArtifactIdentity(
  value: unknown,
  state: Readonly<GraphExecutionState>,
  nodeId: string,
  contract: string,
): Readonly<ArtifactReference> {
  const artifact = requireRecord(value, `BUILD output ${contract} artifact`);
  assertOnlyKeys(
    artifact,
    ["planVersion", "nodeId", "contract", "path", "sha256", "sizeBytes"],
    `BUILD output ${contract} artifact`,
  );
  const prefix = `nodes/${state.planVersion}/${nodeId}/`;
  if (artifact.planVersion !== state.planVersion || artifact.nodeId !== nodeId || artifact.contract !== contract ||
      typeof artifact.path !== "string" || !isCanonicalArtifactPath(artifact.path, prefix) ||
      typeof artifact.sha256 !== "string" || !SHA256.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.sizeBytes) || (artifact.sizeBytes as number) < 0 ||
      (artifact.sizeBytes as number) > MAX_ARTIFACT_BYTES) {
    throw new Error(`BUILD output ${contract} artifact identity is invalid`);
  }
  return Object.freeze({
    planVersion: artifact.planVersion,
    nodeId: artifact.nodeId,
    contract: artifact.contract,
    path: artifact.path,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes,
  }) as Readonly<ArtifactReference>;
}

function buildNodeIdempotencyKey(
  compiled: Readonly<CompiledBuildPlan>,
  state: Readonly<GraphExecutionState>,
  nodeId: string,
  ownership: Readonly<BuildWorktreeOwnershipProof> | undefined,
): string {
  const node = state.nodeStates[nodeId]!;
  const workspaceIdentity = ownership === undefined
    ? "shared"
    : `worktree\0${ownership.intentId}\0${ownership.baseSha}`;
  const expected = createHash("sha256").update(
    `${state.runId}\0${state.planVersion}\0${compiled.hash}\0${nodeId}\0${node.visits}\0${workspaceIdentity}`,
  ).digest("hex");
  if (node.idempotencyKey !== undefined && node.idempotencyKey !== expected) {
    throw new Error(`BUILD node ${nodeId} persisted idempotency does not match its authoritative worktree ownership`);
  }
  return expected;
}

function assertBuildPlanIdentity(
  compiled: Readonly<CompiledBuildPlan>,
  state: Readonly<GraphExecutionState>,
): void {
  if (state.planVersion !== compiled.plan.planVersion) {
    throw new Error(
      `Scheduler plan version ${state.planVersion} does not match immutable BUILD plan version ${compiled.plan.planVersion}`,
    );
  }
}

function resourceConflicts(
  compiled: Readonly<CompiledBuildPlan>,
  candidateId: string,
  activeIds: readonly string[],
): boolean {
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

function sharedWorkspaceMutationConflicts(
  compiled: Readonly<CompiledBuildPlan>,
  candidateId: string,
  activeIds: readonly string[],
): boolean {
  const candidateShared = isSharedWrite(compiled, candidateId);
  const activeShared = activeIds.some((activeId) => isSharedWrite(compiled, activeId));
  return (candidateShared && activeIds.length > 0) || (!candidateShared && activeShared);
}

function isSharedWrite(compiled: Readonly<CompiledBuildPlan>, nodeId: string): boolean {
  const node = compiled.plan.nodes.find((candidate) => candidate.id === nodeId);
  return node?.handler === "implement" && node.workspace === "shared";
}

function isWriteNode(compiled: Readonly<CompiledBuildPlan>, nodeId: string): boolean {
  return compiled.plan.nodes.find((candidate) => candidate.id === nodeId)?.handler === "implement";
}

function isIsolatedWrite(node: Readonly<CompiledBuildPlan["plan"]["nodes"][number]>): boolean {
  return node.handler === "implement" && node.workspace === "isolated-worktree";
}

function pathsOverlap(left: string, right: string): boolean {
  const foldedLeft = fold(left);
  const foldedRight = fold(right);
  return foldedLeft === foldedRight || foldedLeft.startsWith(`${foldedRight}/`) || foldedRight.startsWith(`${foldedLeft}/`);
}

function pathContains(parent: string, child: string): boolean {
  const foldedParent = fold(parent);
  const foldedChild = fold(child);
  return foldedParent === foldedChild || foldedChild.startsWith(`${foldedParent}/`);
}

function fold(value: string): string {
  return value.toLowerCase();
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.values(Object.getOwnPropertyDescriptors(value));
  if ((prototype !== Object.prototype && prototype !== null) ||
      descriptors.some((descriptor) => !("value" in descriptor))) {
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
    if (!descriptor || !("value" in descriptor)) {
      throw new Error(`${label} must be a dense data-property array`);
    }
  }
  const unexpected = Reflect.ownKeys(descriptors).filter((key) =>
    typeof key !== "string" ||
    (key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)));
  if (unexpected.length > 0) throw new Error(`${label} contains unsupported properties`);
  return value;
}

function isCanonicalArtifactPath(value: string, prefix: string): boolean {
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_ARTIFACT_PATH_BYTES ||
      value !== value.normalize("NFC") || !value.startsWith(prefix) || value.startsWith("/") ||
      value.startsWith("\\") || /^[A-Za-z]:/.test(value) || value.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(value)) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extras = Reflect.ownKeys(value).filter((key) => typeof key !== "string" || !allowed.includes(key));
  if (extras.length > 0) throw new Error(`${label} contains unsupported fields`);
}
