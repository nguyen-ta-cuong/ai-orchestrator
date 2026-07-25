import { createHash } from "node:crypto";

export const FAILURE_CATEGORIES = [
  "transient-provider",
  "transient-tool",
  "timeout",
  "output-contract",
  "implementation-defect",
  "configuration",
  "missing-dependency",
  "invalid-topology",
  "wrong-decomposition",
  "budget",
  "authorization",
  "policy",
  "side-effect",
  "unknown",
] as const;

export type FailureCategory = typeof FAILURE_CATEGORIES[number];

export const RECOVERY_LEVELS = ["retry", "repair", "replan"] as const;
export type RecoveryLevel = typeof RECOVERY_LEVELS[number];

export const CONTRACT_VIOLATIONS = [
  "missing-input",
  "missing-output",
  "invalid-output",
  "validator-rejected",
  "artifact-mismatch",
] as const;

export type ContractViolation = typeof CONTRACT_VIOLATIONS[number];
export type RecoveryStatus =
  | "active"
  | "waiting-diagnosis"
  | "waiting-configuration"
  | "waiting-authorization"
  | "waiting-policy"
  | "waiting-side-effect-review"
  | "waiting-successor-artifact"
  | "waiting-successor-approval"
  | "ready-successor-activation"
  | "released"
  | "failed";
export type RecoveryTopology = "preserve" | "successor";
export type RecoveryAction = RecoveryLevel | "pause" | "fail";

export type RecoveryReason =
  | "transient-failure"
  | "local-defect"
  | "structural-defect"
  | "diagnosis-required"
  | "unknown-after-diagnosis"
  | "configuration-change-required"
  | "human-authorization-required"
  | "policy-change-required"
  | "side-effect-review-required"
  | "global-budget-exhausted"
  | "retry-exhausted"
  | "repair-exhausted"
  | "replan-exhausted"
  | "recovery-level-consumed"
  | "recovery-level-skipped";

export interface FailureEvidence {
  version: 1;
  runId: string;
  nodeId: string;
  category: FailureCategory;
  nodeKind: string;
  graphVersion: string;
  graphDigest: string;
  planVersion: number;
  planHash: string;
  attempt: number;
  failureLineageId: string;
  contractViolation?: ContractViolation;
  contractId?: string;
  artifactHashes: readonly string[];
}

export interface RecoveryBudgets {
  retry: number;
  repair: number;
  replan: number;
}

export interface RecoveryState {
  version: 1;
  status: RecoveryStatus;
  genesisHash: string;
  fingerprint: string;
  budgetKey: string;
  observedCategory: FailureCategory;
  consumed: readonly RecoveryLevel[];
  remaining: Readonly<RecoveryBudgets>;
  sourcePlanVersion: number;
  sourcePlanHash: string;
  approvedPlanVersion: number;
  approvedPlanHash: string;
  planVersionCeiling: number;
  successor?: Readonly<RecoverySuccessorState>;
}

export interface RecoverySuccessorState {
  status: "intent-recorded" | "artifact-durable" | "approved" | "activated";
  sourcePlanVersion: number;
  targetPlanVersion: number;
  graphHash?: string;
  planHash?: string;
  graphRef?: string;
  planRef?: string;
  approvalHash?: string;
  approvalRef?: string;
}

export interface RecoveryDirective {
  version: 1;
  failureFingerprint: string;
  rootCauseCategory: FailureCategory;
  confidence: "low" | "medium" | "high";
  diagnosisRef: string;
  diagnosisHash: string;
  evidenceRefs: readonly string[];
  repairScope: readonly string[];
  validationRequirements: readonly string[];
  topologyAssessment: "preserve" | "structural";
}

export interface RecoveryDecision {
  version: 1;
  failureFingerprint: string;
  observedCategory: FailureCategory;
  effectiveCategory: FailureCategory;
  action: RecoveryAction;
  reason: RecoveryReason;
  topology: RecoveryTopology;
  sourcePlanVersion: number;
  sourcePlanHash: string;
  targetPlanVersion: number;
  remainingBefore: Readonly<RecoveryBudgets>;
  remainingAfter: Readonly<RecoveryBudgets>;
  directiveHash?: string;
}

export interface RecoveryLimits {
  maxEntries: number;
  maxPlanVersions: number;
  budgets: Readonly<RecoveryBudgets>;
}

export interface RecoveryAuthority {
  version: 1;
  runId: string;
  graphDigest: string;
  activePlanVersion: number;
  activePlanHash: string;
  limits: Readonly<RecoveryLimits>;
}

export interface RecoveryLedgerGenesis extends RecoveryAuthority {
  limitsHash: string;
  genesisHash: string;
}

interface RecoveryLedgerRecordBase {
  sequence: number;
  previousHash: string;
  hash: string;
}

export interface RecoveryRegistrationRecord extends RecoveryLedgerRecordBase {
  kind: "registration";
  failure: FailureEvidence;
  state: RecoveryState;
}

export interface RecoveryDecisionRecord extends RecoveryLedgerRecordBase {
  kind: "decision";
  fingerprint: string;
  directive?: RecoveryDirective;
  decision: RecoveryDecision;
  state: RecoveryState;
}

export interface RecoverySuccessorRecord extends RecoveryLedgerRecordBase {
  kind: "successor";
  fingerprint: string;
  event: RecoverySuccessorEvent;
  state: RecoveryState;
}

export interface RecoveryReleaseRecord extends RecoveryLedgerRecordBase {
  kind: "release";
  fingerprint: string;
  release: RecoveryRelease;
  state: RecoveryState;
}

export type RecoveryLedgerRecord =
  | RecoveryRegistrationRecord
  | RecoveryDecisionRecord
  | RecoverySuccessorRecord
  | RecoveryReleaseRecord;

export interface RecoveryLedger {
  version: 1;
  genesis: Readonly<RecoveryLedgerGenesis>;
  records: readonly Readonly<RecoveryLedgerRecord>[];
  headHash: string;
}

interface ApprovedPlanBinding {
  version: number;
  hash: string;
}

interface SuccessorNamespaceReservation {
  fingerprint: string;
  graphHash: string;
  planHash: string;
}

export type RecoverySuccessorEvent =
  | RecoverySuccessorArtifactEvent
  | RecoverySuccessorApprovalEvent
  | RecoverySuccessorActivationEvent;

export interface RecoverySuccessorArtifactEvent {
  version: 1;
  phase: "artifact-durable";
  failureFingerprint: string;
  sourcePlanVersion: number;
  targetPlanVersion: number;
  graphHash: string;
  planHash: string;
  graphRef: string;
  planRef: string;
}

export interface RecoverySuccessorApprovalEvent extends Omit<RecoverySuccessorArtifactEvent, "phase"> {
  phase: "approved";
  approvalHash: string;
  approvalRef: string;
}

export interface RecoverySuccessorActivationEvent extends Omit<RecoverySuccessorApprovalEvent, "phase"> {
  phase: "activated";
}

export interface RecoveryRelease {
  version: 1;
  failureFingerprint: string;
  reason: "configuration-changed" | "authorization-granted" | "policy-changed" | "side-effect-reviewed";
  evidenceRef: string;
  evidenceHash: string;
}

export type RecoveryRankingTuple = readonly [
  active: number,
  effectiveBudget: number,
  availableLevels: number,
  successorSteps: number,
  planVersionCapacity: number,
];

const FAILURE_CATEGORY_SET = new Set<string>(FAILURE_CATEGORIES);
const RECOVERY_LEVEL_SET = new Set<string>(RECOVERY_LEVELS);
const CONTRACT_VIOLATION_SET = new Set<string>(CONTRACT_VIOLATIONS);
const RECOVERY_STATUS_SET = new Set<string>([
  "active",
  "waiting-diagnosis",
  "waiting-configuration",
  "waiting-authorization",
  "waiting-policy",
  "waiting-side-effect-review",
  "waiting-successor-artifact",
  "waiting-successor-approval",
  "ready-successor-activation",
  "released",
  "failed",
]);
const CONFIDENCE_SET = new Set<string>(["low", "medium", "high"]);
const TOPOLOGY_ASSESSMENT_SET = new Set<string>(["preserve", "structural"]);
const ACTION_SET = new Set<string>([...RECOVERY_LEVELS, "pause", "fail"]);
const REASON_SET = new Set<string>([
  "transient-failure",
  "local-defect",
  "structural-defect",
  "diagnosis-required",
  "unknown-after-diagnosis",
  "configuration-change-required",
  "human-authorization-required",
  "policy-change-required",
  "side-effect-review-required",
  "global-budget-exhausted",
  "retry-exhausted",
  "repair-exhausted",
  "replan-exhausted",
  "recovery-level-consumed",
  "recovery-level-skipped",
]);
const HASH = /^[a-f0-9]{64}$/;
const METADATA_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const MAX_TOKEN_LENGTH = 128;
const MAX_REFERENCE_LENGTH = 256;
const MAX_REFERENCES = 32;
const MAX_PLAN_VERSION = 1_000_000;
const MAX_LEDGER_ENTRIES = 1_024;
const MAX_LEDGER_RECORDS_PER_ENTRY = 8;
const MAX_RECOVERY_LEDGER_BYTES = 8 * 1024 * 1024;
const PORTABLE_SEGMENT = /^[A-Za-z0-9@+_,.-]+$/;
const PROTECTED_REPOSITORY_SEGMENTS = new Set([".git", ".ai-orchestrator"]);
const MAX_REPOSITORY_PATH_BYTES = 1_024;

