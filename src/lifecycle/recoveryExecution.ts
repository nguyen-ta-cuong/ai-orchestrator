import { createHash } from "node:crypto";
import type { CompiledBuildPlan } from "../core/buildPlan.js";
import type { CompiledGraph } from "../core/graph.js";
import type {
  LifecycleRecoveryActionExecution,
  LifecycleRecoveryArtifactBinding,
  LifecycleRecoveryEnvelope,
} from "../core/lifecycle.js";
import {
  applyRecoveryDecisionToLedger,
  applyRecoverySuccessorEventToLedger,
  createRecoveryLedger,
  fingerprintFailure,
  registerRecovery,
  resumeRecoveryState,
  validateRecoveryDirective,
  validateRecoveryLedger,
  type FailureCategory,
  type RecoveryDecision,
  type RecoveryDirective,
  type RecoveryState,
} from "../core/recovery.js";
import {
  applySchedulerEvent,
  type GraphCheckpointRef,
  type GraphExecutionState,
} from "../core/scheduler.js";
import {
  assertSchedulerRecoveryAnchor,
  createSchedulerRecoveryBinding,
  schedulerFailureEvidence,
  validateSchedulerRecoveryBinding,
} from "../core/schedulerRecovery.js";
import {
  readGraphEvents,
  readGraphMutationArtifact,
  readImmutableGraphCheckpoint,
  writeGraphMutationArtifact,
  type GraphCheckpointLease,
} from "../runtime/graphCheckpoint.js";
import {
  authenticateRecoveryArtifacts,
  recoveryArtifactBinding,
  validateRecoveryArtifactBinding,
} from "../runtime/recoveryArtifacts.js";
import type { RunPaths } from "./artifacts.js";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ACTION_BYTES = 4 * 1024 * 1024;

export interface LifecycleRecoveryDiagnosisInput {
  rootCauseCategory: FailureCategory;
  confidence: RecoveryDirective["confidence"];
  repairScope: readonly string[];
  validationRequirements: readonly string[];
  topologyAssessment: RecoveryDirective["topologyAssessment"];
  diagnosisBytes: Uint8Array;
}

export function createLifecycleRecoveryEnvelope(input: Readonly<{
  paths: RunPaths;
  owner: Readonly<GraphCheckpointLease>;
  graph: CompiledGraph;
  schedulerState: Readonly<GraphExecutionState>;
  failurePhase: "verifying" | "reviewing";
  activePlanVersion: number;
  activePlanBytes: Uint8Array;
  attempt: number;
  category?: FailureCategory;
  contractId: string;
  evidenceBytes: Uint8Array;
}>): LifecycleRecoveryEnvelope {
  const planBytes = boundedBytes(input.activePlanBytes, "active recovery plan");
  const evidenceBytes = boundedBytes(input.evidenceBytes, "recovery failure evidence");
  const binding = createSchedulerRecoveryBinding(input.graph, input.schedulerState, {
    nodeId: input.failurePhase,
    activePlanVersion: input.activePlanVersion,
    activePlanHash: sha256(planBytes),
  });
  let artifacts: readonly Readonly<LifecycleRecoveryArtifactBinding>[] = [];
  ({ artifacts } = appendArtifact(
    input.paths,
    input.owner,
    artifacts,
    `plan-versions/${input.activePlanVersion}/graph.json`,
    Buffer.from(stableJson(input.graph.definition), "utf8"),
  ));
  ({ artifacts } = appendArtifact(
    input.paths,
    input.owner,
    artifacts,
    `plan-versions/${input.activePlanVersion}/plan.md`,
    planBytes,
  ));
  const evidenceHash = sha256(evidenceBytes);
  ({ artifacts } = appendArtifact(
    input.paths,
    input.owner,
    artifacts,
    `plan-versions/${input.activePlanVersion}/evidence/${evidenceHash}.bin`,
    evidenceBytes,
  ));
  const failure = schedulerFailureEvidence(input.graph, binding, input.attempt, {
    category: input.category ?? "unknown",
    contractViolation: "validator-rejected",
    contractId: input.contractId,
    artifactHashes: [evidenceHash],
  });
  let ledger = registerRecovery(
    createRecoveryLedger(binding.authority),
    binding.authority,
    failure,
  );
  ledger = applyRecoveryDecisionToLedger(
    ledger,
    binding.authority,
    fingerprintFailure(failure),
    undefined,
  );
  return validateLifecycleRecoveryEnvelope({
    version: 1,
    failurePhase: input.failurePhase,
    binding,
    occurrenceBindings: [binding],
    ledger,
    artifacts,
    actionHistory: [],
  });
}

