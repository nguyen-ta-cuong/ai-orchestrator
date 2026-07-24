import { createHash } from "node:crypto";
import type { CompiledGraph } from "./graph.js";
import {
  validateRecoveryAuthority,
  validateFailureEvidence,
  type FailureCategory,
  type FailureEvidence,
  type RecoveryAuthority,
  type RecoveryBudgets,
} from "./recovery.js";
import {
  assertScheduleValid,
  executionLimitsFingerprint,
  type GraphExecutionState,
} from "./scheduler.js";

export interface SchedulerRecoveryAnchor {
  version: 1;
  runId: string;
  graphDigest: string;
  graphVersion: string;
  schedulerRevision: number;
  eventSequence: number;
  eventId: string;
  eventHash: string;
  eventChainHash: string;
  limitsFingerprint: string;
  nodeId: string;
  nodeVisit: number;
  nodeAttempt: number;
  activePlanVersion: number;
  activePlanHash: string;
  failureLineageId: string;
}

export interface SchedulerRecoveryBinding {
  version: 1;
  anchor: Readonly<SchedulerRecoveryAnchor>;
  authority: Readonly<RecoveryAuthority>;
}

export interface SchedulerFailureObservation {
  category: FailureCategory;
  contractViolation?: FailureEvidence["contractViolation"];
  contractId?: string;
  artifactHashes?: readonly string[];
}

const SHA256 = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const MAX_RECOVERY_ENTRIES = 1_024;
const FROZEN_RECOVERY_BUDGETS: Readonly<RecoveryBudgets> = Object.freeze({
  retry: 1,
  repair: 1,
  replan: 1,
});

export function createSchedulerRecoveryBinding(
  graph: CompiledGraph,
  stateValue: Readonly<GraphExecutionState>,
  input: { nodeId: string; activePlanVersion: number; activePlanHash: string },
): SchedulerRecoveryBinding {
  assertScheduleValid(graph, stateValue);
  if (stateValue.lastAppliedEventSequence === 0 || stateValue.lastAppliedEventId === undefined ||
      stateValue.lastAppliedEventHash === undefined) {
    throw new Error("Recovery requires an externally anchored scheduler event");
  }
  if (!Number.isSafeInteger(input.activePlanVersion) || input.activePlanVersion < 1 ||
      input.activePlanVersion > stateValue.effectiveLimits.maxPlanVersions) {
    throw new Error("Recovery active plan version is outside the frozen scheduler cap");
  }
  assertHash(input.activePlanHash, "recovery active plan hash");
  const node = stateValue.nodeStates[input.nodeId];
  if (!node) throw new Error(`Recovery node does not exist: ${input.nodeId}`);
  if (node.visits < 1) throw new Error("Recovery node has never been visited");
  const lineageDigest = sha256(canonicalJson({
    version: "scheduler-recovery-lineage-v1",
    runId: stateValue.runId,
    graphDigest: stateValue.graphDigest,
    nodeId: input.nodeId,
    nodeVisit: node.visits,
    schedulerRevision: stateValue.revision,
    eventChainHash: stateValue.eventChainHash,
  }));
  const anchor: SchedulerRecoveryAnchor = Object.freeze({
    version: 1,
    runId: stateValue.runId,
    graphDigest: stateValue.graphDigest,
    graphVersion: stateValue.graphVersion,
    schedulerRevision: stateValue.revision,
    eventSequence: stateValue.lastAppliedEventSequence,
    eventId: stateValue.lastAppliedEventId,
    eventHash: stateValue.lastAppliedEventHash,
    eventChainHash: stateValue.eventChainHash,
    limitsFingerprint: stateValue.limitsFingerprint,
    nodeId: input.nodeId,
    nodeVisit: node.visits,
    nodeAttempt: node.attempts,
    activePlanVersion: input.activePlanVersion,
    activePlanHash: input.activePlanHash,
    failureLineageId: `lineage-${lineageDigest.slice(0, 48)}`,
  });
  const authority = validateRecoveryAuthority({
    version: 1,
    runId: stateValue.runId,
    graphDigest: stateValue.graphDigest,
    activePlanVersion: input.activePlanVersion,
    activePlanHash: input.activePlanHash,
    limits: {
      maxEntries: Math.min(stateValue.effectiveLimits.maxGraphSteps, MAX_RECOVERY_ENTRIES),
      maxPlanVersions: stateValue.effectiveLimits.maxPlanVersions,
      budgets: FROZEN_RECOVERY_BUDGETS,
    },
  });
  return validateSchedulerRecoveryBinding({ version: 1, anchor, authority });
}

