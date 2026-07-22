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
export type RecoveryStatus = "active" | "paused" | "failed";
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
  category: FailureCategory;
  nodeKind: string;
  graphVersion: string;
  contractViolation?: ContractViolation;
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
  fingerprint: string;
  observedCategory: FailureCategory;
  consumed: readonly RecoveryLevel[];
  remaining: Readonly<RecoveryBudgets>;
  sourcePlanVersion: number;
  activePlanVersion: number;
}

export interface RecoveryDirective {
  version: 1;
  failureFingerprint: string;
  rootCauseCategory: FailureCategory;
  confidence: "low" | "medium" | "high";
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
  targetPlanVersion: number;
  remainingBefore: Readonly<RecoveryBudgets>;
  remainingAfter: Readonly<RecoveryBudgets>;
}

export interface RecoveryLedgerEntry {
  fingerprint: string;
  initial: RecoveryState;
  transitions: readonly RecoveryLedgerTransition[];
}

export interface RecoveryLedgerTransition {
  decision: RecoveryDecision;
  state: RecoveryState;
}

export interface RecoveryLedger {
  version: 1;
  maxEntries: number;
  entries: readonly RecoveryLedgerEntry[];
}

export interface CreateRecoveryStateOptions {
  remaining: RecoveryBudgets;
  sourcePlanVersion: number;
}

export type RecoveryRankingTuple = readonly [
  active: number,
  effectiveBudget: number,
  availableLevels: number,
  planVersionCapacity: number,
];

const FAILURE_CATEGORY_SET = new Set<string>(FAILURE_CATEGORIES);
const RECOVERY_LEVEL_SET = new Set<string>(RECOVERY_LEVELS);
const CONTRACT_VIOLATION_SET = new Set<string>(CONTRACT_VIOLATIONS);
const RECOVERY_STATUS_SET = new Set<string>(["active", "paused", "failed"]);
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
const METADATA_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const MAX_TOKEN_LENGTH = 128;
const MAX_REFERENCE_LENGTH = 256;
const MAX_REFERENCES = 32;
const MAX_RECOVERY_BUDGET = 1_000;
const MAX_PLAN_VERSION = 1_000_000;
const DEFAULT_LEDGER_ENTRIES = 256;
const MAX_LEDGER_ENTRIES = 1_024;
const MAX_LEDGER_TRANSITIONS = RECOVERY_LEVELS.length + 1;

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
    "category",
    "nodeKind",
    "graphVersion",
    "contractViolation",
    "artifactHashes",
  ], "failure evidence");
  if (record.version !== 1) throw new Error("failure evidence version must be 1");
  const category = requireFailureCategory(record.category, "failure evidence category");
  const nodeKind = requireMetadataToken(record.nodeKind, "failure evidence nodeKind");
  const graphVersion = requireMetadataToken(record.graphVersion, "failure evidence graphVersion");
  let contractViolation: ContractViolation | undefined;
  if (record.contractViolation !== undefined) {
    if (typeof record.contractViolation !== "string" || !CONTRACT_VIOLATION_SET.has(record.contractViolation)) {
      throw new Error("failure evidence contractViolation is invalid");
    }
    contractViolation = record.contractViolation as ContractViolation;
  }
  const artifactHashes = requireUniqueHashes(record.artifactHashes, "failure evidence artifactHashes");
  return Object.freeze({
    version: 1,
    category,
    nodeKind,
    graphVersion,
    ...(contractViolation === undefined ? {} : { contractViolation }),
    artifactHashes,
  });
}