export function registerLifecycleRecoveryOccurrence(input: Readonly<{
  paths: RunPaths;
  owner: Readonly<GraphCheckpointLease>;
  graph: CompiledGraph;
  schedulerState: Readonly<GraphExecutionState>;
  envelope: LifecycleRecoveryEnvelope;
  failurePhase: "verifying" | "reviewing";
  activePlanVersion: number;
  activePlanBytes: Uint8Array;
  attempt: number;
  category?: FailureCategory;
  contractId: string;
  evidenceBytes: Uint8Array;
}>): LifecycleRecoveryEnvelope {
  const envelope = validateLifecycleRecoveryEnvelope(input.envelope);
  const previous = currentLifecycleRecoveryState(envelope);
  if (previous.status !== "released") {
    throw new Error(`A new lifecycle recovery occurrence cannot replace ${previous.status} authority`);
  }
  if (envelope.action && envelope.action.status !== "completed") {
    throw new Error("A new lifecycle recovery occurrence requires the prior action result");
  }
  const planBytes = boundedBytes(input.activePlanBytes, "active recovery plan");
  const planHash = sha256(planBytes);
  const planBinding = envelope.artifacts.find((candidate) =>
    candidate.semanticRef === `plan-versions/${input.activePlanVersion}/plan.md`);
  if (!planBinding || planBinding.sha256 !== planHash) {
    throw new Error("Lifecycle recovery occurrence does not match the current immutable approved plan");
  }
  const binding = createSchedulerRecoveryBinding(input.graph, input.schedulerState, {
    nodeId: input.failurePhase,
    activePlanVersion: input.activePlanVersion,
    activePlanHash: planHash,
    ledgerAuthority: envelope.binding.authority,
  });
  const evidenceBytes = boundedBytes(input.evidenceBytes, "recovery failure evidence");
  const evidenceHash = sha256(evidenceBytes);
  const evidence = appendArtifact(
    input.paths,
    input.owner,
    envelope.artifacts,
    `plan-versions/${input.activePlanVersion}/evidence/${evidenceHash}.bin`,
    evidenceBytes,
  );
  const failure = schedulerFailureEvidence(input.graph, binding, input.attempt, {
    category: input.category ?? "unknown",
    contractViolation: "validator-rejected",
    contractId: input.contractId,
    artifactHashes: [evidenceHash],
  });
  let ledger = registerRecovery(
    envelope.ledger,
    envelope.binding.authority,
    failure,
  );
  ledger = applyRecoveryDecisionToLedger(
    ledger,
    envelope.binding.authority,
    fingerprintFailure(failure),
    undefined,
  );
  const { action: previousAction, ...withoutAction } = envelope;
  return validateLifecycleRecoveryEnvelope({
    ...withoutAction,
    failurePhase: input.failurePhase,
    occurrenceBindings: [...envelope.occurrenceBindings, binding],
    ledger,
    artifacts: evidence.artifacts,
    actionHistory: previousAction
      ? [...envelope.actionHistory, previousAction]
      : envelope.actionHistory,
  });
}