export function validateSchedulerRecoveryBinding(value: unknown): SchedulerRecoveryBinding {
  const record = requireRecord(value, "scheduler recovery binding");
  assertExactKeys(record, ["version", "anchor", "authority"], "scheduler recovery binding");
  if (record.version !== 1) throw new Error("Scheduler recovery binding version must be 1");
  const anchorRecord = requireRecord(record.anchor, "scheduler recovery anchor");
  assertExactKeys(anchorRecord, [
    "version", "runId", "graphDigest", "graphVersion", "schedulerRevision", "eventSequence",
    "eventId", "eventHash", "eventChainHash", "limitsFingerprint", "nodeId", "nodeVisit",
    "nodeAttempt", "activePlanVersion", "activePlanHash", "failureLineageId",
  ], "scheduler recovery anchor");
  if (anchorRecord.version !== 1) throw new Error("Scheduler recovery anchor version must be 1");
  const anchor: SchedulerRecoveryAnchor = Object.freeze({
    version: 1,
    runId: requireToken(anchorRecord.runId, "scheduler recovery runId"),
    graphDigest: requireHash(anchorRecord.graphDigest, "scheduler recovery graphDigest"),
    graphVersion: requireToken(anchorRecord.graphVersion, "scheduler recovery graphVersion"),
    schedulerRevision: requirePositiveInteger(anchorRecord.schedulerRevision, "scheduler recovery revision"),
    eventSequence: requirePositiveInteger(anchorRecord.eventSequence, "scheduler recovery event sequence"),
    eventId: requireToken(anchorRecord.eventId, "scheduler recovery eventId"),
    eventHash: requireHash(anchorRecord.eventHash, "scheduler recovery eventHash"),
    eventChainHash: requireHash(anchorRecord.eventChainHash, "scheduler recovery eventChainHash"),
    limitsFingerprint: requireHash(anchorRecord.limitsFingerprint, "scheduler recovery limitsFingerprint"),
    nodeId: requireToken(anchorRecord.nodeId, "scheduler recovery nodeId"),
    nodeVisit: requirePositiveInteger(anchorRecord.nodeVisit, "scheduler recovery node visit"),
    nodeAttempt: requireNonNegativeInteger(anchorRecord.nodeAttempt, "scheduler recovery node attempt"),
    activePlanVersion: requirePositiveInteger(anchorRecord.activePlanVersion, "scheduler recovery active plan version"),
    activePlanHash: requireHash(anchorRecord.activePlanHash, "scheduler recovery active plan hash"),
    failureLineageId: requireToken(anchorRecord.failureLineageId, "scheduler recovery failure lineage"),
  });
  if (anchor.schedulerRevision !== anchor.eventSequence) {
    throw new Error("Scheduler recovery revision must equal its event sequence");
  }
  const authority = validateRecoveryAuthority(record.authority);
  if (authority.runId !== anchor.runId || authority.graphDigest !== anchor.graphDigest ||
      authority.activePlanVersion !== anchor.activePlanVersion || authority.activePlanHash !== anchor.activePlanHash) {
    throw new Error("Scheduler recovery authority is not bound to its external anchor");
  }
  return Object.freeze({ version: 1, anchor, authority });
}