const TRANSIENT_CATEGORIES = new Set<FailureCategory>(["transient-provider", "transient-tool", "timeout"]);
const LOCAL_CATEGORIES = new Set<FailureCategory>(["output-contract", "implementation-defect"]);
const STRUCTURAL_CATEGORIES = new Set<FailureCategory>([
  "missing-dependency",
  "invalid-topology",
  "wrong-decomposition",
]);

export function validateFailureEvidence(value: unknown): FailureEvidence {
  const record = requireRecord(value, "failure evidence");
  assertNoUnexpectedFields(record, [
    "version",
    "runId",
    "nodeId",
    "category",
    "nodeKind",
    "graphVersion",
    "graphDigest",
    "planVersion",
    "planHash",
    "attempt",
    "failureLineageId",
    "contractViolation",
    "contractId",
    "artifactHashes",
  ], "failure evidence");
  if (record.version !== 1) throw new Error("failure evidence version must be 1");
  const runId = requireMetadataToken(record.runId, "failure evidence runId");
  const nodeId = requireMetadataToken(record.nodeId, "failure evidence nodeId");
  const category = requireFailureCategory(record.category, "failure evidence category");
  const nodeKind = requireMetadataToken(record.nodeKind, "failure evidence nodeKind");
  const graphVersion = requireMetadataToken(record.graphVersion, "failure evidence graphVersion");
  const graphDigest = requireHash(record.graphDigest, "failure evidence graphDigest");
  const planVersion = requirePlanVersion(record.planVersion, "failure evidence planVersion");
  const planHash = requireHash(record.planHash, "failure evidence planHash");
  const attempt = requirePositiveInteger(record.attempt, "failure evidence attempt", MAX_PLAN_VERSION);
  const failureLineageId = requireMetadataToken(record.failureLineageId, "failure evidence failureLineageId");
  let contractViolation: ContractViolation | undefined;
  if (record.contractViolation !== undefined) {
    if (typeof record.contractViolation !== "string" || !CONTRACT_VIOLATION_SET.has(record.contractViolation)) {
      throw new Error("failure evidence contractViolation is invalid");
    }
    contractViolation = record.contractViolation as ContractViolation;
  }
  const contractId = record.contractId === undefined
    ? undefined
    : requireMetadataToken(record.contractId, "failure evidence contractId");
  const artifactHashes = requireUniqueHashes(record.artifactHashes, "failure evidence artifactHashes");
  return Object.freeze({
    version: 1,
    runId,
    nodeId,
    category,
    nodeKind,
    graphVersion,
    graphDigest,
    planVersion,
    planHash,
    attempt,
    failureLineageId,
    ...(contractViolation === undefined ? {} : { contractViolation }),
    ...(contractId === undefined ? {} : { contractId }),
    artifactHashes,
  });
}