export function recordLifecycleRecoveryDiagnosis(
  paths: RunPaths,
  owner: Readonly<GraphCheckpointLease>,
  envelopeValue: LifecycleRecoveryEnvelope,
  input: Readonly<LifecycleRecoveryDiagnosisInput>,
): LifecycleRecoveryEnvelope {
  const envelope = validateLifecycleRecoveryEnvelope(envelopeValue);
  const state = currentLifecycleRecoveryState(envelope);
  if (state.status !== "waiting-diagnosis") {
    throw new Error(`Lifecycle recovery diagnosis cannot be recorded from ${state.status}`);
  }
  const registration = [...envelope.ledger.records].reverse().find((record) =>
    record.kind === "registration" && record.state.fingerprint === state.fingerprint);
  if (!registration || registration.kind !== "registration") {
    throw new Error("Lifecycle recovery diagnosis has no matching failure evidence");
  }
  let artifacts = envelope.artifacts;
  const evidenceRefs: string[] = [];
  for (const [index, artifactHash] of registration.failure.artifactHashes.entries()) {
    const source = artifacts.find((binding) =>
      binding.semanticRef === `plan-versions/${state.sourcePlanVersion}/evidence/${artifactHash}.bin`);
    if (!source) throw new Error(`Lifecycle recovery evidence ${artifactHash} is unavailable`);
    const semanticRef = index === 0
      ? `nodes/${state.sourcePlanVersion}/${envelope.failurePhase}/${state.fingerprint}/rejection.json`
      : `nodes/${state.sourcePlanVersion}/${envelope.failurePhase}/${state.fingerprint}/evidence-${index + 1}.bin`;
    const existing = artifacts.find((binding) => binding.semanticRef === semanticRef);
    if (existing && (existing.sha256 !== source.sha256 ||
        existing.sizeBytes !== source.sizeBytes ||
        existing.storageRef.path !== source.storageRef.path)) {
      throw new Error(`Lifecycle recovery evidence alias changed immutable bytes: ${semanticRef}`);
    }
    if (!existing) {
      artifacts = Object.freeze([
        ...artifacts,
        recoveryArtifactBinding(semanticRef, source.storageRef),
      ]);
    }
    evidenceRefs.push(semanticRef);
  }
  const diagnosisRef = `plan-versions/${state.sourcePlanVersion}/diagnosis/${state.fingerprint}.md`;
  const diagnosis = appendArtifact(
    paths,
    owner,
    artifacts,
    diagnosisRef,
    boundedBytes(input.diagnosisBytes, "lifecycle recovery diagnosis"),
  );
  const directive = validateRecoveryDirective({
    version: 1,
    failureFingerprint: state.fingerprint,
    rootCauseCategory: input.rootCauseCategory,
    confidence: input.confidence,
    diagnosisRef,
    diagnosisHash: diagnosis.binding.sha256,
    evidenceRefs,
    repairScope: [...input.repairScope],
    validationRequirements: [...input.validationRequirements],
    topologyAssessment: input.topologyAssessment,
  });
  const ledger = applyRecoveryDecisionToLedger(
    envelope.ledger,
    envelope.binding.authority,
    state.fingerprint,
    directive,
  );
  const decisionRecord = ledger.records.at(-1);
  if (!decisionRecord || decisionRecord.kind !== "decision") {
    throw new Error("Lifecycle recovery diagnosis did not append its decision");
  }
  const decision = decisionRecord.decision;
  const action = decision.action === "retry" || decision.action === "repair"
    ? Object.freeze({
        version: 1 as const,
        failureFingerprint: state.fingerprint,
        failurePhase: envelope.failurePhase,
        action: decision.action,
        status: "pending" as const,
      })
    : undefined;
  return validateLifecycleRecoveryEnvelope({
    ...envelope,
    ledger,
    artifacts: diagnosis.artifacts,
    ...(action === undefined ? {} : { action }),
  });
}

export function recordLifecycleRecoverySuccessorArtifacts(
  paths: RunPaths,
  owner: Readonly<GraphCheckpointLease>,
  envelopeValue: LifecycleRecoveryEnvelope,
  compiled: Readonly<CompiledBuildPlan>,
  markdownBytesValue: Uint8Array,
): LifecycleRecoveryEnvelope {
  const envelope = validateLifecycleRecoveryEnvelope(envelopeValue);
  const state = currentLifecycleRecoveryState(envelope);
  if (state.status !== "waiting-successor-artifact" || !state.successor) {
    throw new Error("Lifecycle recovery is not waiting for immutable successor artifacts");
  }
  if (compiled.plan.planVersion !== state.successor.targetPlanVersion) {
    throw new Error("Lifecycle recovery successor BUILD plan version is not the exact target");
  }
  const graphRef = `plan-versions/${state.successor.targetPlanVersion}/graph.json`;
  const planRef = `plan-versions/${state.successor.targetPlanVersion}/plan.md`;
  const graph = appendArtifact(
    paths,
    owner,
    envelope.artifacts,
    graphRef,
    Buffer.from(`${compiled.canonicalJson}\n`, "utf8"),
  );
  const plan = appendArtifact(
    paths,
    owner,
    graph.artifacts,
    planRef,
    boundedBytes(markdownBytesValue, "lifecycle recovery successor plan"),
  );
  const ledger = applyRecoverySuccessorEventToLedger(
    envelope.ledger,
    envelope.binding.authority,
    {
      version: 1,
      phase: "artifact-durable",
      failureFingerprint: state.fingerprint,
      sourcePlanVersion: state.sourcePlanVersion,
      targetPlanVersion: state.successor.targetPlanVersion,
      graphHash: graph.binding.sha256,
      planHash: plan.binding.sha256,
      graphRef,
      planRef,
    },
  );
  return validateLifecycleRecoveryEnvelope({
    ...envelope,
    ledger,
    artifacts: plan.artifacts,
  });
}