export function assertSchedulerRecoveryAnchor(
  graph: CompiledGraph,
  stateValue: Readonly<GraphExecutionState>,
  bindingValue: SchedulerRecoveryBinding,
): void {
  assertScheduleValid(graph, stateValue);
  const binding = validateSchedulerRecoveryBinding(bindingValue);
  const { anchor, authority } = binding;
  const node = stateValue.nodeStates[anchor.nodeId];
  if (!node) throw new Error("Scheduler recovery anchor references an unknown node");
  if (stateValue.runId !== anchor.runId || stateValue.graphDigest !== anchor.graphDigest ||
      stateValue.graphVersion !== anchor.graphVersion || stateValue.revision !== anchor.schedulerRevision ||
      stateValue.lastAppliedEventSequence !== anchor.eventSequence || stateValue.lastAppliedEventId !== anchor.eventId ||
      stateValue.lastAppliedEventHash !== anchor.eventHash || stateValue.eventChainHash !== anchor.eventChainHash ||
      stateValue.limitsFingerprint !== anchor.limitsFingerprint || node.visits !== anchor.nodeVisit ||
      node.attempts !== anchor.nodeAttempt) {
    throw new Error("Scheduler recovery anchor does not match the externally replayed scheduler state");
  }
  const expectedLimits = {
    maxEntries: Math.min(stateValue.effectiveLimits.maxGraphSteps, MAX_RECOVERY_ENTRIES),
    maxPlanVersions: stateValue.effectiveLimits.maxPlanVersions,
    budgets: FROZEN_RECOVERY_BUDGETS,
  };
  if (executionLimitsFingerprint(stateValue.effectiveLimits) !== anchor.limitsFingerprint ||
      canonicalJson(authority.limits) !== canonicalJson(expectedLimits)) {
    throw new Error("Scheduler recovery caps do not match the frozen scheduler limits");
  }
  const recreated = createSchedulerRecoveryBinding(graph, stateValue, {
    nodeId: anchor.nodeId,
    activePlanVersion: anchor.activePlanVersion,
    activePlanHash: anchor.activePlanHash,
  });
  if (canonicalJson(recreated) !== canonicalJson(binding)) {
    throw new Error("Scheduler recovery failure lineage is not scheduler-issued");
  }
}

export function schedulerFailureEvidence(
  graph: CompiledGraph,
  bindingValue: SchedulerRecoveryBinding,
  attempt: number,
  observation: SchedulerFailureObservation,
): FailureEvidence {
  const binding = validateSchedulerRecoveryBinding(bindingValue);
  const node = graph.nodesById.get(binding.anchor.nodeId);
  if (!node) throw new Error("Scheduler recovery failure references an unknown node");
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("Scheduler recovery attempt must be positive");
  return validateFailureEvidence({
    version: 1,
    runId: binding.authority.runId,
    nodeId: binding.anchor.nodeId,
    category: observation.category,
    nodeKind: node.handler,
    graphVersion: binding.anchor.graphVersion,
    graphDigest: binding.authority.graphDigest,
    planVersion: binding.authority.activePlanVersion,
    planHash: binding.authority.activePlanHash,
    attempt,
    failureLineageId: binding.anchor.failureLineageId,
    ...(observation.contractViolation === undefined ? {} : { contractViolation: observation.contractViolation }),
    ...(observation.contractId === undefined ? {} : { contractId: observation.contractId }),
    artifactHashes: observation.artifactHashes ?? [],
  });
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable) continue;
    if (!("value" in descriptor)) throw new Error(`${label}.${key} must be an own data property`);
    result[key] = descriptor.value;
  }
  return result;
}

function assertExactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = [...keys].sort();
  const actual = Object.keys(record).sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`${label} has unexpected or missing fields`);
}

function requireToken(value: unknown, label: string): string {
  if (typeof value !== "string" || !TOKEN.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
  return value;
}

function assertHash(value: unknown, label: string): asserts value is string {
  requireHash(value, label);
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive safe integer`);
  return value as number;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value as number;
}

function canonicalJson(value: unknown): string {
  const encoded = JSON.stringify(canonicalValue(value));
  if (encoded === undefined) throw new Error("Cannot canonicalize scheduler recovery data");
  return encoded;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