export function fingerprintFailure(value: FailureEvidence): string {
  const evidence = validateFailureEvidence(value);
  const canonical = JSON.stringify({
    version: evidence.version,
    runId: evidence.runId,
    nodeId: evidence.nodeId,
    category: evidence.category,
    nodeKind: evidence.nodeKind,
    graphVersion: evidence.graphVersion,
    graphDigest: evidence.graphDigest,
    planVersion: evidence.planVersion,
    planHash: evidence.planHash,
    attempt: evidence.attempt,
    failureLineageId: evidence.failureLineageId,
    contractViolation: evidence.contractViolation ?? null,
    contractId: evidence.contractId ?? null,
    artifactHashes: evidence.artifactHashes,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function recoveryBudgetKey(value: FailureEvidence): string {
  const evidence = validateFailureEvidence(value);
  return sha256(canonicalJson({
    version: evidence.version,
    runId: evidence.runId,
    nodeId: evidence.nodeId,
    graphDigest: evidence.graphDigest,
    failureLineageId: evidence.failureLineageId,
  }));
}

function createRecoveryState(
  failure: FailureEvidence,
  genesis: RecoveryLedgerGenesis,
  previousLineageState?: RecoveryState,
): RecoveryState {
  const evidence = validateFailureEvidence(failure);
  if (previousLineageState && previousLineageState.status !== "released") {
    throw new Error("a new recovery occurrence requires the prior lineage occurrence to be released");
  }
  return validateRecoveryState({
    version: 1,
    status: "active",
    genesisHash: genesis.genesisHash,
    fingerprint: fingerprintFailure(evidence),
    budgetKey: recoveryBudgetKey(evidence),
    observedCategory: evidence.category,
    consumed: previousLineageState?.consumed ?? [],
    remaining: previousLineageState?.remaining ?? genesis.limits.budgets,
    sourcePlanVersion: evidence.planVersion,
    sourcePlanHash: evidence.planHash,
    approvedPlanVersion: evidence.planVersion,
    approvedPlanHash: evidence.planHash,
    planVersionCeiling: genesis.limits.maxPlanVersions,
  });
}

export function createRecoveryLedger(authorityValue: RecoveryAuthority): RecoveryLedger {
  const authority = validateRecoveryAuthority(authorityValue);
  const limitsHash = sha256(canonicalJson(authority.limits));
  const genesisHash = sha256(canonicalJson({
    version: 1,
    runId: authority.runId,
    graphDigest: authority.graphDigest,
    activePlanVersion: authority.activePlanVersion,
    activePlanHash: authority.activePlanHash,
    limits: authority.limits,
    limitsHash,
  }));
  const genesis = Object.freeze({ ...authority, limitsHash, genesisHash });
  return Object.freeze({ version: 1, genesis, records: Object.freeze([]), headHash: genesisHash });
}

export function validateRecoveryAuthority(value: unknown): RecoveryAuthority {
  const record = requireRecord(value, "recovery authority");
  assertNoUnexpectedFields(record, [
    "version", "runId", "graphDigest", "activePlanVersion", "activePlanHash", "limits",
  ], "recovery authority");
  if (record.version !== 1) throw new Error("recovery authority version must be 1");
  const runId = requireMetadataToken(record.runId, "recovery authority runId");
  const graphDigest = requireHash(record.graphDigest, "recovery authority graphDigest");
  const activePlanVersion = requirePlanVersion(record.activePlanVersion, "recovery authority activePlanVersion");
  const activePlanHash = requireHash(record.activePlanHash, "recovery authority activePlanHash");
  const limitsRecord = requireRecord(record.limits, "recovery authority limits");
  assertNoUnexpectedFields(limitsRecord, ["maxEntries", "maxPlanVersions", "budgets"], "recovery authority limits");
  const maxEntries = requireLedgerEntryLimit(limitsRecord.maxEntries);
  const maxPlanVersions = requirePlanVersion(limitsRecord.maxPlanVersions, "recovery authority maxPlanVersions");
  if (activePlanVersion > maxPlanVersions) {
    throw new Error("recovery authority activePlanVersion exceeds maxPlanVersions");
  }
  const budgets = requireBudgets(limitsRecord.budgets, "recovery authority budgets");
  return Object.freeze({
    version: 1,
    runId,
    graphDigest,
    activePlanVersion,
    activePlanHash,
    limits: Object.freeze({ maxEntries, maxPlanVersions, budgets }),
  });
}

export function validateRecoveryLedger(value: unknown, authorityValue: RecoveryAuthority): RecoveryLedger {
  const authority = validateRecoveryAuthority(authorityValue);
  const record = requireRecord(value, "recovery ledger");
  assertNoUnexpectedFields(record, ["version", "genesis", "records", "headHash"], "recovery ledger");
  if (record.version !== 1) throw new Error("recovery ledger version must be 1");
  const genesis = validateLedgerGenesis(record.genesis, authority);
  const sourceRecords = requireExactArray(record.records, "recovery ledger records", authority.limits.maxEntries * MAX_LEDGER_RECORDS_PER_ENTRY);
  const records: RecoveryLedgerRecord[] = [];
  const contexts = new Map<string, { failure: FailureEvidence; state: RecoveryState; records: number }>();
  const lineages = new Map<string, RecoveryState>();
  const successorReservations = new Map<number, SuccessorNamespaceReservation>();
  let approvedPlan: ApprovedPlanBinding = {
    version: genesis.activePlanVersion,
    hash: genesis.activePlanHash,
  };
  let previousHash = genesis.genesisHash;
  let registrations = 0;
  for (let index = 0; index < sourceRecords.length; index += 1) {
    const parsed = validateLedgerRecord(
      sourceRecords[index],
      index + 1,
      previousHash,
      genesis,
      approvedPlan,
      successorReservations,
      contexts,
      lineages,
    );
    if (parsed.kind === "registration") registrations += 1;
    if (registrations > authority.limits.maxEntries) throw new Error("recovery ledger exceeds its entry limit");
    records.push(parsed);
    previousHash = parsed.hash;
    if (parsed.kind === "successor" && parsed.event.phase === "activated") {
      approvedPlan = { version: parsed.event.targetPlanVersion, hash: parsed.event.planHash };
    }
  }
  const headHash = requireHash(record.headHash, "recovery ledger headHash");
  if (headHash !== previousHash) throw new Error("recovery ledger head hash does not match its append-only hash chain");
  const normalized = Object.freeze({
    version: 1,
    genesis,
    records: Object.freeze(records),
    headHash,
  });
  if (Buffer.byteLength(canonicalJson(normalized), "utf8") > MAX_RECOVERY_LEDGER_BYTES) {
    throw new Error("recovery ledger exceeds its canonical byte limit");
  }
  return normalized;
}

export function registerRecovery(
  ledgerValue: RecoveryLedger,
  authorityValue: RecoveryAuthority,
  failure: FailureEvidence,
): RecoveryLedger {
  const authority = validateRecoveryAuthority(authorityValue);
  const ledger = validateRecoveryLedger(ledgerValue, authority);
  const evidence = validateFailureEvidence(failure);
  assertFailureMatchesCurrentPlan(evidence, authority, currentApprovedPlanBinding(ledger));
  const previousLineageState = latestLineageState(ledger, recoveryBudgetKey(evidence));
  const state = createRecoveryState(evidence, ledger.genesis, previousLineageState);
  if (ledger.records.some((candidate) => candidate.kind === "registration" && candidate.state.fingerprint === state.fingerprint)) {
    throw new Error(`recovery fingerprint ${state.fingerprint} is already initialized`);
  }
  const registrations = ledger.records.filter((candidate) => candidate.kind === "registration").length;
  if (registrations >= ledger.genesis.limits.maxEntries) throw new Error("recovery ledger entry limit is reached");
  return appendLedgerRecord(ledger, authority, {
    kind: "registration",
    failure: evidence,
    state,
  });
}

export function resumeRecoveryState(
  ledgerValue: RecoveryLedger,
  authorityValue: RecoveryAuthority,
  fingerprintValue: string,
): RecoveryState {
  const authority = validateRecoveryAuthority(authorityValue);
  const ledger = validateRecoveryLedger(ledgerValue, authority);
  const fingerprint = requireHash(fingerprintValue, "recovery resume fingerprint");
  return currentStateForFingerprint(ledger, fingerprint);
}

export function applyRecoveryDecisionToLedger(
  ledgerValue: RecoveryLedger,
  authorityValue: RecoveryAuthority,
  fingerprintValue: string,
  directiveValue?: RecoveryDirective,
): RecoveryLedger {
  const authority = validateRecoveryAuthority(authorityValue);
  const ledger = validateRecoveryLedger(ledgerValue, authority);
  const fingerprint = requireHash(fingerprintValue, "recovery decision fingerprint");
  const failure = failureForFingerprint(ledger, fingerprint);
  const current = currentStateForFingerprint(ledger, fingerprint);
  assertStateSourceMatchesCurrentPlan(current, currentApprovedPlanBinding(ledger));
  const directive = directiveValue === undefined ? undefined : validateRecoveryDirective(directiveValue);
  const decision = classifyFailure(failure, current, directive);
  const next = applyRecoveryDecision(current, decision);
  return appendLedgerRecord(ledger, authority, {
    kind: "decision",
    fingerprint,
    ...(directive === undefined ? {} : { directive }),
    decision,
    state: next,
  });
}

export function validateRecoveryState(value: unknown): RecoveryState {
  const record = requireRecord(value, "recovery state");
  assertNoUnexpectedFields(record, [
    "version",
    "status",
    "genesisHash",
    "fingerprint",
    "budgetKey",
    "observedCategory",
    "consumed",
    "remaining",
    "sourcePlanVersion",
    "sourcePlanHash",
    "approvedPlanVersion",
    "approvedPlanHash",
    "planVersionCeiling",
    "successor",
  ], "recovery state");
  if (record.version !== 1) throw new Error("recovery state version must be 1");
  if (typeof record.status !== "string" || !RECOVERY_STATUS_SET.has(record.status)) {
    throw new Error("recovery state status is invalid");
  }
  const genesisHash = requireHash(record.genesisHash, "recovery state genesisHash");
  const fingerprint = requireHash(record.fingerprint, "recovery state fingerprint");
  const budgetKey = requireHash(record.budgetKey, "recovery state budgetKey");
  const observedCategory = requireFailureCategory(record.observedCategory, "recovery state observedCategory");
  const consumed = requireConsumedLevels(record.consumed);
  const remaining = requireBudgets(record.remaining, "recovery state remaining");
  const sourcePlanVersion = requirePlanVersion(record.sourcePlanVersion, "recovery state sourcePlanVersion");
  const sourcePlanHash = requireHash(record.sourcePlanHash, "recovery state sourcePlanHash");
  const approvedPlanVersion = requirePlanVersion(record.approvedPlanVersion, "recovery state approvedPlanVersion");
  const approvedPlanHash = requireHash(record.approvedPlanHash, "recovery state approvedPlanHash");
  const planVersionCeiling = requirePlanVersion(record.planVersionCeiling, "recovery state planVersionCeiling");
  if (sourcePlanVersion > planVersionCeiling || approvedPlanVersion > planVersionCeiling) {
    throw new Error("recovery state plan version exceeds its frozen ceiling");
  }
  for (const level of consumed) {
    if (remaining[level] !== 0) throw new Error(`recovery state consumed ${level} must have zero remaining budget`);
  }
  const successor = record.successor === undefined ? undefined : validateRecoverySuccessorState(record.successor);
  if (successor !== undefined && !consumed.includes("replan")) {
    throw new Error("recovery state successor intent requires a consumed replan");
  }
  if (successor) {
    if (successor.sourcePlanVersion !== sourcePlanVersion || successor.targetPlanVersion !== sourcePlanVersion + 1 ||
        successor.targetPlanVersion > planVersionCeiling) {
      throw new Error("recovery state successor versions are invalid");
    }
  }
  const status = record.status as RecoveryStatus;
  const expectedSuccessorStatus: Partial<Record<RecoveryStatus, RecoverySuccessorState["status"]>> = {
    "waiting-successor-artifact": "intent-recorded",
    "waiting-successor-approval": "artifact-durable",
    "ready-successor-activation": "approved",
  };
  const expected = expectedSuccessorStatus[status];
  if (expected !== undefined && successor?.status !== expected) {
    throw new Error(`recovery state ${status} requires successor status ${expected}`);
  }
  if (successor && successor.status !== "activated") {
    const expectedStatus = ({
      "intent-recorded": "waiting-successor-artifact",
      "artifact-durable": "waiting-successor-approval",
      approved: "ready-successor-activation",
    } as const)[successor.status];
    if (status !== expectedStatus) {
      throw new Error(`recovery successor ${successor.status} requires state ${expectedStatus}`);
    }
  }
  if (successor?.status === "activated") {
    if (status !== "released" || approvedPlanVersion !== successor.targetPlanVersion ||
        approvedPlanHash !== successor.planHash) {
      throw new Error("activated recovery successor must be released as the approved plan version");
    }
  } else if (approvedPlanVersion !== sourcePlanVersion || approvedPlanHash !== sourcePlanHash) {
    throw new Error("recovery state cannot change the approved plan before successor activation");
  }
  return Object.freeze({
    version: 1,
    status,
    genesisHash,
    fingerprint,
    budgetKey,
    observedCategory,
    consumed,
    remaining,
    sourcePlanVersion,
    sourcePlanHash,
    approvedPlanVersion,
    approvedPlanHash,
    planVersionCeiling,
    ...(successor === undefined ? {} : { successor }),
  });
}

export function validateRecoveryDirective(value: unknown): RecoveryDirective {
  const record = requireRecord(value, "recovery directive");
  assertNoUnexpectedFields(record, [
    "version",
    "failureFingerprint",
    "rootCauseCategory",
    "confidence",
    "diagnosisRef",
    "diagnosisHash",
    "evidenceRefs",
    "repairScope",
    "validationRequirements",
    "topologyAssessment",
  ], "recovery directive");
  if (record.version !== 1) throw new Error("recovery directive version must be 1");
  const failureFingerprint = requireHash(record.failureFingerprint, "recovery directive failureFingerprint");
  const rootCauseCategory = requireFailureCategory(record.rootCauseCategory, "recovery directive rootCauseCategory");
  if (typeof record.confidence !== "string" || !CONFIDENCE_SET.has(record.confidence)) {
    throw new Error("recovery directive confidence is invalid");
  }
  const diagnosisRef = requirePortablePath(record.diagnosisRef, "recovery directive diagnosisRef", false);
  const diagnosisHash = requireHash(record.diagnosisHash, "recovery directive diagnosisHash");
  const evidenceRefs = requirePortablePaths(record.evidenceRefs, "recovery directive evidenceRefs", false);
  const repairScope = requirePortablePaths(record.repairScope, "recovery directive repairScope", true);
  const validationRequirements = requireLogicalReferences(
    record.validationRequirements,
    "recovery directive validationRequirements",
  );
  if (typeof record.topologyAssessment !== "string" || !TOPOLOGY_ASSESSMENT_SET.has(record.topologyAssessment)) {
    throw new Error("recovery directive topologyAssessment is invalid");
  }
  const topologyAssessment = record.topologyAssessment as RecoveryDirective["topologyAssessment"];

  if (LOCAL_CATEGORIES.has(rootCauseCategory)) {
    if (topologyAssessment !== "preserve") {
      throw new Error("recovery directive local root cause must preserve topology");
    }
    if (repairScope.length === 0) throw new Error("recovery directive repairScope is required for a local root cause");
    if (validationRequirements.length === 0) {
      throw new Error("recovery directive validationRequirements are required for a local root cause");
    }
  }
  if (STRUCTURAL_CATEGORIES.has(rootCauseCategory) && topologyAssessment !== "structural") {
    throw new Error("recovery directive structural root cause must declare structural topology");
  }
  if (STRUCTURAL_CATEGORIES.has(rootCauseCategory) && validationRequirements.length === 0) {
    throw new Error("recovery directive validationRequirements are required for a structural root cause");
  }
  if (!STRUCTURAL_CATEGORIES.has(rootCauseCategory) && topologyAssessment === "structural") {
    throw new Error("recovery directive structural topology requires a structural root cause");
  }

  return Object.freeze({
    version: 1,
    failureFingerprint,
    rootCauseCategory,
    confidence: record.confidence as RecoveryDirective["confidence"],
    diagnosisRef,
    diagnosisHash,
    evidenceRefs,
    repairScope,
    validationRequirements,
    topologyAssessment,
  });
}

export function recoveryDirectiveDigest(value: RecoveryDirective): string {
  return sha256(canonicalJson(validateRecoveryDirective(value)));
}

export function validateRecoveryDecision(value: unknown): RecoveryDecision {
  const record = requireRecord(value, "recovery decision");
  assertNoUnexpectedFields(record, [
    "version",
    "failureFingerprint",
    "observedCategory",
    "effectiveCategory",
    "action",
    "reason",
    "topology",
    "sourcePlanVersion",
    "sourcePlanHash",
    "targetPlanVersion",
    "remainingBefore",
    "remainingAfter",
    "directiveHash",
  ], "recovery decision");
  if (record.version !== 1) throw new Error("recovery decision version must be 1");
  const failureFingerprint = requireHash(record.failureFingerprint, "recovery decision failureFingerprint");
  const observedCategory = requireFailureCategory(record.observedCategory, "recovery decision observedCategory");
  const effectiveCategory = requireFailureCategory(record.effectiveCategory, "recovery decision effectiveCategory");
  if (typeof record.action !== "string" || !ACTION_SET.has(record.action)) {
    throw new Error("recovery decision action is invalid");
  }
  if (typeof record.reason !== "string" || !REASON_SET.has(record.reason)) {
    throw new Error("recovery decision reason is invalid");
  }
  if (record.topology !== "preserve" && record.topology !== "successor") {
    throw new Error("recovery decision topology is invalid");
  }
  const sourcePlanVersion = requirePlanVersion(record.sourcePlanVersion, "recovery decision sourcePlanVersion");
  const sourcePlanHash = requireHash(record.sourcePlanHash, "recovery decision sourcePlanHash");
  const targetPlanVersion = requirePlanVersion(record.targetPlanVersion, "recovery decision targetPlanVersion");
  const remainingBefore = requireBudgets(record.remainingBefore, "recovery decision remainingBefore");
  const remainingAfter = requireBudgets(record.remainingAfter, "recovery decision remainingAfter");
  const directiveHash = record.directiveHash === undefined
    ? undefined
    : requireHash(record.directiveHash, "recovery decision directiveHash");
  const action = record.action as RecoveryAction;
  const reason = record.reason as RecoveryReason;
  assertDecisionSemantics(observedCategory, effectiveCategory, action, reason);
  const diagnosisBound = reason !== "diagnosis-required" &&
    (LOCAL_CATEGORIES.has(effectiveCategory) || STRUCTURAL_CATEGORIES.has(effectiveCategory) || observedCategory === "unknown");
  if (diagnosisBound && directiveHash === undefined) {
    throw new Error("recovery decision requires its immutable diagnosis directive hash");
  }
  if (reason === "diagnosis-required" && directiveHash !== undefined) {
    throw new Error("diagnosis-required recovery decision cannot claim a completed directive");
  }

  if (isRecoveryLevel(action)) {
    assertSingleBudgetConsumption(action, remainingBefore, remainingAfter);
    const expectedTarget = action === "replan" ? sourcePlanVersion + 1 : sourcePlanVersion;
    if (targetPlanVersion !== expectedTarget) {
      throw new Error(`recovery decision ${action} targetPlanVersion is invalid`);
    }
    const expectedTopology: RecoveryTopology = action === "replan" ? "successor" : "preserve";
    if (record.topology !== expectedTopology) {
      throw new Error(`recovery decision ${action} topology must be ${expectedTopology}`);
    }
  } else {
    if (!budgetsEqual(remainingBefore, remainingAfter)) {
      throw new Error(`recovery decision ${action} must not change remaining budgets`);
    }
    if (targetPlanVersion !== sourcePlanVersion || record.topology !== "preserve") {
      throw new Error(`recovery decision ${action} must preserve the active plan`);
    }
  }

  return Object.freeze({
    version: 1,
    failureFingerprint,
    observedCategory,
    effectiveCategory,
    action,
    reason,
    topology: record.topology,
    sourcePlanVersion,
    sourcePlanHash,
    targetPlanVersion,
    remainingBefore,
    remainingAfter,
    ...(directiveHash === undefined ? {} : { directiveHash }),
  });
}

export function classifyFailure(
  failureValue: FailureEvidence,
  stateValue: RecoveryState,
  directiveValue?: RecoveryDirective,
): RecoveryDecision {
  const failure = validateFailureEvidence(failureValue);
  const state = validateRecoveryState(stateValue);
  if (state.status !== "active" && state.status !== "waiting-diagnosis") {
    throw new Error(`cannot classify failure from recovery state ${state.status}`);
  }
  if (state.status === "waiting-diagnosis" && directiveValue === undefined) {
    throw new Error("waiting diagnosis recovery requires its typed directive");
  }
  const fingerprint = fingerprintFailure(failure);
  if (fingerprint !== state.fingerprint || failure.category !== state.observedCategory) {
    throw new Error("failure evidence does not match the recovery state fingerprint");
  }

  const directive = directiveValue === undefined ? undefined : validateRecoveryDirective(directiveValue);
  if (directive && directive.failureFingerprint !== fingerprint) {
    throw new Error("recovery directive fingerprint does not match failure evidence");
  }
  if (directive) assertDirectiveArtifactBinding(failure, directive);
  if (directive && failure.category !== "unknown" && directive.rootCauseCategory !== failure.category) {
    throw new Error("recovery directive cannot recategorize known failure evidence");
  }
  const directiveHash = directive === undefined ? undefined : recoveryDirectiveDigest(directive);

  const category = directive?.rootCauseCategory ?? failure.category;
  if (category === "budget") return stopDecision(state, category, "fail", "global-budget-exhausted", directiveHash);
  if (category === "configuration") {
    return stopDecision(state, category, "pause", "configuration-change-required", directiveHash);
  }
  if (category === "authorization") {
    return stopDecision(state, category, "pause", "human-authorization-required", directiveHash);
  }
  if (category === "policy") return stopDecision(state, category, "pause", "policy-change-required", directiveHash);
  if (category === "side-effect") {
    return stopDecision(state, category, "pause", "side-effect-review-required", directiveHash);
  }
  if ((LOCAL_CATEGORIES.has(category) || STRUCTURAL_CATEGORIES.has(category) || category === "unknown") && !directive) {
    return stopDecision(state, category, "pause", "diagnosis-required");
  }
  if (category === "unknown") return stopDecision(state, category, "fail", "unknown-after-diagnosis", directiveHash);

  if (TRANSIENT_CATEGORIES.has(category)) {
    return recoveryDecision(state, category, "retry", "transient-failure", directiveHash);
  }
  if (LOCAL_CATEGORIES.has(category)) {
    return recoveryDecision(state, category, "repair", "local-defect", directiveHash);
  }
  if (STRUCTURAL_CATEGORIES.has(category)) {
    return recoveryDecision(state, category, "replan", "structural-defect", directiveHash);
  }
  throw new Error(`Unhandled failure category: ${category}`);
}

export function applyRecoveryDecision(
  stateValue: RecoveryState,
  decisionValue: RecoveryDecision,
): RecoveryState {
  const state = validateRecoveryState(stateValue);
  const decision = validateRecoveryDecision(decisionValue);
  if (state.status === "released" || state.status === "failed") return state;
  if (state.status !== "active" && state.status !== "waiting-diagnosis") {
    throw new Error(`recovery state ${state.status} requires an explicit resume or successor event`);
  }
  if (decision.failureFingerprint !== state.fingerprint) {
    throw new Error("recovery decision fingerprint does not match recovery state fingerprint");
  }
  if (decision.observedCategory !== state.observedCategory) {
    throw new Error("recovery decision observed category does not match recovery state");
  }
  if (!budgetsEqual(decision.remainingBefore, state.remaining)) {
    throw new Error("recovery decision has a stale remaining budget snapshot");
  }
  if (decision.sourcePlanVersion !== state.approvedPlanVersion) {
    throw new Error("recovery decision has a stale source plan version");
  }
  if (decision.sourcePlanHash !== state.approvedPlanHash) {
    throw new Error("recovery decision has a stale source plan hash");
  }

  if (!isRecoveryLevel(decision.action)) {
    const status = decision.action === "fail" ? "failed" : waitingStatusForReason(decision.reason);
    return validateRecoveryState({
      ...state,
      status,
    });
  }

  const previousLevel = state.consumed.at(-1);
  if (state.consumed.includes(decision.action)) {
    throw new Error(`recovery level ${decision.action} was already consumed`);
  }
  if (previousLevel !== undefined && levelRank(decision.action) <= levelRank(previousLevel)) {
    throw new Error(`recovery level ${decision.action} would regress from ${previousLevel}`);
  }
  if (previousLevel !== undefined && levelRank(decision.action) !== levelRank(previousLevel) + 1) {
    throw new Error(`recovery level ${decision.action} would skip the level after ${previousLevel}`);
  }
  const expectedRemaining = consumeBudget(state.remaining, decision.action);
  if (!budgetsEqual(decision.remainingAfter, expectedRemaining)) {
    throw new Error("recovery decision remaining budget does not match state transition");
  }
  const expectedTarget = decision.action === "replan" ? state.approvedPlanVersion + 1 : state.approvedPlanVersion;
  if (decision.targetPlanVersion !== expectedTarget) {
    throw new Error("recovery decision target plan version does not match state transition");
  }

  const successor = decision.action === "replan" ? Object.freeze({
    status: "intent-recorded" as const,
    sourcePlanVersion: state.approvedPlanVersion,
    targetPlanVersion: decision.targetPlanVersion,
  }) : undefined;
  return validateRecoveryState({
    ...state,
    status: decision.action === "replan" ? "waiting-successor-artifact" : "released",
    consumed: [...state.consumed, decision.action],
    remaining: decision.remainingAfter,
    approvedPlanVersion: state.approvedPlanVersion,
    ...(successor === undefined ? {} : { successor }),
  });
}

export function applyRecoverySuccessorEventToLedger(
  ledgerValue: RecoveryLedger,
  authorityValue: RecoveryAuthority,
  eventValue: RecoverySuccessorEvent,
): RecoveryLedger {
  const authority = validateRecoveryAuthority(authorityValue);
  const ledger = validateRecoveryLedger(ledgerValue, authority);
  const event = validateRecoverySuccessorEvent(eventValue);
  const current = currentStateForFingerprint(ledger, event.failureFingerprint);
  assertStateSourceMatchesCurrentPlan(current, currentApprovedPlanBinding(ledger));
  const next = applyRecoverySuccessorEvent(current, event);
  return appendLedgerRecord(ledger, authority, {
    kind: "successor",
    fingerprint: event.failureFingerprint,
    event,
    state: next,
  });
}

export function applyRecoveryReleaseToLedger(
  ledgerValue: RecoveryLedger,
  authorityValue: RecoveryAuthority,
  releaseValue: RecoveryRelease,
): RecoveryLedger {
  const authority = validateRecoveryAuthority(authorityValue);
  const ledger = validateRecoveryLedger(ledgerValue, authority);
  const release = validateRecoveryRelease(releaseValue);
  const current = currentStateForFingerprint(ledger, release.failureFingerprint);
  assertStateSourceMatchesCurrentPlan(current, currentApprovedPlanBinding(ledger));
  const next = applyRecoveryRelease(current, release);
  return appendLedgerRecord(ledger, authority, {
    kind: "release",
    fingerprint: release.failureFingerprint,
    release,
    state: next,
  });
}

export function validateRecoverySuccessorEvent(value: unknown): RecoverySuccessorEvent {
  const record = requireRecord(value, "recovery successor event");
  if (record.phase !== "artifact-durable" && record.phase !== "approved" && record.phase !== "activated") {
    throw new Error("recovery successor event phase is invalid");
  }
  const approvalPhase = record.phase === "approved" || record.phase === "activated";
  assertNoUnexpectedFields(record, [
    "version",
    "phase",
    "failureFingerprint",
    "sourcePlanVersion",
    "targetPlanVersion",
    "graphHash",
    "planHash",
    "graphRef",
    "planRef",
    ...(approvalPhase ? ["approvalHash", "approvalRef"] : []),
  ], "recovery successor event");
  if (record.version !== 1) throw new Error("recovery successor event version must be 1");
  const failureFingerprint = requireHash(record.failureFingerprint, "recovery successor event failureFingerprint");
  const sourcePlanVersion = requirePlanVersion(record.sourcePlanVersion, "recovery successor event sourcePlanVersion");
  const targetPlanVersion = requirePlanVersion(record.targetPlanVersion, "recovery successor event targetPlanVersion");
  if (targetPlanVersion !== sourcePlanVersion + 1) {
    throw new Error("recovery successor event target must be the exact successor plan version");
  }
  const graphHash = requireHash(record.graphHash, "recovery successor event graphHash");
  const planHash = requireHash(record.planHash, "recovery successor event planHash");
  const graphRef = requirePortablePath(record.graphRef, "recovery successor event graphRef", false);
  const planRef = requirePortablePath(record.planRef, "recovery successor event planRef", false);
  if (graphRef !== `plan-versions/${targetPlanVersion}/graph.json` ||
      planRef !== `plan-versions/${targetPlanVersion}/plan.md`) {
    throw new Error("recovery successor event artifact references do not match the exact target plan version");
  }
  const common = {
    version: 1 as const,
    phase: record.phase,
    failureFingerprint,
    sourcePlanVersion,
    targetPlanVersion,
    graphHash,
    planHash,
    graphRef,
    planRef,
  };
  if (!approvalPhase) return Object.freeze(common) as RecoverySuccessorArtifactEvent;
  const approvalHash = requireHash(record.approvalHash, "recovery successor event approvalHash");
  const approvalRef = requirePortablePath(record.approvalRef, "recovery successor event approvalRef", false);
  if (approvalRef !== `plan-versions/${targetPlanVersion}/approval.json`) {
    throw new Error("recovery successor event approvalRef does not match the exact target plan version");
  }
  return Object.freeze({ ...common, approvalHash, approvalRef }) as RecoverySuccessorEvent;
}

export function validateRecoveryRelease(value: unknown): RecoveryRelease {
  const record = requireRecord(value, "recovery release");
  assertNoUnexpectedFields(record, [
    "version",
    "failureFingerprint",
    "reason",
    "evidenceRef",
    "evidenceHash",
  ], "recovery release");
  if (record.version !== 1) throw new Error("recovery release version must be 1");
  const failureFingerprint = requireHash(record.failureFingerprint, "recovery release failureFingerprint");
  if (record.reason !== "configuration-changed" && record.reason !== "authorization-granted" &&
      record.reason !== "policy-changed" && record.reason !== "side-effect-reviewed") {
    throw new Error("recovery release reason is invalid");
  }
  const evidenceRef = requirePortablePath(record.evidenceRef, "recovery release evidenceRef", false);
  const evidenceHash = requireHash(record.evidenceHash, "recovery release evidenceHash");
  return Object.freeze({
    version: 1,
    failureFingerprint,
    reason: record.reason,
    evidenceRef,
    evidenceHash,
  });
}

function applyRecoverySuccessorEvent(
  stateValue: RecoveryState,
  eventValue: RecoverySuccessorEvent,
): RecoveryState {
  const state = validateRecoveryState(stateValue);
  const event = validateRecoverySuccessorEvent(eventValue);
  if (event.failureFingerprint !== state.fingerprint) {
    throw new Error("recovery successor event fingerprint does not match state");
  }
  const successor = state.successor;
  if (!successor || event.sourcePlanVersion !== successor.sourcePlanVersion ||
      event.targetPlanVersion !== successor.targetPlanVersion) {
    throw new Error("recovery successor event does not match its recorded intent");
  }
  if (event.phase === "artifact-durable") {
    if (state.status !== "waiting-successor-artifact" || successor.status !== "intent-recorded") {
      throw new Error("recovery successor artifact is out of order");
    }
    return validateRecoveryState({
      ...state,
      status: "waiting-successor-approval",
      successor: {
        ...successor,
        status: "artifact-durable",
        graphHash: event.graphHash,
        planHash: event.planHash,
        graphRef: event.graphRef,
        planRef: event.planRef,
      },
    });
  }
  assertSuccessorArtifactBinding(successor, event);
  if (event.phase === "approved") {
    if (state.status !== "waiting-successor-approval" || successor.status !== "artifact-durable") {
      throw new Error("recovery successor approval is out of order");
    }
    return validateRecoveryState({
      ...state,
      status: "ready-successor-activation",
      successor: {
        ...successor,
        status: "approved",
        approvalHash: event.approvalHash,
        approvalRef: event.approvalRef,
      },
    });
  }
  if (state.status !== "ready-successor-activation" || successor.status !== "approved" ||
      successor.approvalHash !== event.approvalHash || successor.approvalRef !== event.approvalRef) {
    throw new Error("recovery successor activation is not bound to its approval");
  }
  return validateRecoveryState({
    ...state,
    status: "released",
    approvedPlanVersion: successor.targetPlanVersion,
    approvedPlanHash: event.planHash,
    successor: { ...successor, status: "activated" },
  });
}

function applyRecoveryRelease(stateValue: RecoveryState, releaseValue: RecoveryRelease): RecoveryState {
  const state = validateRecoveryState(stateValue);
  const release = validateRecoveryRelease(releaseValue);
  if (release.failureFingerprint !== state.fingerprint) {
    throw new Error("recovery release fingerprint does not match state");
  }
  if (!release.evidenceRef.startsWith(`plan-versions/${state.sourcePlanVersion}/`)) {
    throw new Error("recovery release evidenceRef does not match the failure plan version");
  }
  const expected: Partial<Record<RecoveryStatus, RecoveryRelease["reason"]>> = {
    "waiting-configuration": "configuration-changed",
    "waiting-authorization": "authorization-granted",
    "waiting-policy": "policy-changed",
    "waiting-side-effect-review": "side-effect-reviewed",
  };
  if (expected[state.status] !== release.reason) {
    throw new Error(`recovery release ${release.reason} cannot resume state ${state.status}`);
  }
  return validateRecoveryState({ ...state, status: "released" });
}

export function recoveryRankingTuple(stateValue: RecoveryState): RecoveryRankingTuple {
  const state = validateRecoveryState(stateValue);
  if (state.status === "released" || state.status === "failed") return Object.freeze([0, 0, 0, 0, 0]);
  const available = RECOVERY_LEVELS.filter((level) => !state.consumed.includes(level));
  const effectiveBudget = available.reduce((sum, level) => sum + state.remaining[level], 0);
  const successorSteps = state.successor === undefined ? 0 : ({
    "intent-recorded": 3,
    "artifact-durable": 2,
    approved: 1,
    activated: 0,
  } as const)[state.successor.status];
  return Object.freeze([
    1,
    effectiveBudget,
    available.filter((level) => state.remaining[level] > 0).length,
    successorSteps,
    state.planVersionCeiling - state.approvedPlanVersion,
  ]);
}

function recoveryDecision(
  state: RecoveryState,
  category: FailureCategory,
  level: RecoveryLevel,
  reason: RecoveryReason,
  directiveHash?: string,
): RecoveryDecision {
  const previousLevel = state.consumed.at(-1);
  if (state.consumed.includes(level) || (previousLevel !== undefined && levelRank(level) <= levelRank(previousLevel))) {
    return stopDecision(state, category, "fail", "recovery-level-consumed", directiveHash);
  }
  if (previousLevel !== undefined && levelRank(level) !== levelRank(previousLevel) + 1) {
    return stopDecision(state, category, "fail", "recovery-level-skipped", directiveHash);
  }
  if (state.remaining[level] === 0) {
    return stopDecision(state, category, "fail", `${level}-exhausted`, directiveHash);
  }
  if (level === "replan" && state.approvedPlanVersion >= state.planVersionCeiling) {
    return stopDecision(state, category, "fail", "replan-exhausted", directiveHash);
  }
  return validateRecoveryDecision({
    version: 1,
    failureFingerprint: state.fingerprint,
    observedCategory: state.observedCategory,
    effectiveCategory: category,
    action: level,
    reason,
    topology: level === "replan" ? "successor" : "preserve",
    sourcePlanVersion: state.approvedPlanVersion,
    sourcePlanHash: state.approvedPlanHash,
    targetPlanVersion: level === "replan" ? state.approvedPlanVersion + 1 : state.approvedPlanVersion,
    remainingBefore: state.remaining,
    remainingAfter: consumeBudget(state.remaining, level),
    ...(directiveHash === undefined ? {} : { directiveHash }),
  });
}

function stopDecision(
  state: RecoveryState,
  category: FailureCategory,
  action: "pause" | "fail",
  reason: RecoveryReason,
  directiveHash?: string,
): RecoveryDecision {
  return validateRecoveryDecision({
    version: 1,
    failureFingerprint: state.fingerprint,
    observedCategory: state.observedCategory,
    effectiveCategory: category,
    action,
    reason,
    topology: "preserve",
    sourcePlanVersion: state.approvedPlanVersion,
    sourcePlanHash: state.approvedPlanHash,
    targetPlanVersion: state.approvedPlanVersion,
    remainingBefore: state.remaining,
    remainingAfter: state.remaining,
    ...(directiveHash === undefined ? {} : { directiveHash }),
  });
}

function consumeBudget(budgets: RecoveryBudgets, level: RecoveryLevel): RecoveryBudgets {
  if (budgets[level] <= 0) throw new Error(`recovery ${level} budget is exhausted`);
  return Object.freeze({ ...budgets, [level]: budgets[level] - 1 });
}

function assertSingleBudgetConsumption(
  level: RecoveryLevel,
  before: RecoveryBudgets,
  after: RecoveryBudgets,
): void {
  for (const candidate of RECOVERY_LEVELS) {
    const expected = candidate === level ? before[candidate] - 1 : before[candidate];
    if (before[level] <= 0 || after[candidate] !== expected) {
      throw new Error(`recovery decision ${level} must decrement exactly once and cannot increase budgets`);
    }
  }
}

function assertDecisionSemantics(
  observedCategory: FailureCategory,
  effectiveCategory: FailureCategory,
  action: RecoveryAction,
  reason: RecoveryReason,
): void {
  if (observedCategory !== "unknown" && effectiveCategory !== observedCategory) {
    throw new Error("recovery decision cannot recategorize known failure evidence");
  }

  const valid = (() => {
    if (TRANSIENT_CATEGORIES.has(effectiveCategory)) {
      return (action === "retry" && reason === "transient-failure") ||
        (action === "fail" && isLevelStopReason(reason, "retry-exhausted"));
    }
    if (LOCAL_CATEGORIES.has(effectiveCategory)) {
      return (action === "repair" && reason === "local-defect") ||
        (action === "pause" && reason === "diagnosis-required") ||
        (action === "fail" && isLevelStopReason(reason, "repair-exhausted"));
    }
    if (STRUCTURAL_CATEGORIES.has(effectiveCategory)) {
      return (action === "replan" && reason === "structural-defect") ||
        (action === "pause" && reason === "diagnosis-required") ||
        (action === "fail" && isLevelStopReason(reason, "replan-exhausted"));
    }
    switch (effectiveCategory) {
      case "configuration":
        return action === "pause" && reason === "configuration-change-required";
      case "authorization":
        return action === "pause" && reason === "human-authorization-required";
      case "policy":
        return action === "pause" && reason === "policy-change-required";
      case "side-effect":
        return action === "pause" && reason === "side-effect-review-required";
      case "budget":
        return action === "fail" && reason === "global-budget-exhausted";
      case "unknown":
        return (action === "pause" && reason === "diagnosis-required") ||
          (action === "fail" && reason === "unknown-after-diagnosis");
      default:
        return false;
    }
  })();
  if (!valid) {
    if (isRecoveryLevel(action) && (effectiveCategory === "authorization" || effectiveCategory === "policy" ||
        effectiveCategory === "side-effect" || effectiveCategory === "budget")) {
      throw new Error(`recovery decision ${effectiveCategory} failure cannot recover automatically`);
    }
    throw new Error(`recovery decision action/reason does not match ${effectiveCategory}`);
  }
}

function isLevelStopReason(reason: RecoveryReason, exhaustedReason: RecoveryReason): boolean {
  return reason === exhaustedReason || reason === "recovery-level-consumed" || reason === "recovery-level-skipped";
}

function waitingStatusForReason(reason: RecoveryReason): RecoveryStatus {
  switch (reason) {
    case "diagnosis-required":
      return "waiting-diagnosis";
    case "configuration-change-required":
      return "waiting-configuration";
    case "human-authorization-required":
      return "waiting-authorization";
    case "policy-change-required":
      return "waiting-policy";
    case "side-effect-review-required":
      return "waiting-side-effect-review";
    default:
      throw new Error(`recovery pause reason ${reason} has no explicit waiting state`);
  }
}

function validateRecoverySuccessorState(value: unknown): RecoverySuccessorState {
  const record = requireRecord(value, "recovery successor state");
  if (record.status !== "intent-recorded" && record.status !== "artifact-durable" &&
      record.status !== "approved" && record.status !== "activated") {
    throw new Error("recovery successor state status is invalid");
  }
  const artifactPhase = record.status !== "intent-recorded";
  const approvalPhase = record.status === "approved" || record.status === "activated";
  assertNoUnexpectedFields(record, [
    "status",
    "sourcePlanVersion",
    "targetPlanVersion",
    ...(artifactPhase ? ["graphHash", "planHash", "graphRef", "planRef"] : []),
    ...(approvalPhase ? ["approvalHash", "approvalRef"] : []),
  ], "recovery successor state");
  const sourcePlanVersion = requirePlanVersion(record.sourcePlanVersion, "recovery successor state sourcePlanVersion");
  const targetPlanVersion = requirePlanVersion(record.targetPlanVersion, "recovery successor state targetPlanVersion");
  if (targetPlanVersion !== sourcePlanVersion + 1) {
    throw new Error("recovery successor state target must be the exact successor plan version");
  }
  if (!artifactPhase) return Object.freeze({ status: "intent-recorded", sourcePlanVersion, targetPlanVersion });
  const graphHash = requireHash(record.graphHash, "recovery successor state graphHash");
  const planHash = requireHash(record.planHash, "recovery successor state planHash");
  const graphRef = requirePortablePath(record.graphRef, "recovery successor state graphRef", false);
  const planRef = requirePortablePath(record.planRef, "recovery successor state planRef", false);
  if (graphRef !== `plan-versions/${targetPlanVersion}/graph.json` ||
      planRef !== `plan-versions/${targetPlanVersion}/plan.md`) {
    throw new Error("recovery successor state artifact references do not match the exact target plan version");
  }
  const common = {
    status: record.status,
    sourcePlanVersion,
    targetPlanVersion,
    graphHash,
    planHash,
    graphRef,
    planRef,
  };
  if (!approvalPhase) return Object.freeze(common) as RecoverySuccessorState;
  const approvalHash = requireHash(record.approvalHash, "recovery successor state approvalHash");
  const approvalRef = requirePortablePath(record.approvalRef, "recovery successor state approvalRef", false);
  if (approvalRef !== `plan-versions/${targetPlanVersion}/approval.json`) {
    throw new Error("recovery successor state approvalRef does not match the exact target plan version");
  }
  return Object.freeze({ ...common, approvalHash, approvalRef }) as RecoverySuccessorState;
}

function assertSuccessorArtifactBinding(
  successor: RecoverySuccessorState,
  event: RecoverySuccessorApprovalEvent | RecoverySuccessorActivationEvent,
): void {
  if (successor.graphHash !== event.graphHash || successor.planHash !== event.planHash ||
      successor.graphRef !== event.graphRef || successor.planRef !== event.planRef) {
    throw new Error("recovery successor event does not match its durable artifact binding");
  }
}

function reserveSuccessorNamespace(
  event: RecoverySuccessorEvent,
  fingerprint: string,
  reservations: Map<number, SuccessorNamespaceReservation>,
): void {
  const existing = reservations.get(event.targetPlanVersion);
  if (event.phase === "artifact-durable") {
    if (existing === undefined) {
      reservations.set(event.targetPlanVersion, {
        fingerprint,
        graphHash: event.graphHash,
        planHash: event.planHash,
      });
      return;
    }
    if (existing.fingerprint !== fingerprint || existing.graphHash !== event.graphHash ||
        existing.planHash !== event.planHash) {
      throw new Error(
        `recovery successor namespace plan-versions/${event.targetPlanVersion} is already reserved`,
      );
    }
    return;
  }
  if (existing === undefined || existing.fingerprint !== fingerprint) {
    throw new Error(
      `recovery successor namespace plan-versions/${event.targetPlanVersion} is not reserved by this recovery`,
    );
  }
  if (existing.graphHash !== event.graphHash || existing.planHash !== event.planHash) {
    throw new Error(
      `recovery successor namespace plan-versions/${event.targetPlanVersion} changed its immutable artifact hashes`,
    );
  }
}

function assertFailureMatchesAuthorityBase(failure: FailureEvidence, authority: RecoveryAuthority): void {
  if (failure.runId !== authority.runId || failure.graphDigest !== authority.graphDigest) {
    throw new Error("failure evidence does not match recovery authority run and graph identity");
  }
  if (failure.planVersion > authority.limits.maxPlanVersions) {
    throw new Error("failure evidence plan version exceeds recovery authority limits");
  }
}

function assertDirectiveArtifactBinding(failure: FailureEvidence, directive: RecoveryDirective): void {
  const planPrefix = `plan-versions/${failure.planVersion}/`;
  if (!directive.diagnosisRef.startsWith(planPrefix)) {
    throw new Error("recovery directive diagnosisRef does not match the failure plan version");
  }
  const nodePrefix = `nodes/${failure.planVersion}/`;
  for (const reference of directive.evidenceRefs) {
    if (!reference.startsWith(nodePrefix) && !reference.startsWith(planPrefix)) {
      throw new Error("recovery directive evidenceRef does not match the failure plan version");
    }
  }
}

function assertFailureMatchesCurrentPlan(
  failure: FailureEvidence,
  authority: RecoveryAuthority,
  approvedPlan: ApprovedPlanBinding,
): void {
  assertFailureMatchesAuthorityBase(failure, authority);
  if (failure.planVersion !== approvedPlan.version || failure.planHash !== approvedPlan.hash) {
    throw new Error("failure evidence does not match the current approved plan version and planHash");
  }
}

function assertStateSourceMatchesCurrentPlan(
  state: RecoveryState,
  approvedPlan: ApprovedPlanBinding,
): void {
  if (state.approvedPlanVersion !== approvedPlan.version || state.approvedPlanHash !== approvedPlan.hash) {
    throw new Error("recovery state has a stale source plan and does not match the current approved plan");
  }
}

function currentApprovedPlanBinding(ledger: RecoveryLedger): ApprovedPlanBinding {
  for (let index = ledger.records.length - 1; index >= 0; index -= 1) {
    const record = ledger.records[index]!;
    if (record.kind === "successor" && record.event.phase === "activated") {
      return { version: record.event.targetPlanVersion, hash: record.event.planHash };
    }
  }
  return { version: ledger.genesis.activePlanVersion, hash: ledger.genesis.activePlanHash };
}

function latestLineageState(ledger: RecoveryLedger, budgetKey: string): RecoveryState | undefined {
  for (let index = ledger.records.length - 1; index >= 0; index -= 1) {
    const state = ledger.records[index]!.state;
    if (state.budgetKey === budgetKey) return state;
  }
  return undefined;
}

function requireLedgerEntryLimit(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_LEDGER_ENTRIES) {
    throw new Error(`recovery ledger maxEntries must be an integer from 1 to ${MAX_LEDGER_ENTRIES}`);
  }
  return value as number;
}

function validateLedgerGenesis(value: unknown, authority: RecoveryAuthority): RecoveryLedgerGenesis {
  const record = requireRecord(value, "recovery ledger genesis");
  assertNoUnexpectedFields(record, [
    "version", "runId", "graphDigest", "activePlanVersion", "activePlanHash", "limits", "limitsHash", "genesisHash",
  ], "recovery ledger genesis");
  const embedded = validateRecoveryAuthority({
    version: record.version,
    runId: record.runId,
    graphDigest: record.graphDigest,
    activePlanVersion: record.activePlanVersion,
    activePlanHash: record.activePlanHash,
    limits: record.limits,
  });
  if (canonicalJson(embedded) !== canonicalJson(authority)) {
    throw new Error("recovery ledger genesis does not match authoritative frozen input");
  }
  const limitsHash = requireHash(record.limitsHash, "recovery ledger genesis limitsHash");
  const expectedLimitsHash = sha256(canonicalJson(authority.limits));
  if (limitsHash !== expectedLimitsHash) throw new Error("recovery ledger genesis limits hash is invalid");
  const genesisHash = requireHash(record.genesisHash, "recovery ledger genesis genesisHash");
  const expectedGenesisHash = sha256(canonicalJson({ ...embedded, limitsHash }));
  if (genesisHash !== expectedGenesisHash) throw new Error("recovery ledger genesis hash is invalid");
  return Object.freeze({ ...embedded, limitsHash, genesisHash });
}

function validateLedgerRecord(
  value: unknown,
  expectedSequence: number,
  expectedPreviousHash: string,
  genesis: RecoveryLedgerGenesis,
  approvedPlan: ApprovedPlanBinding,
  successorReservations: Map<number, SuccessorNamespaceReservation>,
  contexts: Map<string, { failure: FailureEvidence; state: RecoveryState; records: number }>,
  lineages: Map<string, RecoveryState>,
): RecoveryLedgerRecord {
  const label = `recovery ledger records[${expectedSequence - 1}]`;
  const record = requireRecord(value, label);
  if (record.kind !== "registration" && record.kind !== "decision" &&
      record.kind !== "successor" && record.kind !== "release") {
    throw new Error(`${label}.kind is invalid`);
  }
  const payloadKeys = record.kind === "registration"
    ? ["failure", "state"]
    : record.kind === "decision"
      ? ["fingerprint", "directive", "decision", "state"]
      : record.kind === "successor"
        ? ["fingerprint", "event", "state"]
        : ["fingerprint", "release", "state"];
  assertNoUnexpectedFields(record, ["kind", "sequence", "previousHash", "hash", ...payloadKeys], label);
  const sequence = requirePositiveInteger(record.sequence, `${label}.sequence`, Number.MAX_SAFE_INTEGER);
  if (sequence !== expectedSequence) throw new Error(`${label}.sequence is not contiguous`);
  const previousHash = requireHash(record.previousHash, `${label}.previousHash`);
  if (previousHash !== expectedPreviousHash) throw new Error(`${label} breaks the append-only hash chain`);
  const hash = requireHash(record.hash, `${label}.hash`);

  let normalized: RecoveryLedgerRecord;
  if (record.kind === "registration") {
    const failure = validateFailureEvidence(record.failure);
    assertFailureMatchesCurrentPlan(failure, genesis, approvedPlan);
    const fingerprint = fingerprintFailure(failure);
    if (contexts.has(fingerprint)) throw new Error(`recovery fingerprint ${fingerprint} is already initialized`);
    const state = validateRecoveryState(record.state);
    const previousLineageState = lineages.get(recoveryBudgetKey(failure));
    const expected = createRecoveryState(failure, genesis, previousLineageState);
    if (!statesEqual(state, expected)) throw new Error(`${label}.state does not match immutable genesis evidence`);
    normalized = Object.freeze({ kind: "registration", sequence, previousHash, hash, failure, state });
    contexts.set(fingerprint, { failure, state, records: 1 });
    lineages.set(state.budgetKey, state);
  } else {
    const fingerprint = requireHash(record.fingerprint, `${label}.fingerprint`);
    const context = contexts.get(fingerprint);
    if (!context) throw new Error(`${label} references an uninitialized recovery fingerprint`);
    if (context.records >= MAX_LEDGER_RECORDS_PER_ENTRY) {
      throw new Error(`recovery fingerprint ${fingerprint} exhausted its immutable history bound`);
    }
    const state = validateRecoveryState(record.state);
    if (record.kind === "decision") {
      assertStateSourceMatchesCurrentPlan(context.state, approvedPlan);
      const directive = record.directive === undefined ? undefined : validateRecoveryDirective(record.directive);
      const decision = validateRecoveryDecision(record.decision);
      const rederived = classifyFailure(context.failure, context.state, directive);
      if (!decisionsEqual(decision, rederived)) {
        throw new Error(`${label}.decision does not match its rederived evidence and diagnosis`);
      }
      const expected = applyRecoveryDecision(context.state, rederived);
      if (!statesEqual(state, expected)) throw new Error(`${label}.state does not match its replayed decision`);
      normalized = Object.freeze({
        kind: "decision",
        sequence,
        previousHash,
        hash,
        fingerprint,
        ...(directive === undefined ? {} : { directive }),
        decision,
        state,
      });
    } else if (record.kind === "successor") {
      assertStateSourceMatchesCurrentPlan(context.state, approvedPlan);
      const event = validateRecoverySuccessorEvent(record.event);
      if (event.failureFingerprint !== fingerprint) throw new Error(`${label}.event fingerprint does not match`);
      reserveSuccessorNamespace(event, fingerprint, successorReservations);
      const expected = applyRecoverySuccessorEvent(context.state, event);
      if (!statesEqual(state, expected)) throw new Error(`${label}.state does not match its successor event`);
      normalized = Object.freeze({ kind: "successor", sequence, previousHash, hash, fingerprint, event, state });
    } else {
      const release = validateRecoveryRelease(record.release);
      if (release.failureFingerprint !== fingerprint) throw new Error(`${label}.release fingerprint does not match`);
      assertStateSourceMatchesCurrentPlan(context.state, approvedPlan);
      const expected = applyRecoveryRelease(context.state, release);
      if (!statesEqual(state, expected)) throw new Error(`${label}.state does not match its release event`);
      normalized = Object.freeze({ kind: "release", sequence, previousHash, hash, fingerprint, release, state });
    }
    context.state = state;
    context.records += 1;
    lineages.set(state.budgetKey, state);
  }
  const expectedHash = recoveryRecordHash(normalized);
  if (hash !== expectedHash) throw new Error(`${label}.hash does not match the append-only hash chain`);
  return normalized;
}

type NewRecoveryLedgerRecord =
  | Omit<RecoveryRegistrationRecord, keyof RecoveryLedgerRecordBase>
  | Omit<RecoveryDecisionRecord, keyof RecoveryLedgerRecordBase>
  | Omit<RecoverySuccessorRecord, keyof RecoveryLedgerRecordBase>
  | Omit<RecoveryReleaseRecord, keyof RecoveryLedgerRecordBase>;

function appendLedgerRecord(
  ledger: RecoveryLedger,
  authority: RecoveryAuthority,
  value: NewRecoveryLedgerRecord,
): RecoveryLedger {
  const common = {
    sequence: ledger.records.length + 1,
    previousHash: ledger.headHash,
  };
  const withoutHash = { ...value, ...common };
  const hash = recoveryRecordHash(withoutHash);
  return validateRecoveryLedger({
    ...ledger,
    records: [...ledger.records, { ...withoutHash, hash }],
    headHash: hash,
  }, authority);
}

function recoveryRecordHash(value: Omit<RecoveryLedgerRecord, "hash"> | RecoveryLedgerRecord | Record<string, unknown>): string {
  const record = value as Record<string, unknown>;
  const payload = record.kind === "registration"
    ? { failure: record.failure, state: record.state }
    : record.kind === "decision"
      ? {
        fingerprint: record.fingerprint,
        directive: record.directive ?? null,
        decision: record.decision,
        state: record.state,
      }
      : record.kind === "successor"
        ? { fingerprint: record.fingerprint, event: record.event, state: record.state }
        : { fingerprint: record.fingerprint, release: record.release, state: record.state };
  return sha256(canonicalJson({
    kind: record.kind,
    sequence: record.sequence,
    previousHash: record.previousHash,
    payload,
  }));
}

function failureForFingerprint(ledger: RecoveryLedger, fingerprint: string): FailureEvidence {
  const registration = ledger.records.find((record) =>
    record.kind === "registration" && record.state.fingerprint === fingerprint);
  if (!registration || registration.kind !== "registration") {
    throw new Error(`recovery fingerprint ${fingerprint} is not initialized`);
  }
  return registration.failure;
}

function currentStateForFingerprint(ledger: RecoveryLedger, fingerprint: string): RecoveryState {
  for (let index = ledger.records.length - 1; index >= 0; index -= 1) {
    const record = ledger.records[index]!;
    const candidate = record.kind === "registration" ? record.state.fingerprint : record.fingerprint;
    if (candidate === fingerprint) return record.state;
  }
  throw new Error(`recovery fingerprint ${fingerprint} is not initialized`);
}

function requireConsumedLevels(value: unknown): readonly RecoveryLevel[] {
  const values = requireExactArray(value, "recovery state consumed", RECOVERY_LEVELS.length);
  const consumed: RecoveryLevel[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (typeof item !== "string" || !RECOVERY_LEVEL_SET.has(item)) {
      throw new Error(`recovery state consumed[${index}] is invalid`);
    }
    const level = item as RecoveryLevel;
    if (consumed.includes(level)) throw new Error(`recovery state consumed repeats ${level}`);
    const previous = consumed.at(-1);
    if (previous !== undefined && levelRank(level) <= levelRank(previous)) {
      throw new Error("recovery state consumed levels must strictly escalate");
    }
    if (previous !== undefined && levelRank(level) !== levelRank(previous) + 1) {
      throw new Error("recovery state consumed levels cannot skip the recovery ladder");
    }
    consumed.push(level);
  }
  return Object.freeze(consumed);
}

function requireBudgets(value: unknown, label: string): Readonly<RecoveryBudgets> {
  const record = requireRecord(value, label);
  assertNoUnexpectedFields(record, RECOVERY_LEVELS, label);
  const result = {} as RecoveryBudgets;
  for (const level of RECOVERY_LEVELS) {
    const candidate = record[level];
    if (candidate !== 0 && candidate !== 1) {
      throw new Error(`${label}.${level} must be 0 or 1`);
    }
    result[level] = candidate as number;
  }
  return Object.freeze(result);
}

function requireUniqueHashes(value: unknown, label: string): readonly string[] {
  const values = requireExactArray(value, label, MAX_REFERENCES);
  const hashes = values.map((candidate, index) => requireHash(candidate, `${label}[${index}]`));
  if (new Set(hashes).size !== hashes.length) throw new Error(`${label} contains a duplicate hash`);
  return Object.freeze([...hashes].sort(compareCodeUnits));
}

function requirePortablePaths(value: unknown, label: string, protectRepository: boolean): readonly string[] {
  const values = requireExactArray(value, label, MAX_REFERENCES);
  const references = values.map((candidate, index) =>
    requirePortablePath(candidate, `${label}[${index}]`, protectRepository));
  if (new Set(references).size !== references.length) throw new Error(`${label} contains a duplicate reference`);
  return Object.freeze([...references].sort(compareCodeUnits));
}

function requireLogicalReferences(value: unknown, label: string): readonly string[] {
  const values = requireExactArray(value, label, MAX_REFERENCES);
  const references = values.map((candidate, index) => {
    if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > MAX_REFERENCE_LENGTH ||
        !METADATA_TOKEN.test(candidate)) {
      throw new Error(`${label}[${index}] must be a bounded canonical logical reference`);
    }
    return candidate;
  });
  if (new Set(references).size !== references.length) throw new Error(`${label} contains a duplicate reference`);
  return Object.freeze([...references].sort(compareCodeUnits));
}

function requirePortablePath(value: unknown, label: string, protectRepository: boolean): string {
  if (typeof value !== "string" || value.length === 0 ||
      Buffer.byteLength(value, "utf8") > MAX_REPOSITORY_PATH_BYTES || value !== value.normalize("NFC") ||
      value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value) || value.includes("\\") ||
      /[\u0000-\u001f\u007f*?\[\]{}]/.test(value)) {
    throw new Error(`${label} must be a contained relative canonical path in the portable subset`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." ||
      !PORTABLE_SEGMENT.test(segment) || segment.endsWith(".") || isWindowsReservedPathSegment(segment))) {
    throw new Error(`${label} must be a contained relative canonical path in the portable subset`);
  }
  if (protectRepository && segments.some((segment) => PROTECTED_REPOSITORY_SEGMENTS.has(segment.toLowerCase()))) {
    throw new Error(`${label} targets a protected repository path`);
  }
  return value;
}