export function approveAndActivateLifecycleRecoverySuccessor(
  paths: RunPaths,
  owner: Readonly<GraphCheckpointLease>,
  envelopeValue: LifecycleRecoveryEnvelope,
  approvalBytesValue: Uint8Array,
): LifecycleRecoveryEnvelope {
  const envelope = validateLifecycleRecoveryEnvelope(envelopeValue);
  const state = currentLifecycleRecoveryState(envelope);
  if (state.status !== "waiting-successor-approval" || !state.successor?.graphHash ||
      !state.successor.planHash || !state.successor.graphRef || !state.successor.planRef) {
    throw new Error("Lifecycle recovery successor is not ready for approval");
  }
  const approvalRef = `plan-versions/${state.successor.targetPlanVersion}/approval.json`;
  const approval = appendArtifact(
    paths,
    owner,
    envelope.artifacts,
    approvalRef,
    boundedBytes(approvalBytesValue, "lifecycle recovery successor approval"),
  );
  const common = {
    version: 1 as const,
    failureFingerprint: state.fingerprint,
    sourcePlanVersion: state.sourcePlanVersion,
    targetPlanVersion: state.successor.targetPlanVersion,
    graphHash: state.successor.graphHash,
    planHash: state.successor.planHash,
    graphRef: state.successor.graphRef,
    planRef: state.successor.planRef,
    approvalHash: approval.binding.sha256,
    approvalRef,
  };
  let ledger = applyRecoverySuccessorEventToLedger(
    envelope.ledger,
    envelope.binding.authority,
    { ...common, phase: "approved" },
  );
  ledger = applyRecoverySuccessorEventToLedger(
    ledger,
    envelope.binding.authority,
    { ...common, phase: "activated" },
  );
  return validateLifecycleRecoveryEnvelope({
    ...envelope,
    ledger,
    artifacts: approval.artifacts,
  });
}

export function startLifecycleRecoveryAction(
  envelopeValue: LifecycleRecoveryEnvelope,
  requestRef: string,
  intentRef: Readonly<GraphCheckpointRef>,
): LifecycleRecoveryEnvelope {
  const envelope = validateLifecycleRecoveryEnvelope(envelopeValue);
  const action = envelope.action;
  if (!action || action.status !== "pending") {
    throw new Error("Lifecycle recovery has no pending retry or repair action");
  }
  assertHash(requestRef, "lifecycle recovery action requestRef");
  validateCheckpointRef(intentRef, "lifecycle recovery action intentRef");
  if (action.requestRef !== undefined || action.intentRef !== undefined || action.resultRef !== undefined) {
    if (action.requestRef === requestRef && sameCheckpointRef(action.intentRef, intentRef)) return envelope;
    throw new Error("Lifecycle recovery action already has a conflicting durable intent");
  }
  return validateLifecycleRecoveryEnvelope({
    ...envelope,
    action: { ...action, requestRef, intentRef },
  });
}

export function completeLifecycleRecoveryAction(
  envelopeValue: LifecycleRecoveryEnvelope,
  requestRef: string,
  resultRef: Readonly<GraphCheckpointRef>,
): LifecycleRecoveryEnvelope {
  const envelope = validateLifecycleRecoveryEnvelope(envelopeValue);
  const action = envelope.action;
  if (!action || action.status !== "pending" || action.requestRef !== requestRef || !action.intentRef) {
    throw new Error("Lifecycle recovery action completion lacks its exact durable intent");
  }
  validateCheckpointRef(resultRef, "lifecycle recovery action resultRef");
  return validateLifecycleRecoveryEnvelope({
    ...envelope,
    action: { ...action, status: "completed", resultRef },
  });
}