export function fingerprintFailure(value: FailureEvidence): string {
  const evidence = validateFailureEvidence(value);
  const canonical = JSON.stringify({
    version: evidence.version,
    category: evidence.category,
    nodeKind: evidence.nodeKind,
    graphVersion: evidence.graphVersion,
    contractViolation: evidence.contractViolation ?? null,
    artifactHashes: evidence.artifactHashes,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function createRecoveryState(
  failure: FailureEvidence,
  options: CreateRecoveryStateOptions,
): RecoveryState {
  const evidence = validateFailureEvidence(failure);
  return validateRecoveryState({
    version: 1,
    status: "active",
    fingerprint: fingerprintFailure(evidence),
    observedCategory: evidence.category,
    consumed: [],
    remaining: options.remaining,
    sourcePlanVersion: options.sourcePlanVersion,
    activePlanVersion: options.sourcePlanVersion,
  });
}

export function createRecoveryLedger(maxEntries = DEFAULT_LEDGER_ENTRIES): RecoveryLedger {
  return validateRecoveryLedger({ version: 1, maxEntries, entries: [] });
}

export function validateRecoveryLedger(value: unknown): RecoveryLedger {
  const record = requireRecord(value, "recovery ledger");
  assertNoUnexpectedFields(record, ["version", "maxEntries", "entries"], "recovery ledger");
  if (record.version !== 1) throw new Error("recovery ledger version must be 1");
  const maxEntries = requireLedgerEntryLimit(record.maxEntries);
  const entries = requireLedgerEntries(record.entries, maxEntries);
  return Object.freeze({
    version: 1,
    maxEntries,
    entries,
  });
}

export function registerRecovery(
  ledgerValue: RecoveryLedger,
  failure: FailureEvidence,
  options: CreateRecoveryStateOptions,
): RecoveryLedger {
  const ledger = validateRecoveryLedger(ledgerValue);
  const state = createRecoveryState(failure, options);
  if (ledger.entries.some((entry) => entry.fingerprint === state.fingerprint)) {
    throw new Error(`recovery fingerprint ${state.fingerprint} is already initialized`);
  }
  if (ledger.entries.length >= ledger.maxEntries) throw new Error("recovery ledger entry limit is reached");
  return validateRecoveryLedger({
    ...ledger,
    entries: [...ledger.entries, { fingerprint: state.fingerprint, initial: state, transitions: [] }],
  });
}

export function resumeRecoveryState(ledgerValue: RecoveryLedger, fingerprintValue: string): RecoveryState {
  const ledger = validateRecoveryLedger(ledgerValue);
  const fingerprint = requireHash(fingerprintValue, "recovery resume fingerprint");
  const entry = ledger.entries.find((candidate) => candidate.fingerprint === fingerprint);
  if (!entry) throw new Error(`recovery fingerprint ${fingerprint} is not initialized`);
  return currentLedgerState(entry);
}

export function applyRecoveryDecisionToLedger(
  ledgerValue: RecoveryLedger,
  decisionValue: RecoveryDecision,
): RecoveryLedger {
  const ledger = validateRecoveryLedger(ledgerValue);
  const decision = validateRecoveryDecision(decisionValue);
  const entryIndex = ledger.entries.findIndex((entry) => entry.fingerprint === decision.failureFingerprint);
  if (entryIndex < 0) throw new Error(`recovery fingerprint ${decision.failureFingerprint} is not initialized`);
  const entry = ledger.entries[entryIndex]!;
  const current = currentLedgerState(entry);
  const next = applyRecoveryDecision(current, decision);
  if (statesEqual(current, next)) return ledger;
  if (entry.transitions.length >= MAX_LEDGER_TRANSITIONS) {
    throw new Error(`recovery fingerprint ${entry.fingerprint} exhausted its immutable history bound`);
  }
  const entries = ledger.entries.map((candidate, index) => index === entryIndex
    ? {
      fingerprint: candidate.fingerprint,
      initial: candidate.initial,
      transitions: [...candidate.transitions, { decision, state: next }],
    }
    : candidate);
  return validateRecoveryLedger({ ...ledger, entries });
}

export function validateRecoveryState(value: unknown): RecoveryState {
  const record = requireRecord(value, "recovery state");
  assertNoUnexpectedFields(record, [
    "version",
    "status",
    "fingerprint",
    "observedCategory",
    "consumed",
    "remaining",
    "sourcePlanVersion",
    "activePlanVersion",
  ], "recovery state");
  if (record.version !== 1) throw new Error("recovery state version must be 1");
  if (typeof record.status !== "string" || !RECOVERY_STATUS_SET.has(record.status)) {
    throw new Error("recovery state status is invalid");
  }
  const fingerprint = requireHash(record.fingerprint, "recovery state fingerprint");
  const observedCategory = requireFailureCategory(record.observedCategory, "recovery state observedCategory");
  const consumed = requireConsumedLevels(record.consumed);
  const remaining = requireBudgets(record.remaining, "recovery state remaining");
  const sourcePlanVersion = requirePlanVersion(record.sourcePlanVersion, "recovery state sourcePlanVersion");
  const activePlanVersion = requirePlanVersion(record.activePlanVersion, "recovery state activePlanVersion");
  const expectedActiveVersion = sourcePlanVersion + (consumed.includes("replan") ? 1 : 0);
  if (activePlanVersion !== expectedActiveVersion) {
    throw new Error("recovery state activePlanVersion must equal source plan version plus one consumed replan");
  }
  return Object.freeze({
    version: 1,
    status: record.status as RecoveryStatus,
    fingerprint,
    observedCategory,
    consumed,
    remaining,
    sourcePlanVersion,
    activePlanVersion,
  });
}

export function validateRecoveryDirective(value: unknown): RecoveryDirective {
  const record = requireRecord(value, "recovery directive");
  assertNoUnexpectedFields(record, [
    "version",
    "failureFingerprint",
    "rootCauseCategory",
    "confidence",
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
  const diagnosisHash = requireHash(record.diagnosisHash, "recovery directive diagnosisHash");
  const evidenceRefs = requireReferences(record.evidenceRefs, "recovery directive evidenceRefs");
  const repairScope = requireReferences(record.repairScope, "recovery directive repairScope");
  const validationRequirements = requireReferences(
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
  if (!STRUCTURAL_CATEGORIES.has(rootCauseCategory) && topologyAssessment === "structural") {
    throw new Error("recovery directive structural topology requires a structural root cause");
  }

  return Object.freeze({
    version: 1,
    failureFingerprint,
    rootCauseCategory,
    confidence: record.confidence as RecoveryDirective["confidence"],
    diagnosisHash,
    evidenceRefs,
    repairScope,
    validationRequirements,
    topologyAssessment,
  });
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
    "targetPlanVersion",
    "remainingBefore",
    "remainingAfter",
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
  const targetPlanVersion = requirePlanVersion(record.targetPlanVersion, "recovery decision targetPlanVersion");
  const remainingBefore = requireBudgets(record.remainingBefore, "recovery decision remainingBefore");
  const remainingAfter = requireBudgets(record.remainingAfter, "recovery decision remainingAfter");
  const action = record.action as RecoveryAction;
  const reason = record.reason as RecoveryReason;
  assertDecisionSemantics(observedCategory, effectiveCategory, action, reason);

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
    targetPlanVersion,
    remainingBefore,
    remainingAfter,
  });
}

export function classifyFailure(
  failureValue: FailureEvidence,
  stateValue: RecoveryState,
  directiveValue?: RecoveryDirective,
): RecoveryDecision {
  const failure = validateFailureEvidence(failureValue);
  const state = validateRecoveryState(stateValue);
  if (state.status !== "active") throw new Error("cannot classify failure from a terminal recovery state");
  const fingerprint = fingerprintFailure(failure);
  if (fingerprint !== state.fingerprint || failure.category !== state.observedCategory) {
    throw new Error("failure evidence does not match the recovery state fingerprint");
  }

  const directive = directiveValue === undefined ? undefined : validateRecoveryDirective(directiveValue);
  if (directive && directive.failureFingerprint !== fingerprint) {
    throw new Error("recovery directive fingerprint does not match failure evidence");
  }
  if (directive && failure.category !== "unknown" && directive.rootCauseCategory !== failure.category) {
    throw new Error("recovery directive cannot recategorize known failure evidence");
  }

  const category = directive?.rootCauseCategory ?? failure.category;
  if (category === "budget") return stopDecision(state, category, "fail", "global-budget-exhausted");
  if (category === "configuration") {
    return stopDecision(state, category, "pause", "configuration-change-required");
  }
  if (category === "authorization") {
    return stopDecision(state, category, "pause", "human-authorization-required");
  }
  if (category === "policy") return stopDecision(state, category, "pause", "policy-change-required");
  if (category === "side-effect") {
    return stopDecision(state, category, "pause", "side-effect-review-required");
  }
  if ((LOCAL_CATEGORIES.has(category) || STRUCTURAL_CATEGORIES.has(category) || category === "unknown") && !directive) {
    return stopDecision(state, category, "pause", "diagnosis-required");
  }
  if (category === "unknown") return stopDecision(state, category, "fail", "unknown-after-diagnosis");

  if (TRANSIENT_CATEGORIES.has(category)) {
    return recoveryDecision(state, category, "retry", "transient-failure");
  }
  if (LOCAL_CATEGORIES.has(category)) {
    return recoveryDecision(state, category, "repair", "local-defect");
  }
  if (STRUCTURAL_CATEGORIES.has(category)) {
    return recoveryDecision(state, category, "replan", "structural-defect");
  }
  throw new Error(`Unhandled failure category: ${category}`);
}

export function applyRecoveryDecision(
  stateValue: RecoveryState,
  decisionValue: RecoveryDecision,
): RecoveryState {
  const state = validateRecoveryState(stateValue);
  const decision = validateRecoveryDecision(decisionValue);
  if (state.status !== "active") return state;
  if (decision.failureFingerprint !== state.fingerprint) {
    throw new Error("recovery decision fingerprint does not match recovery state fingerprint");
  }
  if (decision.observedCategory !== state.observedCategory) {
    throw new Error("recovery decision observed category does not match recovery state");
  }
  if (!budgetsEqual(decision.remainingBefore, state.remaining)) {
    throw new Error("recovery decision has a stale remaining budget snapshot");
  }
  if (decision.sourcePlanVersion !== state.activePlanVersion) {
    throw new Error("recovery decision has a stale source plan version");
  }

  if (!isRecoveryLevel(decision.action)) {
    return validateRecoveryState({
      ...state,
      status: decision.action === "pause" ? "paused" : "failed",
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
  const expectedTarget = decision.action === "replan" ? state.activePlanVersion + 1 : state.activePlanVersion;
  if (decision.targetPlanVersion !== expectedTarget) {
    throw new Error("recovery decision target plan version does not match state transition");
  }

  return validateRecoveryState({
    ...state,
    consumed: [...state.consumed, decision.action],
    remaining: decision.remainingAfter,
    activePlanVersion: decision.targetPlanVersion,
  });
}

export function recoveryRankingTuple(stateValue: RecoveryState): RecoveryRankingTuple {
  const state = validateRecoveryState(stateValue);
  if (state.status !== "active") return Object.freeze([0, 0, 0, 0]);
  const available = RECOVERY_LEVELS.filter((level) => !state.consumed.includes(level));
  const effectiveBudget = available.reduce((sum, level) => sum + state.remaining[level], 0);
  return Object.freeze([
    1,
    effectiveBudget,
    available.filter((level) => state.remaining[level] > 0).length,
    MAX_PLAN_VERSION - state.activePlanVersion,
  ]);
}

function recoveryDecision(
  state: RecoveryState,
  category: FailureCategory,
  level: RecoveryLevel,
  reason: RecoveryReason,
): RecoveryDecision {
  const previousLevel = state.consumed.at(-1);
  if (state.consumed.includes(level) || (previousLevel !== undefined && levelRank(level) <= levelRank(previousLevel))) {
    return stopDecision(state, category, "fail", "recovery-level-consumed");
  }
  if (previousLevel !== undefined && levelRank(level) !== levelRank(previousLevel) + 1) {
    return stopDecision(state, category, "fail", "recovery-level-skipped");
  }
  if (state.remaining[level] === 0) {
    return stopDecision(state, category, "fail", `${level}-exhausted`);
  }
  if (level === "replan" && state.activePlanVersion >= MAX_PLAN_VERSION) {
    return stopDecision(state, category, "fail", "replan-exhausted");
  }
  return validateRecoveryDecision({
    version: 1,
    failureFingerprint: state.fingerprint,
    observedCategory: state.observedCategory,
    effectiveCategory: category,
    action: level,
    reason,
    topology: level === "replan" ? "successor" : "preserve",
    sourcePlanVersion: state.activePlanVersion,
    targetPlanVersion: level === "replan" ? state.activePlanVersion + 1 : state.activePlanVersion,
    remainingBefore: state.remaining,
    remainingAfter: consumeBudget(state.remaining, level),
  });
}

function stopDecision(
  state: RecoveryState,
  category: FailureCategory,
  action: "pause" | "fail",
  reason: RecoveryReason,
): RecoveryDecision {
  return validateRecoveryDecision({
    version: 1,
    failureFingerprint: state.fingerprint,
    observedCategory: state.observedCategory,
    effectiveCategory: category,
    action,
    reason,
    topology: "preserve",
    sourcePlanVersion: state.activePlanVersion,
    targetPlanVersion: state.activePlanVersion,
    remainingBefore: state.remaining,
    remainingAfter: state.remaining,
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

function requireLedgerEntryLimit(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_LEDGER_ENTRIES) {
    throw new Error(`recovery ledger maxEntries must be an integer from 1 to ${MAX_LEDGER_ENTRIES}`);
  }
  return value as number;
}

function requireLedgerEntries(value: unknown, maxEntries: number): readonly RecoveryLedgerEntry[] {
  if (!Array.isArray(value)) throw new Error("recovery ledger entries must be an array");
  if (value.length > maxEntries) throw new Error("recovery ledger exceeds its entry limit");
  const entries = value.map(validateLedgerEntry).sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]!.fingerprint === entries[index]!.fingerprint) {
      throw new Error(`recovery ledger fingerprint ${entries[index]!.fingerprint} is already initialized`);
    }
  }
  return Object.freeze(entries);
}

function validateLedgerEntry(value: unknown, entryIndex: number): RecoveryLedgerEntry {
  const label = `recovery ledger entries[${entryIndex}]`;
  const entry = requireRecord(value, label);
  assertNoUnexpectedFields(entry, ["fingerprint", "initial", "transitions"], label);
  const fingerprint = requireHash(entry.fingerprint, `${label}.fingerprint`);
  const initial = validateRecoveryState(entry.initial);
  if (initial.fingerprint !== fingerprint) throw new Error(`${label}.initial fingerprint does not match`);
  if (initial.status !== "active" || initial.consumed.length !== 0 ||
      initial.activePlanVersion !== initial.sourcePlanVersion) {
    throw new Error(`${label} must begin with an unconsumed active state`);
  }
  const transitions = requireLedgerTransitions(entry.transitions, initial, fingerprint, entryIndex);
  return Object.freeze({ fingerprint, initial, transitions });
}

function requireLedgerTransitions(
  value: unknown,
  initial: RecoveryState,
  fingerprint: string,
  entryIndex: number,
): readonly RecoveryLedgerTransition[] {
  if (!Array.isArray(value) || value.length > MAX_LEDGER_TRANSITIONS) {
    throw new Error(
      `recovery ledger entries[${entryIndex}].transitions must contain at most ${MAX_LEDGER_TRANSITIONS} transitions`,
    );
  }
  const transitions: RecoveryLedgerTransition[] = [];
  let current = initial;
  for (let index = 0; index < value.length; index += 1) {
    const transition = validateLedgerTransition(value[index], current, fingerprint, entryIndex, index);
    transitions.push(transition);
    current = transition.state;
  }
  return Object.freeze(transitions);
}

function validateLedgerTransition(
  value: unknown,
  current: RecoveryState,
  fingerprint: string,
  entryIndex: number,
  transitionIndex: number,
): RecoveryLedgerTransition {
  const label = `recovery ledger entries[${entryIndex}].transitions[${transitionIndex}]`;
  if (current.status !== "active") throw new Error(`${label} cannot follow a terminal recovery state`);
  const record = requireRecord(value, label);
  assertNoUnexpectedFields(record, ["decision", "state"], label);
  const decision = validateRecoveryDecision(record.decision);
  if (decision.failureFingerprint !== fingerprint) throw new Error(`${label}.decision fingerprint does not match`);
  const state = validateRecoveryState(record.state);
  const expected = applyRecoveryDecision(current, decision);
  if (!statesEqual(state, expected)) throw new Error(`${label}.state does not match its replayed decision`);
  return Object.freeze({ decision, state });
}

function currentLedgerState(entry: RecoveryLedgerEntry): RecoveryState {
  return entry.transitions.at(-1)?.state ?? entry.initial;
}

function requireConsumedLevels(value: unknown): readonly RecoveryLevel[] {
  if (!Array.isArray(value)) throw new Error("recovery state consumed must be an array");
  if (value.length > RECOVERY_LEVELS.length) throw new Error("recovery state consumed has too many levels");
  const consumed: RecoveryLevel[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
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
    if (!Number.isSafeInteger(candidate) || (candidate as number) < 0 || (candidate as number) > MAX_RECOVERY_BUDGET) {
      throw new Error(`${label}.${level} must be an integer from 0 to ${MAX_RECOVERY_BUDGET}`);
    }
    result[level] = candidate as number;
  }
  return Object.freeze(result);
}

function requireUniqueHashes(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > MAX_REFERENCES) throw new Error(`${label} must contain at most ${MAX_REFERENCES} hashes`);
  const hashes = value.map((candidate, index) => requireHash(candidate, `${label}[${index}]`));
  if (new Set(hashes).size !== hashes.length) throw new Error(`${label} contains a duplicate hash`);
  return Object.freeze([...hashes].sort());
}

function requireReferences(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > MAX_REFERENCES) throw new Error(`${label} must contain at most ${MAX_REFERENCES} references`);
  const references = value.map((candidate, index) => requireReference(candidate, `${label}[${index}]`));
  if (new Set(references).size !== references.length) throw new Error(`${label} contains a duplicate reference`);
  return Object.freeze([...references].sort());
}

function requireReference(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_REFERENCE_LENGTH ||
      value.startsWith("/") || value.includes("\\") || value.includes("\0")) {
    throw new Error(`${label} must be a bounded relative reference`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." ||
      !METADATA_TOKEN.test(segment) || segment.length > MAX_TOKEN_LENGTH)) {
    throw new Error(`${label} must be a canonical contained reference`);
  }
  return value;
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

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function assertNoUnexpectedFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unexpected !== undefined) throw new Error(`${label} contains unexpected field ${unexpected}`);
}

function budgetsEqual(left: RecoveryBudgets, right: RecoveryBudgets): boolean {
  return RECOVERY_LEVELS.every((level) => left[level] === right[level]);
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function statesEqual(left: RecoveryState, right: RecoveryState): boolean {
  return left.version === right.version && left.status === right.status && left.fingerprint === right.fingerprint &&
    left.observedCategory === right.observedCategory && arraysEqual(left.consumed, right.consumed) &&
    budgetsEqual(left.remaining, right.remaining) && left.sourcePlanVersion === right.sourcePlanVersion &&
    left.activePlanVersion === right.activePlanVersion;
}

function levelRank(level: RecoveryLevel): number {
  return RECOVERY_LEVELS.indexOf(level);
}

function isRecoveryLevel(value: RecoveryAction): value is RecoveryLevel {
  return RECOVERY_LEVEL_SET.has(value);
}