function isWindowsReservedPathSegment(segment: string): boolean {
  const base = segment.split(".", 1)[0]!.toLowerCase();
  return base === "con" || base === "prn" || base === "aux" || base === "nul" ||
    /^com[1-9]$/.test(base) || /^lpt[1-9]$/.test(base);
}

function requireMetadataToken(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TOKEN_LENGTH || !METADATA_TOKEN.test(value)) {
    throw new Error(`${label} must be a bounded canonical metadata token`);
  }
  return value;
}

function requireFailureCategory(value: unknown, label: string): FailureCategory {
  if (typeof value !== "string" || !FAILURE_CATEGORY_SET.has(value)) throw new Error(`${label} is invalid`);
  return value as FailureCategory;
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} must be a lowercase SHA-256 hash`);
  return value;
}

function requirePlanVersion(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_PLAN_VERSION) {
    throw new Error(`${label} must be an integer from 1 to ${MAX_PLAN_VERSION}`);
  }
  return value as number;
}

function requirePositiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from 1 to ${maximum}`);
  }
  return value as number;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object of own data properties`);
  }
  const normalized = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new Error(`${label} must contain only exact string data properties`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error(`${label}.${key} must be an enumerable own data property`);
    }
    normalized[key] = descriptor.value;
  }
  return Object.freeze(normalized);
}

function requireExactArray(value: unknown, label: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be an exact dense array`);
  }
  const length = value.length;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) {
    throw new Error(`${label} must contain at most ${maximum} values`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string") || keys.length !== length + 1 || !keys.includes("length")) {
    throw new Error(`${label} must be an exact dense array without extra properties`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error(`${label} must be an exact dense array of data properties`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function assertNoUnexpectedFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Reflect.ownKeys(value).find((key) => typeof key !== "string" || !allowedSet.has(key));
  if (unexpected !== undefined) throw new Error(`${label} contains unexpected field ${String(unexpected)}`);
}

function budgetsEqual(left: RecoveryBudgets, right: RecoveryBudgets): boolean {
  return RECOVERY_LEVELS.every((level) => left[level] === right[level]);
}

function statesEqual(left: RecoveryState, right: RecoveryState): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function decisionsEqual(left: RecoveryDecision, right: RecoveryDecision): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function levelRank(level: RecoveryLevel): number {
  return RECOVERY_LEVELS.indexOf(level);
}

function isRecoveryLevel(value: RecoveryAction): value is RecoveryLevel {
  return RECOVERY_LEVEL_SET.has(value);
}