export function validateLifecycleRecoveryEnvelope(value: unknown): LifecycleRecoveryEnvelope {
  const record = requireRecord(value, "lifecycle recovery envelope");
  assertExactKeys(
    record,
    ["version", "failurePhase", "binding", "occurrenceBindings", "ledger", "artifacts", "actionHistory", "action"],
    "lifecycle recovery envelope",
  );
  if (record.version !== 1) throw new Error("Lifecycle recovery envelope version must be 1");
  if (record.failurePhase !== "verifying" && record.failurePhase !== "reviewing") {
    throw new Error("Lifecycle recovery failure phase is invalid");
  }
  const binding = validateSchedulerRecoveryBinding(record.binding);
  const ledger = validateRecoveryLedger(record.ledger, binding.authority);
  if (!Array.isArray(record.occurrenceBindings) ||
      Object.keys(record.occurrenceBindings).length !== record.occurrenceBindings.length ||
      record.occurrenceBindings.length < 1 ||
      record.occurrenceBindings.length > binding.authority.limits.maxEntries) {
    throw new Error("Lifecycle recovery occurrence bindings must be a bounded non-empty dense array");
  }
  const occurrenceBindings = record.occurrenceBindings.map(validateSchedulerRecoveryBinding);
  if (stableJson(occurrenceBindings[0]) !== stableJson(binding) ||
      occurrenceBindings.some((candidate) =>
        stableJson(candidate.authority) !== stableJson(binding.authority))) {
    throw new Error("Lifecycle recovery occurrences must retain their genesis ledger authority");
  }
  for (let index = 1; index < occurrenceBindings.length; index += 1) {
    if (occurrenceBindings[index]!.anchor.schedulerRevision <=
        occurrenceBindings[index - 1]!.anchor.schedulerRevision) {
      throw new Error("Lifecycle recovery occurrence anchors must advance monotonically");
    }
  }
  const registrations = ledger.records.filter((candidate) => candidate.kind === "registration");
  if (registrations.length !== occurrenceBindings.length) {
    throw new Error("Lifecycle recovery occurrences do not match ledger registrations");
  }
  if (!Array.isArray(record.artifacts) || Object.keys(record.artifacts).length !== record.artifacts.length ||
      record.artifacts.length > 4_096) {
    throw new Error("Lifecycle recovery artifacts must be a bounded dense array");
  }
  const artifacts = record.artifacts.map(validateRecoveryArtifactBinding);
  if (new Set(artifacts.map(({ semanticRef }) => semanticRef)).size !== artifacts.length) {
    throw new Error("Lifecycle recovery artifact references must be unique");
  }
  if (!Array.isArray(record.actionHistory) ||
      Object.keys(record.actionHistory).length !== record.actionHistory.length ||
      record.actionHistory.length > occurrenceBindings.length) {
    throw new Error("Lifecycle recovery action history must be a bounded dense array");
  }
  const actionHistory = record.actionHistory.map((candidate) => {
    const actionRecord = requireRecord(candidate, "lifecycle recovery historical action");
    const phase = actionRecord.failurePhase;
    if (phase !== "verifying" && phase !== "reviewing") {
      throw new Error("Lifecycle recovery historical action phase is invalid");
    }
    const action = validateAction(candidate, phase);
    if (action.status !== "completed") {
      throw new Error("Lifecycle recovery action history accepts only completed actions");
    }
    return action;
  });
  if (new Set(actionHistory.map(({ failureFingerprint }) => failureFingerprint)).size !== actionHistory.length) {
    throw new Error("Lifecycle recovery action history contains duplicate failures");
  }
  const action = record.action === undefined ? undefined : validateAction(record.action, record.failurePhase);
  const envelope = Object.freeze({
    version: 1 as const,
    failurePhase: record.failurePhase,
    binding,
    occurrenceBindings: Object.freeze(occurrenceBindings),
    ledger,
    artifacts: Object.freeze(artifacts),
    actionHistory: Object.freeze(actionHistory),
    ...(action === undefined ? {} : { action }),
  });
  assertActionMatchesLedger(envelope);
  return envelope;
}

export function authenticateLifecycleRecoveryEnvelope(
  paths: RunPaths,
  graph: CompiledGraph,
  schedulerState: Readonly<GraphExecutionState>,
  envelopeValue: LifecycleRecoveryEnvelope,
): LifecycleRecoveryEnvelope {
  const envelope = validateLifecycleRecoveryEnvelope(envelopeValue);
  if (envelope.binding.authority.runId !== schedulerState.runId ||
      envelope.binding.authority.graphDigest !== schedulerState.graphDigest) {
    throw new Error("Lifecycle recovery authority crossed its run or graph boundary");
  }
  const checkpoint = readImmutableGraphCheckpoint(paths);
  const events = readGraphEvents(paths);
  const registrations = envelope.ledger.records.filter((candidate) => candidate.kind === "registration");
  for (const [occurrenceIndex, binding] of envelope.occurrenceBindings.entries()) {
    const revision = binding.anchor.schedulerRevision;
    if (revision > events.length) throw new Error("Lifecycle recovery anchor points beyond durable graph events");
    let anchorState = structuredClone(checkpoint.genesisState);
    for (let eventIndex = 0; eventIndex < revision; eventIndex += 1) {
      anchorState = applySchedulerEvent(graph, anchorState, events[eventIndex]!);
    }
    assertSchedulerRecoveryAnchor(graph, anchorState, binding);
    const registration = registrations[occurrenceIndex];
    if (!registration || registration.kind !== "registration") {
      throw new Error("Lifecycle recovery occurrence is missing its ledger registration");
    }
    const expectedFailure = schedulerFailureEvidence(
      graph,
      binding,
      registration.failure.attempt,
      {
        category: registration.failure.category,
        ...(registration.failure.contractViolation === undefined
          ? {}
          : { contractViolation: registration.failure.contractViolation }),
        ...(registration.failure.contractId === undefined
          ? {}
          : { contractId: registration.failure.contractId }),
        artifactHashes: registration.failure.artifactHashes,
      },
    );
    if (stableJson(expectedFailure) !== stableJson(registration.failure)) {
      throw new Error("Lifecycle recovery occurrence does not match its scheduler-issued failure evidence");
    }
  }
  authenticateRecoveryArtifacts({
    authority: envelope.binding.authority,
    ledger: envelope.ledger,
    bindings: envelope.artifacts,
    readArtifact: (reference) => readGraphMutationArtifact(paths, reference),
  });
  for (const action of envelope.actionHistory) {
    if (action.intentRef) readBoundedActionArtifact(paths, action.intentRef);
    if (action.resultRef) readBoundedActionArtifact(paths, action.resultRef);
  }
  if (envelope.action?.intentRef) readBoundedActionArtifact(paths, envelope.action.intentRef);
  if (envelope.action?.resultRef) readBoundedActionArtifact(paths, envelope.action.resultRef);
  return envelope;
}

export function assertLifecycleRecoveryMonotonic(
  previousValue: LifecycleRecoveryEnvelope | undefined,
  nextValue: LifecycleRecoveryEnvelope | undefined,
): void {
  if (previousValue === undefined) return;
  if (nextValue === undefined) throw new Error("Lifecycle recovery authority cannot be removed");
  const previous = validateLifecycleRecoveryEnvelope(previousValue);
  const next = validateLifecycleRecoveryEnvelope(nextValue);
  if (stableJson(previous.binding) !== stableJson(next.binding)) {
    throw new Error("Lifecycle recovery changed its frozen scheduler binding");
  }
  assertPrefix(previous.occurrenceBindings, next.occurrenceBindings, "Lifecycle recovery occurrence bindings");
  assertPrefix(previous.ledger.records, next.ledger.records, "Lifecycle recovery ledger");
  assertPrefix(previous.artifacts, next.artifacts, "Lifecycle recovery artifacts");
  assertPrefix(previous.actionHistory, next.actionHistory, "Lifecycle recovery action history");
  if (previous.action) {
    if (next.action?.failureFingerprint === previous.action.failureFingerprint) {
      if (previous.action.action !== next.action.action ||
          previous.action.failurePhase !== next.action.failurePhase) {
        throw new Error("Lifecycle recovery action authority changed");
      }
      if (previous.action.status === "completed" && stableJson(previous.action) !== stableJson(next.action)) {
        throw new Error("Completed lifecycle recovery action is immutable");
      }
      if (previous.action.requestRef && previous.action.requestRef !== next.action.requestRef) {
        throw new Error("Lifecycle recovery action request identity changed");
      }
      if (previous.action.intentRef && !sameCheckpointRef(previous.action.intentRef, next.action.intentRef)) {
        throw new Error("Lifecycle recovery action intent changed");
      }
    } else {
      if (previous.action.status !== "completed" ||
          stableJson(next.actionHistory[previous.actionHistory.length]) !== stableJson(previous.action)) {
        throw new Error("Lifecycle recovery replaced an action without archiving its completed receipt");
      }
    }
  }
}

export function currentLifecycleRecoveryState(envelopeValue: LifecycleRecoveryEnvelope): RecoveryState {
  const envelope = validateLifecycleRecoveryEnvelope(envelopeValue);
  const registration = [...envelope.ledger.records].reverse().find((record) => record.kind === "registration");
  if (!registration || registration.kind !== "registration") {
    throw new Error("Lifecycle recovery ledger has no registered failure");
  }
  return resumeRecoveryState(
    envelope.ledger,
    envelope.binding.authority,
    registration.state.fingerprint,
  );
}

export function latestLifecycleRecoveryDecision(
  envelopeValue: LifecycleRecoveryEnvelope,
): RecoveryDecision {
  const envelope = validateLifecycleRecoveryEnvelope(envelopeValue);
  const state = currentLifecycleRecoveryState(envelope);
  const record = [...envelope.ledger.records].reverse().find((candidate) =>
    candidate.kind === "decision" && candidate.fingerprint === state.fingerprint);
  if (!record || record.kind !== "decision") throw new Error("Lifecycle recovery decision is missing");
  return record.decision;
}

export function latestLifecycleRecoveryDirective(
  envelopeValue: LifecycleRecoveryEnvelope,
): RecoveryDirective | undefined {
  const envelope = validateLifecycleRecoveryEnvelope(envelopeValue);
  const state = currentLifecycleRecoveryState(envelope);
  const record = [...envelope.ledger.records].reverse().find((candidate) =>
    candidate.kind === "decision" && candidate.fingerprint === state.fingerprint);
  return record?.kind === "decision" ? record.directive : undefined;
}

function appendArtifact(
  paths: RunPaths,
  owner: Readonly<GraphCheckpointLease>,
  artifacts: readonly Readonly<LifecycleRecoveryArtifactBinding>[],
  semanticRef: string,
  bytesValue: Uint8Array,
): Readonly<{
  artifacts: readonly Readonly<LifecycleRecoveryArtifactBinding>[];
  binding: Readonly<LifecycleRecoveryArtifactBinding>;
}> {
  const bytes = boundedBytes(bytesValue, `recovery artifact ${semanticRef}`);
  const digest = sha256(bytes);
  const existing = artifacts.find((candidate) => candidate.semanticRef === semanticRef);
  if (existing) {
    if (existing.sha256 !== digest || existing.sizeBytes !== bytes.byteLength) {
      throw new Error(`Lifecycle recovery artifact changed immutable bytes: ${semanticRef}`);
    }
    if (!readGraphMutationArtifact(paths, existing.storageRef).equals(bytes)) {
      throw new Error(`Lifecycle recovery artifact storage changed: ${semanticRef}`);
    }
    return Object.freeze({ artifacts, binding: existing });
  }
  const storageRef = writeGraphMutationArtifact(paths, {
    owner,
    mutationId: digest,
    bytes,
  });
  const binding = recoveryArtifactBinding(semanticRef, storageRef);
  return Object.freeze({
    artifacts: Object.freeze([...artifacts, binding]),
    binding,
  });
}

function validateAction(
  value: unknown,
  failurePhase: "verifying" | "reviewing",
): LifecycleRecoveryActionExecution {
  const record = requireRecord(value, "lifecycle recovery action");
  assertExactKeys(
    record,
    ["version", "failureFingerprint", "failurePhase", "action", "status", "requestRef", "intentRef", "resultRef"],
    "lifecycle recovery action",
  );
  if (record.version !== 1 || record.failurePhase !== failurePhase ||
      (record.action !== "retry" && record.action !== "repair") ||
      (record.status !== "pending" && record.status !== "completed")) {
    throw new Error("Lifecycle recovery action identity is invalid");
  }
  const failureFingerprint = requireHash(record.failureFingerprint, "lifecycle recovery action fingerprint");
  const requestRef = record.requestRef === undefined
    ? undefined
    : requireHash(record.requestRef, "lifecycle recovery action requestRef");
  const intentRef = record.intentRef === undefined
    ? undefined
    : validateCheckpointRef(record.intentRef, "lifecycle recovery action intentRef");
  const resultRef = record.resultRef === undefined
    ? undefined
    : validateCheckpointRef(record.resultRef, "lifecycle recovery action resultRef");
  if ((requestRef === undefined) !== (intentRef === undefined)) {
    throw new Error("Lifecycle recovery action request and intent must be recorded together");
  }
  if (record.status === "completed" && (requestRef === undefined || intentRef === undefined || resultRef === undefined)) {
    throw new Error("Completed lifecycle recovery action requires intent and result evidence");
  }
  if (record.status === "pending" && resultRef !== undefined) {
    throw new Error("Pending lifecycle recovery action cannot contain result evidence");
  }
  return Object.freeze({
    version: 1,
    failureFingerprint,
    failurePhase,
    action: record.action,
    status: record.status,
    ...(requestRef === undefined ? {} : { requestRef }),
    ...(intentRef === undefined ? {} : { intentRef }),
    ...(resultRef === undefined ? {} : { resultRef }),
  });
}

function assertActionMatchesLedger(envelope: LifecycleRecoveryEnvelope): void {
  const state = currentStateUnchecked(envelope);
  const decisionRecord = [...envelope.ledger.records].reverse().find((candidate) =>
    candidate.kind === "decision" && candidate.fingerprint === state.fingerprint);
  const decision = decisionRecord?.kind === "decision" ? decisionRecord.decision : undefined;
  if (decision?.action === "retry" || decision?.action === "repair") {
    if (!envelope.action || envelope.action.failureFingerprint !== state.fingerprint ||
        envelope.action.action !== decision.action || envelope.action.failurePhase !== envelope.failurePhase) {
      throw new Error("Lifecycle recovery retry/repair decision lacks matching action authority");
    }
  } else if (envelope.action !== undefined) {
    throw new Error("Lifecycle recovery action is valid only for retry or repair");
  }
  for (const action of envelope.actionHistory) {
    const historicalDecision = [...envelope.ledger.records].reverse().find((candidate) =>
      candidate.kind === "decision" && candidate.fingerprint === action.failureFingerprint);
    if (!historicalDecision || historicalDecision.kind !== "decision" ||
        historicalDecision.decision.action !== action.action) {
      throw new Error("Lifecycle recovery historical action lacks its matching ledger decision");
    }
  }
}

function currentStateUnchecked(envelope: LifecycleRecoveryEnvelope): RecoveryState {
  const registration = [...envelope.ledger.records].reverse().find((record) => record.kind === "registration");
  if (!registration || registration.kind !== "registration") {
    throw new Error("Lifecycle recovery ledger has no registered failure");
  }
  for (let index = envelope.ledger.records.length - 1; index >= 0; index -= 1) {
    const record = envelope.ledger.records[index]!;
    const fingerprint = record.kind === "registration" ? record.state.fingerprint : record.fingerprint;
    if (fingerprint === registration.state.fingerprint) return record.state;
  }
  throw new Error("Lifecycle recovery state is missing");
}

function readBoundedActionArtifact(paths: RunPaths, reference: Readonly<GraphCheckpointRef>): Buffer {
  const bytes = readGraphMutationArtifact(paths, reference);
  if (bytes.byteLength > MAX_ACTION_BYTES) throw new Error("Lifecycle recovery action artifact exceeds its byte limit");
  return bytes;
}

function validateCheckpointRef(value: unknown, label: string): Readonly<GraphCheckpointRef> {
  const record = requireRecord(value, label);
  assertExactKeys(record, ["path", "sha256", "sizeBytes"], label);
  if (typeof record.path !== "string" || !/^mutations\/[a-f0-9]{64}\.json$/.test(record.path)) {
    throw new Error(`${label}.path is invalid`);
  }
  const sha256Value = requireHash(record.sha256, `${label}.sha256`);
  if (record.path !== `mutations/${sha256Value}.json`) throw new Error(`${label}.path does not match its hash`);
  if (!Number.isSafeInteger(record.sizeBytes) || (record.sizeBytes as number) < 0 ||
      (record.sizeBytes as number) > MAX_ACTION_BYTES) {
    throw new Error(`${label}.sizeBytes is invalid`);
  }
  return Object.freeze({ path: record.path, sha256: sha256Value, sizeBytes: record.sizeBytes as number });
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error(`${label} must be a plain object`);
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable) continue;
    if (!("value" in descriptor)) throw new Error(`${label}.${key} must be an own data property`);
    result[key] = descriptor.value;
  }
  return result;
}

function assertExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort();
  const expected = allowed.filter((key) => record[key] !== undefined).sort();
  const required = allowed.filter((key) => !["action", "requestRef", "intentRef", "resultRef"].includes(key));
  if (required.some((key) => !(key in record)) ||
      actual.some((key) => !allowed.includes(key)) ||
      stableJson(actual) !== stableJson(expected)) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}

function assertPrefix(previous: readonly unknown[], next: readonly unknown[], label: string): void {
  if (next.length < previous.length ||
      stableJson(next.slice(0, previous.length)) !== stableJson(previous)) {
    throw new Error(`${label} is not append-only`);
  }
}

function sameCheckpointRef(
  left: Readonly<GraphCheckpointRef> | undefined,
  right: Readonly<GraphCheckpointRef> | undefined,
): boolean {
  return left === undefined && right === undefined ||
    left !== undefined && right !== undefined &&
    left.path === right.path && left.sha256 === right.sha256 && left.sizeBytes === right.sizeBytes;
}

function boundedBytes(value: Uint8Array, label: string): Buffer {
  const bytes = Buffer.from(value);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ACTION_BYTES) {
    throw new Error(`${label} is empty or exceeds its byte limit`);
  }
  return bytes;
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
  return value;
}

function assertHash(value: unknown, label: string): asserts value is string {
  requireHash(value, label);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  const encoded = JSON.stringify(canonicalValue(value));
  if (encoded === undefined) throw new Error("Cannot canonicalize lifecycle recovery data");
  return encoded;
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
