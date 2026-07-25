import { createHash } from "node:crypto";
import type { ExecutionTaskCategory } from "./executionRouting.js";

export type GraphEngineGroup = "G0" | "G1" | "G2" | "G3" | "G4" | "G5" | "G6";
export type GraphTaskCategory = ExecutionTaskCategory;
export type GraphEvidenceStage = "define" | "plan" | "build" | "verify" | "review" | "debug" | "ship" | "fast-judge" | "integrate";
export type GraphValidatorType = "structured-tool" | "schema" | "tests" | "typecheck" | "lint" | "build" | "security" | "human-gate";
export type GraphStageStatus = "succeeded" | "failed" | "skipped" | "cancelled" | "paused";
export type GraphContractStatus = "passed" | "failed" | "skipped" | "unknown";
export type GraphRecoveryLevel = "none" | "retry" | "diagnose" | "repair" | "replan" | "pause" | "fail";
export type GraphFinalStatus = "done" | "failed" | "cancelled" | "paused";
export type GraphTraceCompleteness = "complete" | "partial" | "missing";
export type GraphParallelismMode = "none" | "read-only" | "isolated-writes";
export type GraphEvidenceNumber = number | "unknown";
export type GraphRolloutDecision = "keep-graph-shadow" | "enable-sequential-graph" | "enable-graph-dag";
export type GraphRolloutDecisionReason =
  | "evidence-incomplete"
  | "sequential-regression"
  | "typed-recovery-unobserved"
  | "dag-regression"
  | "useful-isolated-parallelism-unobserved"
  | "sequential-non-inferior"
  | "dag-non-inferior";

export interface GraphEvidenceUsage {
  inputTokens: GraphEvidenceNumber;
  outputTokens: GraphEvidenceNumber;
  cacheReadTokens: GraphEvidenceNumber;
  cacheWriteTokens: GraphEvidenceNumber;
}

export interface GraphEvidenceCost {
  estimatedUsd: GraphEvidenceNumber;
  observedUsd: GraphEvidenceNumber;
}

export interface GraphPlanTransitionEvidence {
  sourcePlanVersion: number;
  targetPlanVersion: number;
  graphDigest: string;
  planDigest: string;
  approvalDigest: string;
  recoveryLedgerDigest: string;
}

export interface GraphPlanActivationIdentity {
  runId: string;
  corpusCaseId: string;
  corpusSnapshotDigest: string;
  eventId: string;
  nodeId: string;
  sequence: number;
  transition: GraphPlanTransitionEvidence;
}

export interface GraphExecutionReceiptIdentity {
  runId: string;
  corpusCaseId: string;
  corpusSnapshotDigest: string;
  eventId: string;
  nodeId: string;
  sequence: number;
  attempt: number;
  stage: GraphEvidenceStage;
  startedAt: string;
  completedAt: string;
  baseRevisionDigest?: string;
  writeSetDigest?: string;
  worktreeReceiptDigest?: string;
  schedulerReceiptDigest?: string;
}

export interface GraphDisjointnessReceiptIdentity {
  runId: string;
  corpusCaseId: string;
  corpusSnapshotDigest: string;
  baseRevisionDigest: string;
  executions: readonly GraphExecutionReceiptIdentity[];
}

export interface GraphStageExecutionWindow {
  startedAt: string;
  completedAt: string;
  /** Digest of the scheduler-authored execution receipt for this exact attempt. */
  schedulerReceiptDigest: string;
  /** Present together for BUILD/INTEGRATE attempts executed in isolated worktrees. */
  worktreeReceiptDigest?: string;
  baseRevisionDigest?: string;
  writeSetDigest?: string;
  disjointnessReceiptDigest?: string;
}

interface GraphEvidenceBase {
  schemaVersion: 1;
  /** Canonical SHA-256 digest or UUID; never a task, path, or provider label. */
  eventId: string;
  runId: string;
  /** Stable opaque identity shared by the same sanitized corpus case across ablation groups. */
  corpusCaseId: string;
  /** Trusted experiment manifest and exact sanitized fixture/config bindings. */
  experimentId: string;
  corpusSnapshotDigest: string;
  engineConfigurationDigest: string;
  sequence: number;
  recordedAt: string;
  engineGroup: GraphEngineGroup;
  taskCategory: GraphTaskCategory;
  graphVersion: string;
  planVersion: number;
}

export interface GraphStageEvidenceEvent extends GraphEvidenceBase {
  type: "stage";
  stage: GraphEvidenceStage;
  nodeId: string;
  attempt: number;
  status: GraphStageStatus;
  contractStatus: GraphContractStatus;
  validatorTypes: GraphValidatorType[];
  readySetWidth: number;
  retryCount: number;
  fallbackCount: number;
  recoveryLevel: GraphRecoveryLevel;
  /** Exact immutable Plan 0016 successor/approval bindings, present only on an N -> N+1 plan stage. */
  planTransition?: GraphPlanTransitionEvidence;
  /** Composite digest of the active transition, repeated by every stage in the successor plan. */
  planActivationDigest?: string;
  /** Scheduler-authored interval used to reproduce observed concurrency. */
  executionWindow?: GraphStageExecutionWindow;
  durationMs: GraphEvidenceNumber;
  usage: GraphEvidenceUsage;
  cost: GraphEvidenceCost;
  failureLocalizationMs: GraphEvidenceNumber;
}

export interface GraphParallelismEvidence {
  mode: GraphParallelismMode;
  executedConcurrently: boolean;
  summedNodeDurationMs: GraphEvidenceNumber;
  criticalPathDurationMs: GraphEvidenceNumber;
  failedNodeCount: number;
  skippedNodeCount: number;
  conflictingNodeCount: number;
}

export interface GraphRunEvidenceEvent extends GraphEvidenceBase {
  type: "run";
  finalStatus: GraphFinalStatus;
  traceCompleteness: GraphTraceCompleteness;
  nodeCount: number;
  nodeExecutions: number;
  redundantNodeExecutions: number;
  maxReadySetWidth: number;
  validatorTypes: GraphValidatorType[];
  contractChecks: { passed: number; failed: number; skipped: number };
  retryCount: number;
  fallbackCount: number;
  recoveryLevel: GraphRecoveryLevel;
  /** Number of recovery-bearing stage executions reproduced by a complete trace. */
  recoveryAttempts: number;
  /** Recovery-bearing stage executions that succeeded and passed their contract. */
  recoverySuccesses: number;
  buildPasses: number;
  firstPassVerification: boolean | "unknown";
  laterRejection: boolean;
  humanOverride: boolean;
  durationMs: GraphEvidenceNumber;
  usage: GraphEvidenceUsage;
  cost: GraphEvidenceCost;
  failureLocalizationMs: GraphEvidenceNumber;
  parallelism: GraphParallelismEvidence;
}

export type GraphEvidenceEvent = GraphStageEvidenceEvent | GraphRunEvidenceEvent;

export type GraphEvidenceValidationError =
  | "not-object"
  | "unexpected-field"
  | "unsupported-version"
  | "invalid-token"
  | "invalid-time"
  | "invalid-enum"
  | "invalid-number"
  | "invalid-boolean"
  | "unbounded-array"
  | "duplicate-array-value"
  | "inconsistent-metrics";

export type GraphEvidenceValidation =
  | { ok: true; event: GraphEvidenceEvent }
  | { ok: false; error: GraphEvidenceValidationError };

export interface KnownUnknownTotal {
  total: number;
  knownSamples: number;
  unknownSamples: number;
}

export interface GraphEvidenceAggregate {
  runCount: number;
  successCount: number;
  successRateBasisPoints: number | "unknown";
  finalStatuses: Record<GraphFinalStatus, number>;
  contractChecks: {
    passed: number;
    failed: number;
    skipped: number;
    satisfactionRateBasisPoints: number | "unknown";
  };
  wallTimeMs: KnownUnknownTotal;
  failureLocalizationMs: KnownUnknownTotal;
  inputTokens: KnownUnknownTotal;
  outputTokens: KnownUnknownTotal;
  cacheReadTokens: KnownUnknownTotal;
  cacheWriteTokens: KnownUnknownTotal;
  estimatedCostUsd: KnownUnknownTotal;
  observedCostUsd: KnownUnknownTotal;
  redundantNodeExecutions: number;
  failedNodeExecutions: number;
  skippedNodeExecutions: number;
  conflictingNodeExecutions: number;
  retryCount: number;
  fallbackCount: number;
  buildPasses: number;
  maxReadySetWidth: number;
  laterRejectionRuns: number;
  humanOverrideRuns: number;
  firstPassVerification: {
    successes: number;
    knownSamples: number;
    rateBasisPoints: number | "unknown";
  };
  recovery: {
    successes: number;
    attempts: number;
    successRateBasisPoints: number | "unknown";
  };
  graphVersions: Record<string, number>;
  planVersions: Record<string, number>;
  recoveryLevels: Record<GraphRecoveryLevel, number>;
  traceStatuses: Record<GraphTraceCompleteness, number>;
  validatorTypes: Partial<Record<GraphValidatorType, number>>;
  failureLoopRuns: number;
  failureLoopRateBasisPoints: number | "unknown";
  completeTraceRuns: number;
  completeTraceRateBasisPoints: number | "unknown";
  usefulParallelism: {
    usefulRuns: number;
    eligibleRuns: number;
    observedCriticalPathSavingsMs: number;
  };
}

export interface GraphEvidenceCohortReport extends GraphEvidenceAggregate {
  engineGroup: GraphEngineGroup;
  taskCategory: GraphTaskCategory;
}

export type GraphEvidenceLimitation =
  | "no-counterfactual-quality-claim"
  | "paid-provider-evidence-not-attested"
  | "unverified-experiment-provenance"
  | "insufficient-cohort-samples"
  | "incomplete-engine-group-coverage"
  | "incomplete-task-category-coverage"
  | "incomplete-ablation-matrix"
  | "insufficient-distinct-corpus-cases"
  | "unpaired-baseline-corpus"
  | "incomplete-run-summaries"
  | "partial-traces"
  | "unknown-usage"
  | "unknown-cost";

export interface GraphEvidenceReport {
  schemaVersion: 1;
  qualityClaim: "observed-executions-only";
  /** Structural completeness is reported separately from the evidence-derived recommendation. */
  evidenceComplete: boolean;
  recommendedDecision: GraphRolloutDecision;
  decisionReasons: GraphRolloutDecisionReason[];
  /** True only when complete evidence supports a positive graph rollout recommendation. */
  rolloutDecisionEligible: boolean;
  eventCount: number;
  stageEventCount: number;
  runCount: number;
  totals: GraphEvidenceAggregate;
  cohorts: GraphEvidenceCohortReport[];
  limitations: GraphEvidenceLimitation[];
}

export interface GraphEvidenceReportOptions {
  /** May raise the hard ten-run cohort floor, never lower it. */
  minimumCohortRuns?: number;
  /** Compiled by trusted local corpus configuration, never repository data. */
  experimentManifest?: GraphExperimentManifest;
}

export interface GraphEngineFeatureVector {
  graphDeclarations: boolean;
  activeOuterGraph: boolean;
  durableScheduler: boolean;
  immutableBuildDag: boolean;
  typedRecovery: boolean;
  isolatedParallelBuild: boolean;
}

export interface GraphExperimentEngine {
  engineGroup: GraphEngineGroup;
  graphVersion: string;
  configurationDigest: string;
  features: Readonly<GraphEngineFeatureVector>;
}

export interface GraphExperimentCase {
  corpusCaseId: string;
  taskCategory: GraphTaskCategory;
  snapshotDigest: string;
}

export interface GraphExperimentManifest {
  schemaVersion: 1;
  experimentId: string;
  releaseVersion: string;
  corpusSnapshotDigest: string;
  engines: readonly Readonly<GraphExperimentEngine>[];
  cases: readonly Readonly<GraphExperimentCase>[];
}

export type GraphExperimentManifestInput = Omit<
  GraphExperimentManifest,
  "experimentId" | "corpusSnapshotDigest"
> & {
  /** Optional assertion; when present it must equal the digest derived from the canonical case list. */
  corpusSnapshotDigest?: string;
};

type NormalizedGraphExperimentManifestInput = Omit<GraphExperimentManifest, "experimentId">;

export type GraphEvidenceErrorCode =
  | "invalid-event"
  | "too-many-events"
  | "duplicate-event-id"
  | "duplicate-sequence"
  | "duplicate-run-summary"
  | "inconsistent-run-identity"
  | "inconsistent-run-trace"
  | "run-summary-not-terminal"
  | "aggregate-overflow"
  | "invalid-report-options"
  | "invalid-experiment-manifest"
  | "inconsistent-experiment-evidence"
  | "invalid-retirement-evidence";

export class GraphEvidenceError extends Error {
  readonly code: GraphEvidenceErrorCode;

  constructor(code: GraphEvidenceErrorCode) {
    super(`Graph evidence failed: ${code}`);
    this.name = "GraphEvidenceError";
    this.code = code;
  }
}

export interface ReleaseBoundEvidenceReference {
  releaseVersion: string;
  artifactDigest: string;
}

export interface RolloutReportEvidenceReference extends ReleaseBoundEvidenceReference {
  decision: GraphRolloutDecision;
}

export interface LegacyRetirementEvidence {
  releasedCompatibilityWindows: number;
  /** Must be supplied only by trusted user/release storage, never repository configuration. */
  evidenceSource?: "trusted-release-record";
  rolloutReport?: RolloutReportEvidenceReference;
  graphCoverage?: ReleaseBoundEvidenceReference;
  cleanRollback?: ReleaseBoundEvidenceReference;
  configMigration?: ReleaseBoundEvidenceReference;
}

export type LegacyRetirementRequirement =
  | "released-compatibility-window"
  | "trusted-release-evidence"
  | "verified-release-artifacts"
  | "decision-ready-rollout-report"
  | "consistent-release-binding"
  | "graph-coverage"
  | "clean-rollback"
  | "config-migration";

export interface LegacyRetirementAssessment {
  eligible: boolean;
  missing: LegacyRetirementRequirement[];
}

const ENGINE_GROUPS: readonly GraphEngineGroup[] = ["G0", "G1", "G2", "G3", "G4", "G5", "G6"];
const SEQUENTIAL_ROLLOUT_GROUPS: readonly GraphEngineGroup[] = ["G1", "G2", "G3", "G4", "G5"];
const TASK_CATEGORIES: readonly GraphTaskCategory[] = [
  "small-fix",
  "multi-file-feature",
  "test-failure",
  "refactor",
  "persistence-change",
  "security-sensitive",
  "read-only-analysis",
  "conflicting-writes",
];
const REQUIRED_VALIDATORS_BY_CATEGORY: Readonly<Record<GraphTaskCategory, readonly GraphValidatorType[]>> = {
  "small-fix": ["tests"],
  "multi-file-feature": ["tests"],
  "test-failure": ["tests"],
  refactor: ["tests"],
  "persistence-change": ["tests"],
  "security-sensitive": ["tests", "security"],
  "read-only-analysis": ["structured-tool"],
  "conflicting-writes": ["tests"],
};
const REPRESENTATIVE_PARALLEL_TASK_CATEGORIES: readonly GraphTaskCategory[] = [
  "multi-file-feature",
  "refactor",
  "persistence-change",
  "security-sensitive",
];
const STAGES: readonly GraphEvidenceStage[] = ["define", "plan", "build", "verify", "review", "debug", "ship", "fast-judge", "integrate"];
const VALIDATORS: readonly GraphValidatorType[] = ["structured-tool", "schema", "tests", "typecheck", "lint", "build", "security", "human-gate"];
const STAGE_STATUSES: readonly GraphStageStatus[] = ["succeeded", "failed", "skipped", "cancelled", "paused"];
const CONTRACT_STATUSES: readonly GraphContractStatus[] = ["passed", "failed", "skipped", "unknown"];
const RECOVERY_LEVELS: readonly GraphRecoveryLevel[] = ["none", "retry", "diagnose", "repair", "replan", "pause", "fail"];
const FINAL_STATUSES: readonly GraphFinalStatus[] = ["done", "failed", "cancelled", "paused"];
const TRACE_COMPLETENESS: readonly GraphTraceCompleteness[] = ["complete", "partial", "missing"];
const PARALLELISM_MODES: readonly GraphParallelismMode[] = ["none", "read-only", "isolated-writes"];
const SHA256_IDENTIFIER = /^[0-9a-f]{64}$/;
const UUID_IDENTIFIER = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const MAX_COUNT = 1_000_000;
const MAX_DURATION_MS = 31_536_000_000;
const MAX_TOKENS = 1_000_000_000_000;
const MAX_USD = 90_000_000;
const MAX_EVENTS = 100_000;
const MAX_VERSION_LENGTH = 128;
const MAX_TIMESTAMP_LENGTH = 64;
const DECIMAL_SCALE = 100_000_000;

export const GRAPH_ENGINE_GROUP_DESCRIPTIONS: Readonly<Record<GraphEngineGroup, string>> = Object.freeze({
  G0: "legacy-loop",
  G1: "graph-declarations-shadow",
  G2: "outer-graph-sequential-build",
  G3: "durable-scheduler-checkpoints",
  G4: "immutable-build-dag-sequential-writes",
  G5: "typed-recovery-and-replan",
  G6: "worktree-isolated-parallel-build",
});

export const GRAPH_ENGINE_FEATURES: Readonly<Record<GraphEngineGroup, Readonly<GraphEngineFeatureVector>>> = Object.freeze({
  G0: Object.freeze({ graphDeclarations: false, activeOuterGraph: false, durableScheduler: false, immutableBuildDag: false, typedRecovery: false, isolatedParallelBuild: false }),
  G1: Object.freeze({ graphDeclarations: true, activeOuterGraph: false, durableScheduler: false, immutableBuildDag: false, typedRecovery: false, isolatedParallelBuild: false }),
  G2: Object.freeze({ graphDeclarations: true, activeOuterGraph: true, durableScheduler: false, immutableBuildDag: false, typedRecovery: false, isolatedParallelBuild: false }),
  G3: Object.freeze({ graphDeclarations: true, activeOuterGraph: true, durableScheduler: true, immutableBuildDag: false, typedRecovery: false, isolatedParallelBuild: false }),
  G4: Object.freeze({ graphDeclarations: true, activeOuterGraph: true, durableScheduler: true, immutableBuildDag: true, typedRecovery: false, isolatedParallelBuild: false }),
  G5: Object.freeze({ graphDeclarations: true, activeOuterGraph: true, durableScheduler: true, immutableBuildDag: true, typedRecovery: true, isolatedParallelBuild: false }),
  G6: Object.freeze({ graphDeclarations: true, activeOuterGraph: true, durableScheduler: true, immutableBuildDag: true, typedRecovery: true, isolatedParallelBuild: true }),
});

class EventValidationFailure extends Error {
  readonly code: GraphEvidenceValidationError;

  constructor(code: GraphEvidenceValidationError) {
    super(code);
    this.code = code;
  }
}

export function validateGraphEvidenceEvent(value: unknown): GraphEvidenceValidation {
  try {
    const event = validateEvent(value);
    return { ok: true, event };
  } catch (error) {
    if (error instanceof EventValidationFailure) return { ok: false, error: error.code };
    return { ok: false, error: "not-object" };
  }
}

/** Bind a successor activation to the exact run and PLAN event that consumed the re-plan. */
export function graphPlanActivationDigest(value: GraphPlanActivationIdentity): string {
  const record = nestedRecord(value, [
    "runId",
    "corpusCaseId",
    "corpusSnapshotDigest",
    "eventId",
    "nodeId",
    "sequence",
    "transition",
  ]);
  opaqueIdentifier(record.runId);
  opaqueIdentifier(record.corpusCaseId);
  opaqueIdentifier(record.corpusSnapshotDigest);
  opaqueIdentifier(record.eventId);
  opaqueIdentifier(record.nodeId);
  boundedInteger(record.sequence, 1, Number.MAX_SAFE_INTEGER);
  const transition = validatePlanTransitionEvidence(record.transition);
  return sha256(canonicalJson({
    schemaVersion: 1,
    kind: "graph-plan-activation",
    runId: record.runId,
    corpusCaseId: record.corpusCaseId,
    corpusSnapshotDigest: record.corpusSnapshotDigest,
    eventId: record.eventId,
    nodeId: record.nodeId,
    sequence: record.sequence,
    transition,
  }));
}

/** Digest the immutable worktree/base/write-set receipt for one exact stage attempt. */
export function graphWorktreeReceiptDigest(value: GraphExecutionReceiptIdentity): string {
  const receipt = validateExecutionReceiptIdentity(value, true, false, false);
  return sha256(canonicalJson({
    schemaVersion: 1,
    kind: "graph-worktree-execution-receipt",
    ...receipt,
  }));
}

/** Digest the scheduler interval and, for isolated mutation, its exact worktree artifacts. */
export function graphSchedulerReceiptDigest(value: GraphExecutionReceiptIdentity): string {
  const hasIsolation = value.baseRevisionDigest !== undefined
    || value.writeSetDigest !== undefined
    || value.worktreeReceiptDigest !== undefined;
  const receipt = validateExecutionReceiptIdentity(value, hasIsolation, hasIsolation, false);
  return sha256(canonicalJson({
    schemaVersion: 1,
    kind: "graph-scheduler-execution-receipt",
    ...receipt,
  }));
}

/** Bind one disjointness decision to the complete, sorted set of isolated mutation receipts. */
export function graphDisjointnessReceiptDigest(value: GraphDisjointnessReceiptIdentity): string {
  const record = nestedRecord(value, [
    "runId",
    "corpusCaseId",
    "corpusSnapshotDigest",
    "baseRevisionDigest",
    "executions",
  ]);
  opaqueIdentifier(record.runId);
  opaqueIdentifier(record.corpusCaseId);
  opaqueIdentifier(record.corpusSnapshotDigest);
  opaqueIdentifier(record.baseRevisionDigest);
  const executions = plainDataArray(record.executions, MAX_EVENTS);
  if (executions.length < 2) fail("inconsistent-metrics");
  const normalized = executions.map((execution) => validateExecutionReceiptIdentity(execution, true, true, true));
  normalized.sort((left, right) => left.sequence - right.sequence || compareCodeUnits(left.eventId, right.eventId));
  const identities = new Set<string>();
  for (const execution of normalized) {
    if (execution.runId !== record.runId
      || execution.corpusCaseId !== record.corpusCaseId
      || execution.corpusSnapshotDigest !== record.corpusSnapshotDigest
      || execution.baseRevisionDigest !== record.baseRevisionDigest
      || identities.has(execution.eventId)) {
      fail("inconsistent-metrics");
    }
    identities.add(execution.eventId);
  }
  return sha256(canonicalJson({
    schemaVersion: 1,
    kind: "graph-disjointness-receipt",
    runId: record.runId,
    corpusCaseId: record.corpusCaseId,
    corpusSnapshotDigest: record.corpusSnapshotDigest,
    baseRevisionDigest: record.baseRevisionDigest,
    executions: normalized,
  }));
}

function validatePlanTransitionEvidence(value: unknown): GraphPlanTransitionEvidence {
  const transition = nestedRecord(value, [
    "sourcePlanVersion",
    "targetPlanVersion",
    "graphDigest",
    "planDigest",
    "approvalDigest",
    "recoveryLedgerDigest",
  ]);
  boundedInteger(transition.sourcePlanVersion, 1, MAX_COUNT);
  boundedInteger(transition.targetPlanVersion, 1, MAX_COUNT);
  opaqueIdentifier(transition.graphDigest);
  opaqueIdentifier(transition.planDigest);
  opaqueIdentifier(transition.approvalDigest);
  opaqueIdentifier(transition.recoveryLedgerDigest);
  return {
    sourcePlanVersion: transition.sourcePlanVersion,
    targetPlanVersion: transition.targetPlanVersion,
    graphDigest: transition.graphDigest,
    planDigest: transition.planDigest,
    approvalDigest: transition.approvalDigest,
    recoveryLedgerDigest: transition.recoveryLedgerDigest,
  };
}

function validateExecutionReceiptIdentity(
  value: unknown,
  requireIsolation: boolean,
  requireWorktreeReceipt: boolean,
  requireSchedulerReceipt: boolean,
): GraphExecutionReceiptIdentity {
  const record = nestedRecord(value, [
    "runId",
    "corpusCaseId",
    "corpusSnapshotDigest",
    "eventId",
    "nodeId",
    "sequence",
    "attempt",
    "stage",
    "startedAt",
    "completedAt",
    "baseRevisionDigest",
    "writeSetDigest",
    "worktreeReceiptDigest",
    "schedulerReceiptDigest",
  ]);
  opaqueIdentifier(record.runId);
  opaqueIdentifier(record.corpusCaseId);
  opaqueIdentifier(record.corpusSnapshotDigest);
  opaqueIdentifier(record.eventId);
  opaqueIdentifier(record.nodeId);
  boundedInteger(record.sequence, 1, Number.MAX_SAFE_INTEGER);
  boundedInteger(record.attempt, 1, MAX_COUNT);
  enumValue(record.stage, STAGES);
  isoTime(record.startedAt);
  isoTime(record.completedAt);
  if (Date.parse(record.completedAt) < Date.parse(record.startedAt)) fail("inconsistent-metrics");
  const isolation = [record.baseRevisionDigest, record.writeSetDigest];
  if (requireIsolation || isolation.some((item) => item !== undefined)) {
    if (isolation.some((item) => item === undefined)) fail("inconsistent-metrics");
    opaqueIdentifier(record.baseRevisionDigest);
    opaqueIdentifier(record.writeSetDigest);
  }
  if (requireWorktreeReceipt) opaqueIdentifier(record.worktreeReceiptDigest);
  else if (record.worktreeReceiptDigest !== undefined) fail("inconsistent-metrics");
  if (requireSchedulerReceipt) opaqueIdentifier(record.schedulerReceiptDigest);
  else if (record.schedulerReceiptDigest !== undefined) fail("inconsistent-metrics");
  return {
    runId: record.runId,
    corpusCaseId: record.corpusCaseId,
    corpusSnapshotDigest: record.corpusSnapshotDigest,
    eventId: record.eventId,
    nodeId: record.nodeId,
    sequence: record.sequence,
    attempt: record.attempt,
    stage: record.stage,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    ...(record.baseRevisionDigest === undefined ? {} : { baseRevisionDigest: record.baseRevisionDigest as string }),
    ...(record.writeSetDigest === undefined ? {} : { writeSetDigest: record.writeSetDigest as string }),
    ...(record.worktreeReceiptDigest === undefined ? {} : { worktreeReceiptDigest: record.worktreeReceiptDigest as string }),
    ...(record.schedulerReceiptDigest === undefined ? {} : { schedulerReceiptDigest: record.schedulerReceiptDigest as string }),
  };
}

export function createGraphExperimentManifest(value: GraphExperimentManifestInput): GraphExperimentManifest {
  try {
    const normalized = normalizeExperimentManifestInput(value);
    const experimentId = sha256(canonicalJson(normalized));
    return Object.freeze({
      ...normalized,
      experimentId,
      engines: Object.freeze(normalized.engines.map((engine) => Object.freeze({
        ...engine,
        features: Object.freeze({ ...engine.features }),
      }))),
      cases: Object.freeze(normalized.cases.map((item) => Object.freeze({ ...item }))),
    });
  } catch (error) {
    if (error instanceof GraphEvidenceError) throw error;
    throw new GraphEvidenceError("invalid-experiment-manifest");
  }
}

export function validateGraphExperimentManifest(value: unknown): GraphExperimentManifest {
  try {
    const record = strictRecord(value, [
      "schemaVersion", "experimentId", "releaseVersion", "corpusSnapshotDigest", "engines", "cases",
    ]);
    if (record.schemaVersion !== 1) throw new Error("version");
    opaqueIdentifier(record.experimentId);
    const normalized = normalizeExperimentManifestInput({
      schemaVersion: 1,
      releaseVersion: record.releaseVersion as string,
      corpusSnapshotDigest: record.corpusSnapshotDigest as string,
      engines: record.engines as readonly GraphExperimentEngine[],
      cases: record.cases as readonly GraphExperimentCase[],
    });
    const expected = createGraphExperimentManifest(normalized);
    if (record.experimentId !== expected.experimentId || canonicalJson(value) !== canonicalJson(expected)) {
      throw new Error("digest");
    }
    return expected;
  } catch (error) {
    if (error instanceof GraphEvidenceError && error.code === "invalid-experiment-manifest") throw error;
    throw new GraphEvidenceError("invalid-experiment-manifest");
  }
}

function normalizeExperimentManifestInput(value: unknown): NormalizedGraphExperimentManifestInput {
  const record = strictRecord(value, [
    "schemaVersion", "releaseVersion", "corpusSnapshotDigest", "engines", "cases",
  ], ["schemaVersion", "releaseVersion", "engines", "cases"]);
  if (record.schemaVersion !== 1) throw new GraphEvidenceError("invalid-experiment-manifest");
  semanticVersion(record.releaseVersion);

  const engines = plainDataArray(record.engines, ENGINE_GROUPS.length)
    .map((value): GraphExperimentEngine => {
      const engine = strictRecord(value, [
        "engineGroup", "graphVersion", "configurationDigest", "features",
      ]);
      enumValue(engine.engineGroup, ENGINE_GROUPS);
      semanticVersion(engine.graphVersion);
      opaqueIdentifier(engine.configurationDigest);
      const features = strictRecord(engine.features, [
        "graphDeclarations",
        "activeOuterGraph",
        "durableScheduler",
        "immutableBuildDag",
        "typedRecovery",
        "isolatedParallelBuild",
      ]);
      for (const feature of Object.keys(GRAPH_ENGINE_FEATURES.G0) as Array<keyof GraphEngineFeatureVector>) {
        booleanValue(features[feature]);
      }
      const normalizedFeatures = {
        graphDeclarations: features.graphDeclarations as boolean,
        activeOuterGraph: features.activeOuterGraph as boolean,
        durableScheduler: features.durableScheduler as boolean,
        immutableBuildDag: features.immutableBuildDag as boolean,
        typedRecovery: features.typedRecovery as boolean,
        isolatedParallelBuild: features.isolatedParallelBuild as boolean,
      };
      if (!sameFeatureVector(normalizedFeatures, GRAPH_ENGINE_FEATURES[engine.engineGroup])) {
        throw new GraphEvidenceError("invalid-experiment-manifest");
      }
      return {
        engineGroup: engine.engineGroup,
        graphVersion: engine.graphVersion,
        configurationDigest: engine.configurationDigest,
        features: normalizedFeatures,
      };
    });
  const engineGroups = new Set(engines.map((engine) => engine.engineGroup));
  const engineConfigurations = new Set(engines.map((engine) => engine.configurationDigest));
  if (engineGroups.size !== ENGINE_GROUPS.length
    || engineConfigurations.size !== ENGINE_GROUPS.length
    || !ENGINE_GROUPS.every((engineGroup) => engineGroups.has(engineGroup))) {
    throw new GraphEvidenceError("invalid-experiment-manifest");
  }
  engines.sort((left, right) => ENGINE_GROUPS.indexOf(left.engineGroup) - ENGINE_GROUPS.indexOf(right.engineGroup));

  const rawCases = plainDataArray(record.cases, MAX_EVENTS);
  if (rawCases.length === 0) throw new GraphEvidenceError("invalid-experiment-manifest");
  const cases = rawCases.map((value): GraphExperimentCase => {
    const item = strictRecord(value, ["corpusCaseId", "taskCategory", "snapshotDigest"]);
    opaqueIdentifier(item.corpusCaseId);
    enumValue(item.taskCategory, TASK_CATEGORIES);
    opaqueIdentifier(item.snapshotDigest);
    return {
      corpusCaseId: item.corpusCaseId,
      taskCategory: item.taskCategory,
      snapshotDigest: item.snapshotDigest,
    };
  });
  cases.sort((left, right) => TASK_CATEGORIES.indexOf(left.taskCategory) - TASK_CATEGORIES.indexOf(right.taskCategory)
    || compareCodeUnits(left.corpusCaseId, right.corpusCaseId));
  const caseIds = new Set(cases.map((item) => item.corpusCaseId));
  const caseSnapshots = new Set(cases.map((item) => item.snapshotDigest));
  if (caseIds.size !== cases.length || caseSnapshots.size !== cases.length) {
    throw new GraphEvidenceError("invalid-experiment-manifest");
  }

  const corpusSnapshotDigest = sha256(canonicalJson(cases));
  if (record.corpusSnapshotDigest !== undefined) {
    opaqueIdentifier(record.corpusSnapshotDigest);
    if (record.corpusSnapshotDigest !== corpusSnapshotDigest) {
      throw new GraphEvidenceError("invalid-experiment-manifest");
    }
  }
  return {
    schemaVersion: 1,
    releaseVersion: record.releaseVersion,
    corpusSnapshotDigest,
    engines,
    cases,
  };
}

function validateExperimentEvidence(
  events: readonly GraphEvidenceEvent[],
  manifest: GraphExperimentManifest,
): void {
  const engines = new Map(manifest.engines.map((engine) => [engine.engineGroup, engine]));
  const cases = new Map(manifest.cases.map((item) => [item.corpusCaseId, item]));
  for (const event of events) {
    const engine = engines.get(event.engineGroup);
    const corpusCase = cases.get(event.corpusCaseId);
    if (event.experimentId !== manifest.experimentId
      || engine === undefined
      || corpusCase === undefined
      || event.graphVersion !== engine.graphVersion
      || event.engineConfigurationDigest !== engine.configurationDigest
      || event.taskCategory !== corpusCase.taskCategory
      || event.corpusSnapshotDigest !== corpusCase.snapshotDigest) {
      throw new GraphEvidenceError("inconsistent-experiment-evidence");
    }
  }
}

export function buildGraphEvidenceReport(
  values: readonly unknown[],
  options: GraphEvidenceReportOptions = {},
): GraphEvidenceReport {
  validateReportOptions(options);
  const experiment = options.experimentManifest === undefined
    ? undefined
    : validateGraphExperimentManifest(options.experimentManifest);
  const inputEvents = reportEventArray(values);
  const events: GraphEvidenceEvent[] = [];
  for (const value of inputEvents) {
    const validation = validateGraphEvidenceEvent(value);
    if (!validation.ok) throw new GraphEvidenceError("invalid-event");
    events.push(validation.event);
  }
  validateLedger(events);
  if (experiment) validateExperimentEvidence(events, experiment);

  const runs = events.filter((event): event is GraphRunEvidenceEvent => event.type === "run")
    .sort(compareRunEvidence);
  const completeRunIds = new Set(runs.filter((run) => run.traceCompleteness === "complete").map((run) => run.runId));
  const allRunIds = new Set(events.map((event) => event.runId));
  const hasIncompleteSummaries = allRunIds.size > runs.length;
  const decisionRatesAvailable = !hasIncompleteSummaries && completeRunIds.size === runs.length;
  const groups = new Map<string, GraphRunEvidenceEvent[]>();
  for (const run of runs) {
    const key = `${run.engineGroup}\u0000${run.taskCategory}`;
    const group = groups.get(key) ?? [];
    group.push(run);
    groups.set(key, group);
  }
  const cohorts = [...groups.entries()].map(([key, group]) => {
    const [engineGroup, taskCategory] = key.split("\u0000") as [GraphEngineGroup, GraphTaskCategory];
    return { engineGroup, taskCategory, ...aggregateRuns(group, decisionRatesAvailable) };
  }).sort((left, right) => ENGINE_GROUPS.indexOf(left.engineGroup) - ENGINE_GROUPS.indexOf(right.engineGroup)
    || TASK_CATEGORIES.indexOf(left.taskCategory) - TASK_CATEGORIES.indexOf(right.taskCategory));

  const minimumCohortRuns = options.minimumCohortRuns ?? 10;
  const limitations: GraphEvidenceLimitation[] = [
    "no-counterfactual-quality-claim",
    "paid-provider-evidence-not-attested",
    ...(experiment ? [] : ["unverified-experiment-provenance" as const]),
  ];
  const coverage = assessAblationCoverage(runs, minimumCohortRuns);
  if (!coverage.sufficientSamples) {
    limitations.push("insufficient-cohort-samples");
  }
  if (!coverage.allEngineGroups) limitations.push("incomplete-engine-group-coverage");
  if (!coverage.allTaskCategories) limitations.push("incomplete-task-category-coverage");
  if (!coverage.completeMatrix) limitations.push("incomplete-ablation-matrix");
  if (!coverage.sufficientDistinctCases) limitations.push("insufficient-distinct-corpus-cases");
  if (!hasPairedBaselineCorpus(runs)) limitations.push("unpaired-baseline-corpus");
  if (hasIncompleteSummaries) limitations.push("incomplete-run-summaries");
  if (runs.some((run) => run.traceCompleteness !== "complete")) limitations.push("partial-traces");
  if (runs.some((run) => Object.values(run.usage).some((value) => value === "unknown"))) limitations.push("unknown-usage");
  if (runs.some((run) => Object.values(run.cost).some((value) => value === "unknown"))) limitations.push("unknown-cost");

  const rolloutBlockingLimitations: readonly GraphEvidenceLimitation[] = [
    "unverified-experiment-provenance",
    "insufficient-cohort-samples",
    "incomplete-engine-group-coverage",
    "incomplete-task-category-coverage",
    "incomplete-ablation-matrix",
    "insufficient-distinct-corpus-cases",
    "unpaired-baseline-corpus",
    "incomplete-run-summaries",
    "partial-traces",
    "unknown-usage",
    "unknown-cost",
  ];
  const evidenceComplete = !limitations.some((limitation) => rolloutBlockingLimitations.includes(limitation));
  const completeTraces = eventsByRun(events);
  const verifiedTypedRecoveryRunIds = new Set(completeTraces
    .filter(({ stages, summary }) => summary !== undefined
      && hasVerifiedTypedRecovery(stages, summary))
    .map(({ summary }) => summary!.runId));
  const verifiedIsolatedParallelRunIds = new Set(completeTraces
    .filter(({ stages, summary }) => summary !== undefined
      && summary.traceCompleteness === "complete"
      && hasVerifiedIsolatedMutationOverlap(stages))
    .map(({ summary }) => summary!.runId));
  const recommendation = deriveRolloutRecommendation(
    runs,
    cohorts,
    evidenceComplete,
    verifiedTypedRecoveryRunIds,
    verifiedIsolatedParallelRunIds,
    minimumCohortRuns,
  );
  return {
    schemaVersion: 1,
    qualityClaim: "observed-executions-only",
    evidenceComplete,
    recommendedDecision: recommendation.decision,
    decisionReasons: recommendation.reasons,
    rolloutDecisionEligible: evidenceComplete && recommendation.decision !== "keep-graph-shadow",
    eventCount: events.length,
    stageEventCount: events.length - runs.length,
    runCount: runs.length,
    totals: aggregateRuns(runs, decisionRatesAvailable),
    cohorts,
    limitations,
  };
}

function deriveRolloutRecommendation(
  runs: readonly GraphRunEvidenceEvent[],
  cohorts: readonly GraphEvidenceCohortReport[],
  evidenceComplete: boolean,
  verifiedTypedRecoveryRunIds: ReadonlySet<string>,
  verifiedIsolatedParallelRunIds: ReadonlySet<string>,
  minimumCohortRuns: number,
): { decision: GraphRolloutDecision; reasons: GraphRolloutDecisionReason[] } {
  if (!evidenceComplete) {
    return { decision: "keep-graph-shadow", reasons: ["evidence-incomplete"] };
  }

  if (!SEQUENTIAL_ROLLOUT_GROUPS.every((group) => groupIsNonInferiorToBaseline(group, cohorts))) {
    return { decision: "keep-graph-shadow", reasons: ["sequential-regression"] };
  }
  const typedRecoveryObserved = runs.some((run) => run.engineGroup === "G5"
    && run.finalStatus === "done"
    && verifiedTypedRecoveryRunIds.has(run.runId));
  if (!typedRecoveryObserved) {
    return { decision: "keep-graph-shadow", reasons: ["typed-recovery-unobserved"] };
  }

  if (!groupIsNonInferiorToBaseline("G6", cohorts)) {
    return {
      decision: "enable-sequential-graph",
      reasons: ["sequential-non-inferior", "dag-regression"],
    };
  }
  const usefulIsolatedParallelismObserved = REPRESENTATIVE_PARALLEL_TASK_CATEGORIES.every((taskCategory) => {
    const distinctVerifiedCases = new Set(runs.filter((run) => (
      run.engineGroup === "G6"
        && run.taskCategory === taskCategory
        && run.parallelism.mode === "isolated-writes"
        && verifiedIsolatedParallelRunIds.has(run.runId)
        && isUsefulParallelRun(run)
    )).map((run) => run.corpusCaseId));
    return distinctVerifiedCases.size >= minimumCohortRuns;
  });
  if (!usefulIsolatedParallelismObserved) {
    return {
      decision: "enable-sequential-graph",
      reasons: ["sequential-non-inferior", "useful-isolated-parallelism-unobserved"],
    };
  }
  return { decision: "enable-graph-dag", reasons: ["dag-non-inferior"] };
}

function groupIsNonInferiorToBaseline(
  engineGroup: GraphEngineGroup,
  cohorts: readonly GraphEvidenceCohortReport[],
): boolean {
  for (const taskCategory of TASK_CATEGORIES) {
    const baseline = cohorts.find((cohort) => (
      cohort.engineGroup === "G0" && cohort.taskCategory === taskCategory
    ));
    const candidate = cohorts.find((cohort) => (
      cohort.engineGroup === engineGroup && cohort.taskCategory === taskCategory
    ));
    if (!baseline || !candidate || !cohortIsNonInferior(candidate, baseline)) return false;
  }
  return true;
}

function cohortIsNonInferior(
  candidate: GraphEvidenceCohortReport,
  baseline: GraphEvidenceCohortReport,
): boolean {
  const candidateContracts = safeIntegerAdd(
    safeIntegerAdd(candidate.contractChecks.passed, candidate.contractChecks.failed),
    candidate.contractChecks.skipped,
  );
  const baselineContracts = safeIntegerAdd(
    safeIntegerAdd(baseline.contractChecks.passed, baseline.contractChecks.failed),
    baseline.contractChecks.skipped,
  );
  return ratioAtLeast(candidate.successCount, candidate.runCount, baseline.successCount, baseline.runCount)
    && ratioAtLeast(
      candidate.contractChecks.passed,
      candidateContracts,
      baseline.contractChecks.passed,
      baselineContracts,
    )
    && ratioAtMost(
      candidate.contractChecks.failed,
      candidateContracts,
      baseline.contractChecks.failed,
      baselineContracts,
    )
    && ratioAtMost(
      candidate.contractChecks.skipped,
      candidateContracts,
      baseline.contractChecks.skipped,
      baselineContracts,
    )
    && ratioAtLeast(
      candidate.firstPassVerification.successes,
      candidate.firstPassVerification.knownSamples,
      baseline.firstPassVerification.successes,
      baseline.firstPassVerification.knownSamples,
    )
    && candidate.wallTimeMs.unknownSamples === 0
    && baseline.wallTimeMs.unknownSamples === 0
    && candidate.wallTimeMs.total <= baseline.wallTimeMs.total
    && candidate.estimatedCostUsd.unknownSamples === 0
    && baseline.estimatedCostUsd.unknownSamples === 0
    && scaledEvidenceDecimal(candidate.estimatedCostUsd.total) <= scaledEvidenceDecimal(baseline.estimatedCostUsd.total)
    && candidate.observedCostUsd.unknownSamples === 0
    && baseline.observedCostUsd.unknownSamples === 0
    && scaledEvidenceDecimal(candidate.observedCostUsd.total) <= scaledEvidenceDecimal(baseline.observedCostUsd.total)
    && ratioAtMost(candidate.redundantNodeExecutions, candidate.runCount, baseline.redundantNodeExecutions, baseline.runCount)
    && ratioAtMost(candidate.failedNodeExecutions, candidate.runCount, baseline.failedNodeExecutions, baseline.runCount)
    && ratioAtMost(candidate.skippedNodeExecutions, candidate.runCount, baseline.skippedNodeExecutions, baseline.runCount)
    && ratioAtMost(candidate.conflictingNodeExecutions, candidate.runCount, baseline.conflictingNodeExecutions, baseline.runCount)
    && ratioAtMost(candidate.retryCount, candidate.runCount, baseline.retryCount, baseline.runCount)
    && ratioAtMost(candidate.fallbackCount, candidate.runCount, baseline.fallbackCount, baseline.runCount)
    && ratioAtMost(candidate.buildPasses, candidate.runCount, baseline.buildPasses, baseline.runCount)
    && validatorCoverageIsNonInferior(candidate, baseline)
    && candidate.laterRejectionRuns <= baseline.laterRejectionRuns
    && candidate.failureLoopRuns <= baseline.failureLoopRuns
    && candidate.humanOverrideRuns <= baseline.humanOverrideRuns;
}

function ratioAtMost(
  candidateNumerator: number,
  candidateDenominator: number,
  baselineNumerator: number,
  baselineDenominator: number,
): boolean {
  if (candidateDenominator === 0 || baselineDenominator === 0) return false;
  return BigInt(candidateNumerator) * BigInt(baselineDenominator)
    <= BigInt(baselineNumerator) * BigInt(candidateDenominator);
}

function validatorCoverageIsNonInferior(
  candidate: GraphEvidenceCohortReport,
  baseline: GraphEvidenceCohortReport,
): boolean {
  return VALIDATORS.every((validator) => ratioAtLeast(
    candidate.validatorTypes[validator] ?? 0,
    candidate.runCount,
    baseline.validatorTypes[validator] ?? 0,
    baseline.runCount,
  ));
}

function ratioAtLeast(
  candidateNumerator: number,
  candidateDenominator: number,
  baselineNumerator: number,
  baselineDenominator: number,
): boolean {
  if (candidateDenominator === 0 || baselineDenominator === 0) return false;
  return BigInt(candidateNumerator) * BigInt(baselineDenominator)
    >= BigInt(baselineNumerator) * BigInt(candidateDenominator);
}

export function assessLegacyRetirement(value: LegacyRetirementEvidence): LegacyRetirementAssessment {
  if (!isRecord(value) || hasUnexpectedKey(value, [
    "releasedCompatibilityWindows",
    "evidenceSource",
    "rolloutReport",
    "graphCoverage",
    "cleanRollback",
    "configMigration",
  ])) {
    throw new GraphEvidenceError("invalid-retirement-evidence");
  }
  if (!Number.isInteger(value.releasedCompatibilityWindows)
    || value.releasedCompatibilityWindows < 0
    || value.releasedCompatibilityWindows > 1_000) {
    throw new GraphEvidenceError("invalid-retirement-evidence");
  }
  if (value.evidenceSource !== undefined && value.evidenceSource !== "trusted-release-record") {
    throw new GraphEvidenceError("invalid-retirement-evidence");
  }
  validateRetirementReference(value.rolloutReport, true);
  validateRetirementReference(value.graphCoverage, false);
  validateRetirementReference(value.cleanRollback, false);
  validateRetirementReference(value.configMigration, false);

  const missing: LegacyRetirementRequirement[] = [];
  if (value.releasedCompatibilityWindows < 1) missing.push("released-compatibility-window");
  if (value.evidenceSource !== "trusted-release-record") missing.push("trusted-release-evidence");
  // Shape-valid hashes are references, not proof that a trusted adapter loaded
  // and verified the referenced release artifacts. A later storage adapter is
  // the only component allowed to remove this conservative blocker.
  missing.push("verified-release-artifacts");
  if (!value.rolloutReport || value.rolloutReport.decision === "keep-graph-shadow") {
    missing.push("decision-ready-rollout-report");
  }
  if (!hasConsistentReleaseBinding(value)) missing.push("consistent-release-binding");
  if (!value.graphCoverage) missing.push("graph-coverage");
  if (!value.cleanRollback) missing.push("clean-rollback");
  if (!value.configMigration) missing.push("config-migration");
  return { eligible: missing.length === 0, missing };
}

function hasConsistentReleaseBinding(value: LegacyRetirementEvidence): boolean {
  if (!value.rolloutReport) return true;
  const expected = value.rolloutReport.releaseVersion;
  return [value.graphCoverage, value.cleanRollback, value.configMigration]
    .every((reference) => reference === undefined || reference.releaseVersion === expected);
}

function validateRetirementReference(value: unknown, rollout: boolean): void {
  if (value === undefined) return;
  if (!isRecord(value) || hasUnexpectedKey(value, rollout
    ? ["releaseVersion", "artifactDigest", "decision"]
    : ["releaseVersion", "artifactDigest"])) {
    throw new GraphEvidenceError("invalid-retirement-evidence");
  }
  try {
    semanticVersion(value.releaseVersion);
    opaqueIdentifier(value.artifactDigest);
  } catch {
    throw new GraphEvidenceError("invalid-retirement-evidence");
  }
  if (rollout
    && value.decision !== "keep-graph-shadow"
    && value.decision !== "enable-sequential-graph"
    && value.decision !== "enable-graph-dag") {
    throw new GraphEvidenceError("invalid-retirement-evidence");
  }
}

function validateEvent(value: unknown): GraphEvidenceEvent {
  const event = eventRecord(value);
  if (event.type !== "stage" && event.type !== "run") fail("invalid-enum");
  const allowed = event.type === "stage" ? STAGE_EVENT_KEYS : RUN_EVENT_KEYS;
  if (hasUnexpectedKey(event, allowed)) fail("unexpected-field");
  if (event.schemaVersion !== 1) fail("unsupported-version");
  opaqueIdentifier(event.eventId);
  opaqueIdentifier(event.runId);
  opaqueIdentifier(event.corpusCaseId);
  opaqueIdentifier(event.experimentId);
  opaqueIdentifier(event.corpusSnapshotDigest);
  opaqueIdentifier(event.engineConfigurationDigest);
  boundedInteger(event.sequence, 0, Number.MAX_SAFE_INTEGER);
  isoTime(event.recordedAt);
  enumValue(event.engineGroup, ENGINE_GROUPS);
  enumValue(event.taskCategory, TASK_CATEGORIES);
  semanticVersion(event.graphVersion);
  boundedInteger(event.planVersion, 1, MAX_COUNT);

  if (event.type === "stage") validateStageEvent(event);
  else validateRunEvent(event);
  return structuredClone(event) as unknown as GraphEvidenceEvent;
}

const COMMON_EVENT_KEYS = [
  "schemaVersion",
  "type",
  "eventId",
  "runId",
  "corpusCaseId",
  "experimentId",
  "corpusSnapshotDigest",
  "engineConfigurationDigest",
  "sequence",
  "recordedAt",
  "engineGroup",
  "taskCategory",
  "graphVersion",
  "planVersion",
] as const;
const STAGE_EVENT_KEYS = [
  ...COMMON_EVENT_KEYS,
  "stage",
  "nodeId",
  "attempt",
  "status",
  "contractStatus",
  "validatorTypes",
  "readySetWidth",
  "retryCount",
  "fallbackCount",
  "recoveryLevel",
  "planTransition",
  "planActivationDigest",
  "executionWindow",
  "durationMs",
  "usage",
  "cost",
  "failureLocalizationMs",
] as const;
const RUN_EVENT_KEYS = [
  ...COMMON_EVENT_KEYS,
  "finalStatus",
  "traceCompleteness",
  "nodeCount",
  "nodeExecutions",
  "redundantNodeExecutions",
  "maxReadySetWidth",
  "validatorTypes",
  "contractChecks",
  "retryCount",
  "fallbackCount",
  "recoveryLevel",
  "recoveryAttempts",
  "recoverySuccesses",
  "buildPasses",
  "firstPassVerification",
  "laterRejection",
  "humanOverride",
  "durationMs",
  "usage",
  "cost",
  "failureLocalizationMs",
  "parallelism",
] as const;

function validateStageEvent(event: Record<string, unknown>): void {
  enumValue(event.stage, STAGES);
  opaqueIdentifier(event.nodeId);
  boundedInteger(event.attempt, 1, MAX_COUNT);
  enumValue(event.status, STAGE_STATUSES);
  enumValue(event.contractStatus, CONTRACT_STATUSES);
  enumArray(event.validatorTypes, VALIDATORS, 16);
  if (event.validatorTypes.length === 0) fail("unbounded-array");
  boundedInteger(event.readySetWidth, 1, MAX_COUNT);
  boundedInteger(event.retryCount, 0, MAX_COUNT);
  boundedInteger(event.fallbackCount, 0, MAX_COUNT);
  enumValue(event.recoveryLevel, RECOVERY_LEVELS);
  if (event.planTransition !== undefined) {
    validatePlanTransitionEvidence(event.planTransition);
  }
  if (event.planActivationDigest !== undefined) opaqueIdentifier(event.planActivationDigest);
  if (event.executionWindow !== undefined) {
    const window = nestedRecord(event.executionWindow, [
      "startedAt",
      "completedAt",
      "schedulerReceiptDigest",
      "worktreeReceiptDigest",
      "baseRevisionDigest",
      "writeSetDigest",
      "disjointnessReceiptDigest",
    ]);
    isoTime(window.startedAt);
    isoTime(window.completedAt);
    opaqueIdentifier(window.schedulerReceiptDigest);
    const isolationFields = [
      window.worktreeReceiptDigest,
      window.baseRevisionDigest,
      window.writeSetDigest,
      window.disjointnessReceiptDigest,
    ];
    if (isolationFields.some((value) => value !== undefined)) {
      if (isolationFields.some((value) => value === undefined)) fail("inconsistent-metrics");
      for (const value of isolationFields) opaqueIdentifier(value);
    }
    if (Date.parse(window.completedAt as string) < Date.parse(window.startedAt as string)) fail("inconsistent-metrics");
    if (typeof event.durationMs === "number"
      && Date.parse(window.completedAt as string) - Date.parse(window.startedAt as string) !== event.durationMs) {
      fail("inconsistent-metrics");
    }
  }
  evidenceInteger(event.durationMs, MAX_DURATION_MS);
  usage(event.usage);
  cost(event.cost);
  evidenceInteger(event.failureLocalizationMs, MAX_DURATION_MS);
}

function validateRunEvent(event: Record<string, unknown>): void {
  enumValue(event.finalStatus, FINAL_STATUSES);
  enumValue(event.traceCompleteness, TRACE_COMPLETENESS);
  boundedInteger(event.nodeCount, 1, MAX_COUNT);
  boundedInteger(event.nodeExecutions, 0, MAX_COUNT);
  boundedInteger(event.redundantNodeExecutions, 0, MAX_COUNT);
  boundedInteger(event.maxReadySetWidth, 1, MAX_COUNT);
  enumArray(event.validatorTypes, VALIDATORS, 16);
  if (event.validatorTypes.length === 0) fail("unbounded-array");
  const contracts = nestedRecord(event.contractChecks, ["passed", "failed", "skipped"]);
  boundedInteger(contracts.passed, 0, MAX_COUNT);
  boundedInteger(contracts.failed, 0, MAX_COUNT);
  boundedInteger(contracts.skipped, 0, MAX_COUNT);
  boundedInteger(event.retryCount, 0, MAX_COUNT);
  boundedInteger(event.fallbackCount, 0, MAX_COUNT);
  enumValue(event.recoveryLevel, RECOVERY_LEVELS);
  boundedInteger(event.recoveryAttempts, 0, MAX_COUNT);
  boundedInteger(event.recoverySuccesses, 0, MAX_COUNT);
  boundedInteger(event.buildPasses, 0, MAX_COUNT);
  if (event.firstPassVerification !== "unknown" && typeof event.firstPassVerification !== "boolean") fail("invalid-boolean");
  booleanValue(event.laterRejection);
  booleanValue(event.humanOverride);
  evidenceInteger(event.durationMs, MAX_DURATION_MS);
  usage(event.usage);
  cost(event.cost);
  evidenceInteger(event.failureLocalizationMs, MAX_DURATION_MS);
  const parallelism = nestedRecord(event.parallelism, [
    "mode",
    "executedConcurrently",
    "summedNodeDurationMs",
    "criticalPathDurationMs",
    "failedNodeCount",
    "skippedNodeCount",
    "conflictingNodeCount",
  ]);
  enumValue(parallelism.mode, PARALLELISM_MODES);
  booleanValue(parallelism.executedConcurrently);
  evidenceInteger(parallelism.summedNodeDurationMs, MAX_DURATION_MS);
  evidenceInteger(parallelism.criticalPathDurationMs, MAX_DURATION_MS);
  boundedInteger(parallelism.failedNodeCount, 0, MAX_COUNT);
  boundedInteger(parallelism.skippedNodeCount, 0, MAX_COUNT);
  boundedInteger(parallelism.conflictingNodeCount, 0, MAX_COUNT);

  if ((event.recoverySuccesses as number) > (event.recoveryAttempts as number)
    || (event.redundantNodeExecutions as number) > (event.nodeExecutions as number)
    || (parallelism.failedNodeCount as number) > (event.nodeExecutions as number)
    || (parallelism.skippedNodeCount as number) > (event.nodeExecutions as number)
    || (parallelism.conflictingNodeCount as number) > (event.nodeExecutions as number)
    || (parallelism.mode === "none" && parallelism.executedConcurrently === true)
    || (parallelism.executedConcurrently === true
      && ((event.nodeExecutions as number) < 2 || (event.maxReadySetWidth as number) < 2))
    || (typeof parallelism.summedNodeDurationMs === "number"
      && typeof parallelism.criticalPathDurationMs === "number"
      && parallelism.criticalPathDurationMs > parallelism.summedNodeDurationMs)) {
    fail("inconsistent-metrics");
  }
}

function usage(value: unknown): void {
  const values = nestedRecord(value, ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]);
  evidenceInteger(values.inputTokens, MAX_TOKENS);
  evidenceInteger(values.outputTokens, MAX_TOKENS);
  evidenceInteger(values.cacheReadTokens, MAX_TOKENS);
  evidenceInteger(values.cacheWriteTokens, MAX_TOKENS);
}

function cost(value: unknown): void {
  const values = nestedRecord(value, ["estimatedUsd", "observedUsd"]);
  evidenceNumber(values.estimatedUsd, MAX_USD);
  evidenceNumber(values.observedUsd, MAX_USD);
}

function eventsByRun(events: readonly GraphEvidenceEvent[]): Array<{
  stages: GraphStageEvidenceEvent[];
  summary: GraphRunEvidenceEvent | undefined;
}> {
  const grouped = new Map<string, {
    stages: GraphStageEvidenceEvent[];
    summary: GraphRunEvidenceEvent | undefined;
  }>();
  for (const event of events) {
    const value = grouped.get(event.runId) ?? { stages: [], summary: undefined };
    if (event.type === "stage") value.stages.push(event);
    else value.summary = event;
    grouped.set(event.runId, value);
  }
  return [...grouped.values()].map((value) => ({
    stages: [...value.stages].sort((left, right) => left.sequence - right.sequence),
    summary: value.summary,
  }));
}

function hasVerifiedTypedRecovery(
  stages: readonly GraphStageEvidenceEvent[],
  summary: GraphRunEvidenceEvent,
): boolean {
  if (summary.engineGroup !== "G5"
    || summary.traceCompleteness !== "complete"
    || summary.finalStatus !== "done") {
    return false;
  }
  let directive: { level: "diagnose" | "replan"; planVersion: number } | undefined;
  for (const stage of stages) {
    if (directive?.level === "diagnose"
      && isMutationStage(stage)
      && stage.planVersion === directive.planVersion
      && stage.recoveryLevel === "repair") {
      if (stage.status === "succeeded" && stage.contractStatus === "passed") return true;
      directive = undefined;
    }
    if (directive?.level === "replan"
      && stage.stage === "plan"
      && stage.planVersion === directive.planVersion + 1
      && stage.planTransition?.sourcePlanVersion === directive.planVersion
      && stage.planTransition.targetPlanVersion === stage.planVersion) {
      if (stage.status === "succeeded" && stage.contractStatus === "passed") return true;
      directive = undefined;
    }
    if (stage.stage === "debug"
      && stage.status === "succeeded"
      && stage.contractStatus === "passed"
      && stage.validatorTypes.includes("structured-tool")
      && (stage.recoveryLevel === "diagnose" || stage.recoveryLevel === "replan")) {
      directive = { level: stage.recoveryLevel, planVersion: stage.planVersion };
    }
  }
  return false;
}

function validateLedger(events: readonly GraphEvidenceEvent[]): void {
  const eventIds = new Set<string>();
  const sequencesByRun = new Map<string, Set<number>>();
  const summariesByRun = new Map<string, GraphRunEvidenceEvent>();
  const eventsByRun = new Map<string, GraphEvidenceEvent[]>();
  const categoryByCorpusCase = new Map<string, GraphTaskCategory>();
  let releaseGraphVersion: string | undefined;
  for (const event of events) {
    if (eventIds.has(event.eventId)) throw new GraphEvidenceError("duplicate-event-id");
    eventIds.add(event.eventId);
    const existingCategory = categoryByCorpusCase.get(event.corpusCaseId);
    if (existingCategory !== undefined && existingCategory !== event.taskCategory) {
      throw new GraphEvidenceError("inconsistent-run-identity");
    }
    categoryByCorpusCase.set(event.corpusCaseId, event.taskCategory);
    if (releaseGraphVersion !== undefined && releaseGraphVersion !== event.graphVersion) {
      throw new GraphEvidenceError("inconsistent-run-identity");
    }
    releaseGraphVersion = event.graphVersion;
    const sequences = sequencesByRun.get(event.runId) ?? new Set<number>();
    if (sequences.has(event.sequence)) throw new GraphEvidenceError("duplicate-sequence");
    sequences.add(event.sequence);
    sequencesByRun.set(event.runId, sequences);
    const runEvents = eventsByRun.get(event.runId) ?? [];
    runEvents.push(event);
    eventsByRun.set(event.runId, runEvents);
    if (event.type === "run") {
      if (summariesByRun.has(event.runId)) throw new GraphEvidenceError("duplicate-run-summary");
      summariesByRun.set(event.runId, event);
    }
  }

  for (const [runId, runEvents] of eventsByRun) {
    const summary = summariesByRun.get(runId);
    const ordered = [...runEvents].sort((left, right) => left.sequence - right.sequence);
    const nodeAttempts = new Set<string>();
    for (let index = 0; index < ordered.length; index += 1) {
      const event = ordered[index]!;
      if (event.sequence !== index + 1) throw new GraphEvidenceError("inconsistent-run-trace");
      if (index > 0 && compareCodeUnits(ordered[index - 1]!.recordedAt, event.recordedAt) > 0) {
        throw new GraphEvidenceError("inconsistent-run-trace");
      }
      if (event.type === "stage") {
        const key = `${event.nodeId}\u0000${event.attempt}`;
        if (nodeAttempts.has(key)) throw new GraphEvidenceError("inconsistent-run-trace");
        nodeAttempts.add(key);
      }
    }
    if (!summary) continue;
    if (ordered[ordered.length - 1] !== summary) throw new GraphEvidenceError("run-summary-not-terminal");
    for (const event of ordered) {
      if (event.engineGroup !== summary.engineGroup
        || event.taskCategory !== summary.taskCategory
        || event.graphVersion !== summary.graphVersion
        || event.corpusCaseId !== summary.corpusCaseId
        || event.experimentId !== summary.experimentId
        || event.corpusSnapshotDigest !== summary.corpusSnapshotDigest
        || event.engineConfigurationDigest !== summary.engineConfigurationDigest) {
        throw new GraphEvidenceError("inconsistent-run-identity");
      }
    }
    const stages = ordered.filter((event): event is GraphStageEvidenceEvent => event.type === "stage");
    if (summary.traceCompleteness === "missing" && stages.length > 0) {
      throw new GraphEvidenceError("inconsistent-run-trace");
    }
    if (summary.traceCompleteness === "complete") validateCompleteRunTrace(stages, summary);
  }
}

function validateCompleteRunTrace(
  stages: readonly GraphStageEvidenceEvent[],
  summary: GraphRunEvidenceEvent,
): void {
  if (stages.length === 0) throw new GraphEvidenceError("inconsistent-run-trace");
  validateCompleteStageGrammar(stages, summary);

  const nodeIds = new Set<string>();
  const validators = new Set<GraphValidatorType>();
  const contracts = { passed: 0, failed: 0, skipped: 0 };
  let maxReadySetWidth = 0;
  let retryCount = 0;
  let fallbackCount = 0;
  let buildPasses = 0;
  let failedNodeCount = 0;
  let skippedNodeCount = 0;
  let recoveryAttempts = 0;
  let recoverySuccesses = 0;
  let firstPassVerification: boolean | "unknown" = "unknown";
  let acceptedCheckerSeen = false;
  let lastMutationSequence = 0;
  let lastAcceptedCheckerSequence = 0;
  let laterRejection = false;
  let recoveryLevel: GraphRecoveryLevel = "none";

  for (const stage of stages) {
    nodeIds.add(stage.nodeId);
    if (stage.status === "succeeded" && stage.contractStatus === "passed") {
      for (const validator of stage.validatorTypes) validators.add(validator);
    }
    if (stage.contractStatus === "unknown") throw new GraphEvidenceError("inconsistent-run-trace");
    contracts[stage.contractStatus] = safeIntegerAdd(contracts[stage.contractStatus], 1);
    maxReadySetWidth = Math.max(maxReadySetWidth, stage.readySetWidth);
    retryCount = safeIntegerAdd(retryCount, stage.retryCount);
    fallbackCount = safeIntegerAdd(fallbackCount, stage.fallbackCount);
    if (stage.stage === "build") buildPasses = Math.max(buildPasses, stage.attempt);
    if (stage.stage === "build" || stage.stage === "integrate") lastMutationSequence = stage.sequence;
    if (stage.status === "failed") failedNodeCount = safeIntegerAdd(failedNodeCount, 1);
    if (stage.status === "skipped") skippedNodeCount = safeIntegerAdd(skippedNodeCount, 1);
    if (stage.recoveryLevel !== "none") {
      recoveryAttempts = safeIntegerAdd(recoveryAttempts, 1);
      if (stage.status === "succeeded" && stage.contractStatus === "passed") {
        recoverySuccesses = safeIntegerAdd(recoverySuccesses, 1);
      }
    }
    const firstPassStage = summary.engineGroup === "G0" || summary.engineGroup === "G1"
      ? "fast-judge"
      : "verify";
    if (stage.stage === firstPassStage && firstPassVerification === "unknown") {
      firstPassVerification = stage.attempt === 1
        && stage.status === "succeeded"
        && stage.contractStatus === "passed";
    }
    if (stage.stage === "verify" || stage.stage === "review" || stage.stage === "fast-judge") {
      const accepted = stage.status === "succeeded" && stage.contractStatus === "passed";
      if (acceptedCheckerSeen && !accepted) laterRejection = true;
      if (accepted) {
        acceptedCheckerSeen = true;
        lastAcceptedCheckerSequence = stage.sequence;
      }
    }
    if (RECOVERY_LEVELS.indexOf(stage.recoveryLevel) > RECOVERY_LEVELS.indexOf(recoveryLevel)) {
      recoveryLevel = stage.recoveryLevel;
    }
  }

  const expectedValidators = VALIDATORS.filter((validator) => validators.has(validator));
  if (REQUIRED_VALIDATORS_BY_CATEGORY[summary.taskCategory]
    .some((validator) => !validators.has(validator))) {
    throw new GraphEvidenceError("inconsistent-run-trace");
  }
  const expectedUsage: GraphEvidenceUsage = {
    inputTokens: sumEvidenceField(stages, (stage) => stage.usage.inputTokens, true),
    outputTokens: sumEvidenceField(stages, (stage) => stage.usage.outputTokens, true),
    cacheReadTokens: sumEvidenceField(stages, (stage) => stage.usage.cacheReadTokens, true),
    cacheWriteTokens: sumEvidenceField(stages, (stage) => stage.usage.cacheWriteTokens, true),
  };
  const expectedCost: GraphEvidenceCost = {
    estimatedUsd: sumEvidenceField(stages, (stage) => stage.cost.estimatedUsd, false),
    observedUsd: sumEvidenceField(stages, (stage) => stage.cost.observedUsd, false),
  };
  const summedNodeDurationMs = sumEvidenceField(stages, (stage) => stage.durationMs, true);

  const finalStage = stages.at(-1)!;
  const terminalFailure = finalStage.status === "failed"
    || finalStage.contractStatus === "failed"
    || finalStage.recoveryLevel === "fail";
  const expectedTerminalStage: GraphEvidenceStage = summary.engineGroup === "G0" || summary.engineGroup === "G1"
    ? "fast-judge"
    : "ship";
  const acceptedTerminal = finalStage.stage === expectedTerminalStage
    && finalStage.status === "succeeded"
    && finalStage.contractStatus === "passed";
  if ((summary.finalStatus === "done" && (
    !acceptedCheckerSeen
    || lastAcceptedCheckerSequence <= lastMutationSequence
    || !acceptedTerminal
  ))
    || (summary.finalStatus === "failed" && !terminalFailure)
    || (summary.finalStatus === "cancelled" && finalStage.status !== "cancelled")
    || (summary.finalStatus === "paused" && finalStage.status !== "paused")) {
    throw new GraphEvidenceError("inconsistent-run-trace");
  }
  if (summary.humanOverride && !validators.has("human-gate")) {
    throw new GraphEvidenceError("inconsistent-run-trace");
  }
  validateCompleteParallelism(stages, summary, summedNodeDurationMs);

  if (summary.nodeExecutions !== stages.length
    || summary.nodeCount !== nodeIds.size
    || summary.redundantNodeExecutions !== stages.length - nodeIds.size
    || summary.maxReadySetWidth !== maxReadySetWidth
    || !sameStringArray(summary.validatorTypes, expectedValidators)
    || !sameContractCounts(summary.contractChecks, contracts)
    || summary.retryCount !== retryCount
    || summary.fallbackCount !== fallbackCount
    || summary.recoveryLevel !== recoveryLevel
    || summary.recoveryAttempts !== recoveryAttempts
    || summary.recoverySuccesses !== recoverySuccesses
    || summary.buildPasses !== buildPasses
    || summary.firstPassVerification !== firstPassVerification
    || summary.laterRejection !== laterRejection
    || summary.parallelism.failedNodeCount !== failedNodeCount
    || summary.parallelism.skippedNodeCount !== skippedNodeCount
    || !sameUsage(summary.usage, expectedUsage)
    || !sameCost(summary.cost, expectedCost)) {
    throw new GraphEvidenceError("inconsistent-run-trace");
  }
}

function validateCompleteParallelism(
  stages: readonly GraphStageEvidenceEvent[],
  summary: GraphRunEvidenceEvent,
  summedNodeDurationMs: GraphEvidenceNumber,
): void {
  const parallelism = summary.parallelism;
  const feature = GRAPH_ENGINE_FEATURES[summary.engineGroup];
  if (parallelism.summedNodeDurationMs !== summedNodeDurationMs
    || (parallelism.mode === "isolated-writes" && !feature.isolatedParallelBuild)
    || (parallelism.executedConcurrently && !feature.immutableBuildDag)) {
    throw new GraphEvidenceError("inconsistent-run-trace");
  }
  if (parallelism.criticalPathDurationMs === "unknown"
    ? summary.durationMs !== "unknown"
    : summary.durationMs === "unknown"
      || summary.durationMs < parallelism.criticalPathDurationMs) {
    throw new GraphEvidenceError("inconsistent-run-trace");
  }

  const windows = stages.map((stage) => stage.executionWindow);
  const presentWindows = windows.filter((window) => window !== undefined);
  if (stages.some((stage) => stage.executionWindow !== undefined
    && (Date.parse(stage.recordedAt) < Date.parse(stage.executionWindow.completedAt)
      || !hasVerifiedExecutionReceipt(stage)))
    || new Set(presentWindows.map((window) => window.schedulerReceiptDigest)).size !== presentWindows.length) {
    throw new GraphEvidenceError("inconsistent-run-trace");
  }
  const overlaps = inspectExecutionOverlaps(stages);
  if (!parallelism.executedConcurrently) {
    if (parallelism.mode !== "none"
      || parallelism.criticalPathDurationMs !== summedNodeDurationMs
      || (presentWindows.length > 0 && presentWindows.length !== stages.length)
      || presentWindows.some((window) => window.worktreeReceiptDigest !== undefined)
      || overlaps.any) {
      throw new GraphEvidenceError("inconsistent-run-trace");
    }
    return;
  }

  if (parallelism.mode === "none"
    || typeof summedNodeDurationMs !== "number"
    || typeof parallelism.criticalPathDurationMs !== "number"
    || windows.some((window) => window === undefined)
    || stages.some((stage) => typeof stage.durationMs !== "number")) {
    throw new GraphEvidenceError("inconsistent-run-trace");
  }

  if (stages.some((stage) => {
    const window = stage.executionWindow!;
    const isolated = window.worktreeReceiptDigest !== undefined;
    return parallelism.mode === "isolated-writes"
      ? isolated !== isMutationStage(stage)
      : isolated;
  })) {
    throw new GraphEvidenceError("inconsistent-run-trace");
  }

  let earliestStart = Number.POSITIVE_INFINITY;
  let latestCompletion = Number.NEGATIVE_INFINITY;
  for (const stage of stages) {
    const window = stage.executionWindow!;
    const startedAt = Date.parse(window.startedAt);
    const completedAt = Date.parse(window.completedAt);
    if (Date.parse(stage.recordedAt) < completedAt) throw new GraphEvidenceError("inconsistent-run-trace");
    earliestStart = Math.min(earliestStart, startedAt);
    latestCompletion = Math.max(latestCompletion, completedAt);
  }
  const makespan = latestCompletion - earliestStart;
  if (!Number.isSafeInteger(makespan)
    || makespan < 0
    || parallelism.criticalPathDurationMs !== makespan
    || summary.durationMs === "unknown"
    || summary.durationMs < makespan) {
    throw new GraphEvidenceError("inconsistent-run-trace");
  }

  if (!overlaps.ready) {
    throw new GraphEvidenceError("inconsistent-run-trace");
  }
  if (parallelism.mode === "read-only" && overlaps.mutationWithAny) {
    throw new GraphEvidenceError("inconsistent-run-trace");
  }
  if (parallelism.mode === "isolated-writes" && !hasVerifiedIsolatedMutationOverlap(stages)) {
    throw new GraphEvidenceError("inconsistent-run-trace");
  }
}

function inspectExecutionOverlaps(
  stages: readonly GraphStageEvidenceEvent[],
): { any: boolean; ready: boolean; mutation: boolean; mutationWithAny: boolean } {
  const ordered = stages.filter((stage) => stage.executionWindow !== undefined)
    .map((stage) => ({
      stage,
      start: Date.parse(stage.executionWindow!.startedAt),
      end: Date.parse(stage.executionWindow!.completedAt),
    }))
    .sort((left, right) => left.start - right.start || left.end - right.end || left.stage.sequence - right.stage.sequence);
  let maximumEnd = Number.NEGATIVE_INFINITY;
  let maximumReadyEnd = Number.NEGATIVE_INFINITY;
  let maximumMutationEnd = Number.NEGATIVE_INFINITY;
  let any = false;
  let ready = false;
  let mutation = false;
  let mutationWithAny = false;
  for (const current of ordered) {
    const isMutation = isMutationStage(current.stage);
    if (maximumEnd > current.start) any = true;
    if (current.stage.readySetWidth >= 2 && maximumReadyEnd > current.start) ready = true;
    if (isMutation && maximumMutationEnd > current.start) mutation = true;
    if ((isMutation && maximumEnd > current.start) || (!isMutation && maximumMutationEnd > current.start)) {
      mutationWithAny = true;
    }
    maximumEnd = Math.max(maximumEnd, current.end);
    if (current.stage.readySetWidth >= 2) maximumReadyEnd = Math.max(maximumReadyEnd, current.end);
    if (isMutation) maximumMutationEnd = Math.max(maximumMutationEnd, current.end);
  }
  return { any, ready, mutation, mutationWithAny };
}

function hasVerifiedIsolatedMutationOverlap(stages: readonly GraphStageEvidenceEvent[]): boolean {
  const worktrees = new Set<string>();
  const writeSets = new Set<string>();
  const mutationReceipts: GraphExecutionReceiptIdentity[] = [];
  const disjointnessDigests = new Set<string>();
  let baseRevisionDigest: string | undefined;
  for (const stage of stages) {
    if (!isMutationStage(stage)) continue;
    const receipt = stage.executionWindow;
    if (!receipt?.worktreeReceiptDigest
      || !receipt.baseRevisionDigest
      || !receipt.writeSetDigest
      || !receipt.disjointnessReceiptDigest
      || worktrees.has(receipt.worktreeReceiptDigest)
      || writeSets.has(receipt.writeSetDigest)
      || (baseRevisionDigest !== undefined && baseRevisionDigest !== receipt.baseRevisionDigest)
      || !hasVerifiedExecutionReceipt(stage)) return false;
    worktrees.add(receipt.worktreeReceiptDigest);
    writeSets.add(receipt.writeSetDigest);
    baseRevisionDigest = receipt.baseRevisionDigest;
    disjointnessDigests.add(receipt.disjointnessReceiptDigest);
    mutationReceipts.push(executionReceiptIdentity(stage, true, true));
  }
  if (baseRevisionDigest === undefined
    || mutationReceipts.length < 2
    || disjointnessDigests.size !== 1) return false;
  let expectedDigest: string;
  try {
    expectedDigest = graphDisjointnessReceiptDigest({
      runId: mutationReceipts[0]!.runId,
      corpusCaseId: mutationReceipts[0]!.corpusCaseId,
      corpusSnapshotDigest: mutationReceipts[0]!.corpusSnapshotDigest,
      baseRevisionDigest,
      executions: mutationReceipts,
    });
  } catch {
    return false;
  }
  return disjointnessDigests.has(expectedDigest) && inspectExecutionOverlaps(stages).mutation;
}

function hasVerifiedExecutionReceipt(stage: GraphStageEvidenceEvent): boolean {
  const window = stage.executionWindow;
  if (window === undefined) return false;
  try {
    const worktreeReceiptDigest = window.worktreeReceiptDigest === undefined
      ? undefined
      : graphWorktreeReceiptDigest(executionReceiptIdentity(stage, false, false));
    if (worktreeReceiptDigest !== window.worktreeReceiptDigest) return false;
    const schedulerReceiptDigest = graphSchedulerReceiptDigest({
      ...executionReceiptIdentity(stage, false, false),
      ...(worktreeReceiptDigest === undefined ? {} : { worktreeReceiptDigest }),
    });
    return schedulerReceiptDigest === window.schedulerReceiptDigest;
  } catch {
    return false;
  }
}

function executionReceiptIdentity(
  stage: GraphStageEvidenceEvent,
  includeWorktreeReceipt: boolean,
  includeSchedulerReceipt: boolean,
): GraphExecutionReceiptIdentity {
  const window = stage.executionWindow!;
  return {
    runId: stage.runId,
    corpusCaseId: stage.corpusCaseId,
    corpusSnapshotDigest: stage.corpusSnapshotDigest,
    eventId: stage.eventId,
    nodeId: stage.nodeId,
    sequence: stage.sequence,
    attempt: stage.attempt,
    stage: stage.stage,
    startedAt: window.startedAt,
    completedAt: window.completedAt,
    ...(window.baseRevisionDigest === undefined ? {} : { baseRevisionDigest: window.baseRevisionDigest }),
    ...(window.writeSetDigest === undefined ? {} : { writeSetDigest: window.writeSetDigest }),
    ...(includeWorktreeReceipt && window.worktreeReceiptDigest !== undefined
      ? { worktreeReceiptDigest: window.worktreeReceiptDigest }
      : {}),
    ...(includeSchedulerReceipt ? { schedulerReceiptDigest: window.schedulerReceiptDigest } : {}),
  };
}

function isMutationStage(stage: GraphStageEvidenceEvent): boolean {
  return stage.stage === "build" || stage.stage === "integrate";
}

function validateCompleteStageGrammar(
  stages: readonly GraphStageEvidenceEvent[],
  summary: GraphRunEvidenceEvent,
): void {
  const isFast = summary.engineGroup === "G0" || summary.engineGroup === "G1";
  const typedRecovery = summary.engineGroup === "G5" || summary.engineGroup === "G6";
  const finalStage = stages.at(-1)!;
  const accepted = (stage: GraphStageEvidenceEvent): boolean => (
    stage.status === "succeeded" && stage.contractStatus === "passed"
  );
  if (stages[0]!.planVersion !== 1) throw new GraphEvidenceError("inconsistent-run-trace");

  type DebugAuthorization = "diagnose" | "replan" | "legacy";
  interface OutstandingRejection {
    stage: "verify" | "review" | "ship" | "fast-judge";
    planVersion: number;
    debugAuthorization?: DebugAuthorization;
  }

  let activeVersion = 1;
  let activePlanActivationDigest: string | undefined;
  let outstandingRejection: OutstandingRejection | undefined;
  const planStages = new Set<number>();
  let defineIndex = -1;
  let planIndex = -1;
  let mutationIndex = -1;
  let verifyIndex = -1;
  let reviewIndex = -1;

  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index]!;
    const stageAccepted = accepted(stage);
    const terminalState = stage.status === "cancelled"
      || stage.status === "paused"
      || stage.recoveryLevel === "pause"
      || stage.recoveryLevel === "fail";
    if (terminalState && index !== stages.length - 1) {
      throw new GraphEvidenceError("inconsistent-run-trace");
    }
    if (stageAccepted
      && (stage.stage === "ship" || stage.stage === "fast-judge")
      && index !== stages.length - 1) {
      throw new GraphEvidenceError("inconsistent-run-trace");
    }

    if (isFast) {
      if (stage.stage !== "plan" && stage.stage !== "build" && stage.stage !== "fast-judge") {
        throw new GraphEvidenceError("inconsistent-run-trace");
      }
    } else if (stage.stage === "fast-judge") {
      throw new GraphEvidenceError("inconsistent-run-trace");
    }

    if (stage.stage === "plan") {
      if (planStages.has(stage.planVersion)) throw new GraphEvidenceError("inconsistent-run-trace");
      planStages.add(stage.planVersion);
    }
    if (stage.planVersion < activeVersion) throw new GraphEvidenceError("inconsistent-run-trace");
    if (stage.planVersion > activeVersion) {
      const transition = stage.planTransition;
      if (!typedRecovery
        || stage.planVersion !== activeVersion + 1
        || stage.stage !== "plan"
        || !stageAccepted
        || outstandingRejection?.debugAuthorization !== "replan"
        || outstandingRejection.planVersion !== activeVersion
        || transition === undefined
        || transition.sourcePlanVersion !== activeVersion
        || transition.targetPlanVersion !== stage.planVersion) {
        throw new GraphEvidenceError("inconsistent-run-trace");
      }
      const activationDigest = graphPlanActivationDigest({
        runId: stage.runId,
        corpusCaseId: stage.corpusCaseId,
        corpusSnapshotDigest: stage.corpusSnapshotDigest,
        eventId: stage.eventId,
        nodeId: stage.nodeId,
        sequence: stage.sequence,
        transition,
      });
      if (stage.planActivationDigest !== activationDigest) {
        throw new GraphEvidenceError("inconsistent-run-trace");
      }
      activeVersion = stage.planVersion;
      activePlanActivationDigest = activationDigest;
      outstandingRejection = undefined;
      planIndex = -1;
      mutationIndex = -1;
      verifyIndex = -1;
      reviewIndex = -1;
    } else if (stage.planTransition !== undefined) {
      throw new GraphEvidenceError("inconsistent-run-trace");
    }
    if (activePlanActivationDigest === undefined) {
      if (stage.planActivationDigest !== undefined) throw new GraphEvidenceError("inconsistent-run-trace");
    } else if (stage.planActivationDigest !== activePlanActivationDigest) {
      throw new GraphEvidenceError("inconsistent-run-trace");
    }

    const typedDiagnosis = stage.recoveryLevel === "diagnose" || stage.recoveryLevel === "replan";
    const repair = stage.recoveryLevel === "repair";
    if ((typedDiagnosis || repair) && !typedRecovery) {
      throw new GraphEvidenceError("inconsistent-run-trace");
    }
    if (typedDiagnosis && stage.stage !== "debug") {
      throw new GraphEvidenceError("inconsistent-run-trace");
    }
    if (repair && !isMutationStage(stage)) {
      throw new GraphEvidenceError("inconsistent-run-trace");
    }

    if (stage.stage === "debug") {
      if (outstandingRejection === undefined
        || (outstandingRejection.stage !== "verify" && outstandingRejection.stage !== "review")
        || outstandingRejection.planVersion !== activeVersion
        || outstandingRejection.debugAuthorization !== undefined) {
        throw new GraphEvidenceError("inconsistent-run-trace");
      }
      if (typedRecovery) {
        if (!typedDiagnosis) throw new GraphEvidenceError("inconsistent-run-trace");
        if (stageAccepted) {
          outstandingRejection.debugAuthorization = stage.recoveryLevel === "replan" ? "replan" : "diagnose";
        }
      } else {
        if (stage.recoveryLevel !== "none") throw new GraphEvidenceError("inconsistent-run-trace");
        if (stageAccepted) outstandingRejection.debugAuthorization = "legacy";
      }
    }

    if (isMutationStage(stage)) {
      if (outstandingRejection === undefined) {
        if (repair) throw new GraphEvidenceError("inconsistent-run-trace");
      } else {
        const checkerNeedsDebug = outstandingRejection.stage === "verify"
          || outstandingRejection.stage === "review";
        if (checkerNeedsDebug && typedRecovery
          && (outstandingRejection.debugAuthorization !== "diagnose" || !repair)) {
          throw new GraphEvidenceError("inconsistent-run-trace");
        }
        if (checkerNeedsDebug && !typedRecovery
          && outstandingRejection.debugAuthorization !== "legacy") {
          throw new GraphEvidenceError("inconsistent-run-trace");
        }
        if (outstandingRejection.debugAuthorization === "replan") {
          throw new GraphEvidenceError("inconsistent-run-trace");
        }
        outstandingRejection.debugAuthorization = undefined;
        if (stageAccepted) outstandingRejection = undefined;
      }
    }

    const checker = stage.stage === "verify"
      || stage.stage === "review"
      || stage.stage === "ship"
      || stage.stage === "fast-judge";
    if (checker && !stageAccepted) {
      if (outstandingRejection !== undefined) throw new GraphEvidenceError("inconsistent-run-trace");
      outstandingRejection = {
        stage: stage.stage as OutstandingRejection["stage"],
        planVersion: activeVersion,
      };
    } else if (checker && outstandingRejection !== undefined) {
      throw new GraphEvidenceError("inconsistent-run-trace");
    }

    if (stageAccepted) {
      if (stage.stage === "define") defineIndex = index;
      if (stage.stage === "plan" && stage.planVersion === activeVersion) planIndex = index;
      if (isMutationStage(stage) && stage.planVersion === activeVersion) mutationIndex = index;
      if (stage.stage === "verify" && stage.planVersion === activeVersion) verifyIndex = index;
      if (stage.stage === "review" && stage.planVersion === activeVersion) reviewIndex = index;
    }
  }

  if (activeVersion !== summary.planVersion
    || (outstandingRejection?.debugAuthorization === "replan")
    || (summary.finalStatus === "done" && outstandingRejection !== undefined)) {
    throw new GraphEvidenceError("inconsistent-run-trace");
  }

  if (summary.finalStatus !== "done") return;

  if (isFast) {
    if (planIndex < 0
      || mutationIndex <= planIndex
      || finalStage.stage !== "fast-judge"
      || !accepted(finalStage)
      || finalStage.sequence <= stages[mutationIndex]!.sequence) {
      throw new GraphEvidenceError("inconsistent-run-trace");
    }
    return;
  }

  if (defineIndex < 0
    || planIndex <= defineIndex
    || mutationIndex <= planIndex
    || verifyIndex <= mutationIndex
    || reviewIndex <= verifyIndex
    || finalStage.stage !== "ship"
    || finalStage.planVersion !== summary.planVersion
    || !accepted(finalStage)
    || finalStage.sequence <= stages[reviewIndex]!.sequence) {
    throw new GraphEvidenceError("inconsistent-run-trace");
  }
}

function sumEvidenceField(
  stages: readonly GraphStageEvidenceEvent[],
  select: (stage: GraphStageEvidenceEvent) => GraphEvidenceNumber,
  integer: boolean,
): GraphEvidenceNumber {
  let total = 0;
  for (const stage of stages) {
    const value = select(stage);
    if (value === "unknown") return "unknown";
    total = integer ? safeIntegerAdd(total, value) : safeDecimalAdd(total, value);
  }
  return total;
}

function sameUsage(left: GraphEvidenceUsage, right: GraphEvidenceUsage): boolean {
  return left.inputTokens === right.inputTokens
    && left.outputTokens === right.outputTokens
    && left.cacheReadTokens === right.cacheReadTokens
    && left.cacheWriteTokens === right.cacheWriteTokens;
}

function sameCost(left: GraphEvidenceCost, right: GraphEvidenceCost): boolean {
  return sameEvidenceDecimal(left.estimatedUsd, right.estimatedUsd)
    && sameEvidenceDecimal(left.observedUsd, right.observedUsd);
}

function sameEvidenceDecimal(left: GraphEvidenceNumber, right: GraphEvidenceNumber): boolean {
  return left === "unknown" || right === "unknown"
    ? left === right
    : roundEvidenceDecimal(left) === roundEvidenceDecimal(right);
}

function sameContractCounts(
  left: GraphRunEvidenceEvent["contractChecks"],
  right: GraphRunEvidenceEvent["contractChecks"],
): boolean {
  return left.passed === right.passed && left.failed === right.failed && left.skipped === right.skipped;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

interface MutableKnownUnknownTotal extends KnownUnknownTotal {}

interface MutableAggregate {
  runCount: number;
  successCount: number;
  finalStatuses: Record<GraphFinalStatus, number>;
  contractPassed: number;
  contractFailed: number;
  contractSkipped: number;
  wallTimeMs: MutableKnownUnknownTotal;
  failureLocalizationMs: MutableKnownUnknownTotal;
  inputTokens: MutableKnownUnknownTotal;
  outputTokens: MutableKnownUnknownTotal;
  cacheReadTokens: MutableKnownUnknownTotal;
  cacheWriteTokens: MutableKnownUnknownTotal;
  estimatedCostUsd: MutableKnownUnknownTotal;
  observedCostUsd: MutableKnownUnknownTotal;
  redundantNodeExecutions: number;
  failedNodeExecutions: number;
  skippedNodeExecutions: number;
  conflictingNodeExecutions: number;
  retryCount: number;
  fallbackCount: number;
  buildPasses: number;
  maxReadySetWidth: number;
  laterRejectionRuns: number;
  humanOverrideRuns: number;
  firstPassSuccesses: number;
  firstPassKnown: number;
  recoverySuccesses: number;
  recoveryAttempts: number;
  graphVersions: Map<string, number>;
  planVersions: Map<number, number>;
  recoveryLevels: Record<GraphRecoveryLevel, number>;
  traceStatuses: Record<GraphTraceCompleteness, number>;
  validatorTypes: Map<GraphValidatorType, number>;
  failureLoopRuns: number;
  completeTraceRuns: number;
  usefulRuns: number;
  parallelEligibleRuns: number;
  criticalPathSavingsMs: number;
}

function aggregateRuns(
  runs: readonly GraphRunEvidenceEvent[],
  decisionRatesAvailable: boolean,
): GraphEvidenceAggregate {
  const aggregate = emptyMutableAggregate();
  for (const run of runs) addRun(aggregate, run);
  const checkedContracts = safeIntegerAdd(aggregate.contractPassed, aggregate.contractFailed);
  return {
    runCount: aggregate.runCount,
    successCount: aggregate.successCount,
    successRateBasisPoints: decisionRate(aggregate.successCount, aggregate.runCount, decisionRatesAvailable),
    finalStatuses: aggregate.finalStatuses,
    contractChecks: {
      passed: aggregate.contractPassed,
      failed: aggregate.contractFailed,
      skipped: aggregate.contractSkipped,
      satisfactionRateBasisPoints: decisionRate(aggregate.contractPassed, checkedContracts, decisionRatesAvailable),
    },
    wallTimeMs: finishTotal(aggregate.wallTimeMs),
    failureLocalizationMs: finishTotal(aggregate.failureLocalizationMs),
    inputTokens: finishTotal(aggregate.inputTokens),
    outputTokens: finishTotal(aggregate.outputTokens),
    cacheReadTokens: finishTotal(aggregate.cacheReadTokens),
    cacheWriteTokens: finishTotal(aggregate.cacheWriteTokens),
    estimatedCostUsd: finishTotal(aggregate.estimatedCostUsd),
    observedCostUsd: finishTotal(aggregate.observedCostUsd),
    redundantNodeExecutions: aggregate.redundantNodeExecutions,
    failedNodeExecutions: aggregate.failedNodeExecutions,
    skippedNodeExecutions: aggregate.skippedNodeExecutions,
    conflictingNodeExecutions: aggregate.conflictingNodeExecutions,
    retryCount: aggregate.retryCount,
    fallbackCount: aggregate.fallbackCount,
    buildPasses: aggregate.buildPasses,
    maxReadySetWidth: aggregate.maxReadySetWidth,
    laterRejectionRuns: aggregate.laterRejectionRuns,
    humanOverrideRuns: aggregate.humanOverrideRuns,
    firstPassVerification: {
      successes: aggregate.firstPassSuccesses,
      knownSamples: aggregate.firstPassKnown,
      rateBasisPoints: decisionRate(aggregate.firstPassSuccesses, aggregate.firstPassKnown, decisionRatesAvailable),
    },
    recovery: {
      successes: aggregate.recoverySuccesses,
      attempts: aggregate.recoveryAttempts,
      successRateBasisPoints: decisionRate(aggregate.recoverySuccesses, aggregate.recoveryAttempts, decisionRatesAvailable),
    },
    graphVersions: Object.fromEntries([...aggregate.graphVersions.entries()].sort(([left], [right]) => compareCodeUnits(left, right))),
    planVersions: Object.fromEntries([...aggregate.planVersions.entries()].sort((left, right) => left[0] - right[0])
      .map(([version, count]) => [String(version), count])),
    recoveryLevels: aggregate.recoveryLevels,
    traceStatuses: aggregate.traceStatuses,
    validatorTypes: Object.fromEntries(VALIDATORS.filter((validator) => aggregate.validatorTypes.has(validator))
      .map((validator) => [validator, aggregate.validatorTypes.get(validator)!])),
    failureLoopRuns: aggregate.failureLoopRuns,
    failureLoopRateBasisPoints: decisionRate(aggregate.failureLoopRuns, aggregate.runCount, decisionRatesAvailable),
    completeTraceRuns: aggregate.completeTraceRuns,
    completeTraceRateBasisPoints: rate(aggregate.completeTraceRuns, aggregate.runCount),
    usefulParallelism: {
      usefulRuns: aggregate.usefulRuns,
      eligibleRuns: aggregate.parallelEligibleRuns,
      observedCriticalPathSavingsMs: aggregate.criticalPathSavingsMs,
    },
  };
}

function emptyMutableAggregate(): MutableAggregate {
  return {
    runCount: 0,
    successCount: 0,
    finalStatuses: { done: 0, failed: 0, cancelled: 0, paused: 0 },
    contractPassed: 0,
    contractFailed: 0,
    contractSkipped: 0,
    wallTimeMs: emptyTotal(),
    failureLocalizationMs: emptyTotal(),
    inputTokens: emptyTotal(),
    outputTokens: emptyTotal(),
    cacheReadTokens: emptyTotal(),
    cacheWriteTokens: emptyTotal(),
    estimatedCostUsd: emptyTotal(),
    observedCostUsd: emptyTotal(),
    redundantNodeExecutions: 0,
    failedNodeExecutions: 0,
    skippedNodeExecutions: 0,
    conflictingNodeExecutions: 0,
    retryCount: 0,
    fallbackCount: 0,
    buildPasses: 0,
    maxReadySetWidth: 0,
    laterRejectionRuns: 0,
    humanOverrideRuns: 0,
    firstPassSuccesses: 0,
    firstPassKnown: 0,
    recoverySuccesses: 0,
    recoveryAttempts: 0,
    graphVersions: new Map(),
    planVersions: new Map(),
    recoveryLevels: { none: 0, retry: 0, diagnose: 0, repair: 0, replan: 0, pause: 0, fail: 0 },
    traceStatuses: { complete: 0, partial: 0, missing: 0 },
    validatorTypes: new Map(),
    failureLoopRuns: 0,
    completeTraceRuns: 0,
    usefulRuns: 0,
    parallelEligibleRuns: 0,
    criticalPathSavingsMs: 0,
  };
}

function addRun(aggregate: MutableAggregate, run: GraphRunEvidenceEvent): void {
  aggregate.runCount = safeIntegerAdd(aggregate.runCount, 1);
  if (run.finalStatus === "done") aggregate.successCount = safeIntegerAdd(aggregate.successCount, 1);
  aggregate.finalStatuses[run.finalStatus] = safeIntegerAdd(aggregate.finalStatuses[run.finalStatus], 1);
  aggregate.contractPassed = safeIntegerAdd(aggregate.contractPassed, run.contractChecks.passed);
  aggregate.contractFailed = safeIntegerAdd(aggregate.contractFailed, run.contractChecks.failed);
  aggregate.contractSkipped = safeIntegerAdd(aggregate.contractSkipped, run.contractChecks.skipped);
  addEvidenceInteger(aggregate.wallTimeMs, run.durationMs);
  addEvidenceInteger(aggregate.failureLocalizationMs, run.failureLocalizationMs);
  addEvidenceInteger(aggregate.inputTokens, run.usage.inputTokens);
  addEvidenceInteger(aggregate.outputTokens, run.usage.outputTokens);
  addEvidenceInteger(aggregate.cacheReadTokens, run.usage.cacheReadTokens);
  addEvidenceInteger(aggregate.cacheWriteTokens, run.usage.cacheWriteTokens);
  addEvidenceDecimal(aggregate.estimatedCostUsd, run.cost.estimatedUsd);
  addEvidenceDecimal(aggregate.observedCostUsd, run.cost.observedUsd);
  aggregate.redundantNodeExecutions = safeIntegerAdd(aggregate.redundantNodeExecutions, run.redundantNodeExecutions);
  aggregate.failedNodeExecutions = safeIntegerAdd(
    aggregate.failedNodeExecutions,
    run.parallelism.failedNodeCount,
  );
  aggregate.skippedNodeExecutions = safeIntegerAdd(
    aggregate.skippedNodeExecutions,
    run.parallelism.skippedNodeCount,
  );
  aggregate.conflictingNodeExecutions = safeIntegerAdd(
    aggregate.conflictingNodeExecutions,
    run.parallelism.conflictingNodeCount,
  );
  aggregate.retryCount = safeIntegerAdd(aggregate.retryCount, run.retryCount);
  aggregate.fallbackCount = safeIntegerAdd(aggregate.fallbackCount, run.fallbackCount);
  aggregate.buildPasses = safeIntegerAdd(aggregate.buildPasses, run.buildPasses);
  aggregate.maxReadySetWidth = Math.max(aggregate.maxReadySetWidth, run.maxReadySetWidth);
  if (run.laterRejection) aggregate.laterRejectionRuns = safeIntegerAdd(aggregate.laterRejectionRuns, 1);
  if (run.humanOverride) aggregate.humanOverrideRuns = safeIntegerAdd(aggregate.humanOverrideRuns, 1);
  if (run.firstPassVerification !== "unknown") {
    aggregate.firstPassKnown = safeIntegerAdd(aggregate.firstPassKnown, 1);
    if (run.firstPassVerification) aggregate.firstPassSuccesses = safeIntegerAdd(aggregate.firstPassSuccesses, 1);
  }
  aggregate.recoverySuccesses = safeIntegerAdd(aggregate.recoverySuccesses, run.recoverySuccesses);
  aggregate.recoveryAttempts = safeIntegerAdd(aggregate.recoveryAttempts, run.recoveryAttempts);
  aggregate.graphVersions.set(run.graphVersion, safeIntegerAdd(aggregate.graphVersions.get(run.graphVersion) ?? 0, 1));
  aggregate.planVersions.set(run.planVersion, safeIntegerAdd(aggregate.planVersions.get(run.planVersion) ?? 0, 1));
  aggregate.recoveryLevels[run.recoveryLevel] = safeIntegerAdd(aggregate.recoveryLevels[run.recoveryLevel], 1);
  aggregate.traceStatuses[run.traceCompleteness] = safeIntegerAdd(aggregate.traceStatuses[run.traceCompleteness], 1);
  for (const validator of run.validatorTypes) {
    aggregate.validatorTypes.set(validator, safeIntegerAdd(aggregate.validatorTypes.get(validator) ?? 0, 1));
  }
  if (run.buildPasses > 1) aggregate.failureLoopRuns = safeIntegerAdd(aggregate.failureLoopRuns, 1);
  if (run.traceCompleteness === "complete") aggregate.completeTraceRuns = safeIntegerAdd(aggregate.completeTraceRuns, 1);
  addUsefulParallelism(aggregate, run);
}

function addUsefulParallelism(aggregate: MutableAggregate, run: GraphRunEvidenceEvent): void {
  const parallelism = run.parallelism;
  if (run.finalStatus !== "done"
    || run.traceCompleteness !== "complete"
    || run.nodeExecutions < 2
    || run.maxReadySetWidth < 2
    || parallelism.mode === "none"
    || !parallelism.executedConcurrently
    || typeof parallelism.summedNodeDurationMs !== "number"
    || typeof parallelism.criticalPathDurationMs !== "number") return;
  aggregate.parallelEligibleRuns = safeIntegerAdd(aggregate.parallelEligibleRuns, 1);
  if (!isUsefulParallelRun(run)) return;
  aggregate.usefulRuns = safeIntegerAdd(aggregate.usefulRuns, 1);
  aggregate.criticalPathSavingsMs = safeIntegerAdd(
    aggregate.criticalPathSavingsMs,
    parallelism.summedNodeDurationMs - parallelism.criticalPathDurationMs,
  );
}

function isUsefulParallelRun(run: GraphRunEvidenceEvent): boolean {
  const parallelism = run.parallelism;
  return run.finalStatus === "done"
    && run.traceCompleteness === "complete"
    && run.nodeExecutions >= 2
    && run.maxReadySetWidth >= 2
    && parallelism.mode !== "none"
    && parallelism.executedConcurrently
    && typeof parallelism.summedNodeDurationMs === "number"
    && typeof parallelism.criticalPathDurationMs === "number"
    && parallelism.criticalPathDurationMs < parallelism.summedNodeDurationMs
    && parallelism.failedNodeCount === 0
    && parallelism.skippedNodeCount === 0
    && parallelism.conflictingNodeCount === 0
    && run.redundantNodeExecutions === 0
    && run.contractChecks.failed === 0
    && run.contractChecks.skipped === 0;
}

function emptyTotal(): MutableKnownUnknownTotal {
  return { total: 0, knownSamples: 0, unknownSamples: 0 };
}

function addEvidenceInteger(total: MutableKnownUnknownTotal, value: GraphEvidenceNumber): void {
  if (value === "unknown") total.unknownSamples = safeIntegerAdd(total.unknownSamples, 1);
  else {
    total.knownSamples = safeIntegerAdd(total.knownSamples, 1);
    total.total = safeIntegerAdd(total.total, value);
  }
}

function addEvidenceDecimal(total: MutableKnownUnknownTotal, value: GraphEvidenceNumber): void {
  if (value === "unknown") total.unknownSamples = safeIntegerAdd(total.unknownSamples, 1);
  else {
    total.knownSamples = safeIntegerAdd(total.knownSamples, 1);
    total.total = safeDecimalAdd(total.total, value);
  }
}

function finishTotal(total: MutableKnownUnknownTotal): KnownUnknownTotal {
  return { ...total };
}

function rate(numerator: number, denominator: number): number | "unknown" {
  return denominator === 0 ? "unknown" : Math.round((numerator / denominator) * 10_000);
}

function decisionRate(
  numerator: number,
  denominator: number,
  available: boolean,
): number | "unknown" {
  return available ? rate(numerator, denominator) : "unknown";
}

function compareRunEvidence(left: GraphRunEvidenceEvent, right: GraphRunEvidenceEvent): number {
  return ENGINE_GROUPS.indexOf(left.engineGroup) - ENGINE_GROUPS.indexOf(right.engineGroup)
    || TASK_CATEGORIES.indexOf(left.taskCategory) - TASK_CATEGORIES.indexOf(right.taskCategory)
    || compareCodeUnits(left.runId, right.runId)
    || left.sequence - right.sequence;
}

function validateReportOptions(options: unknown): asserts options is GraphEvidenceReportOptions {
  if (!isRecord(options) || hasUnexpectedKey(options, ["minimumCohortRuns", "experimentManifest"])) {
    throw new GraphEvidenceError("invalid-report-options");
  }
  if (options.minimumCohortRuns !== undefined
    && (!Number.isInteger(options.minimumCohortRuns)
      || (options.minimumCohortRuns as number) < 10
      || (options.minimumCohortRuns as number) > 10_000)) {
    throw new GraphEvidenceError("invalid-report-options");
  }
}

function reportEventArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new GraphEvidenceError("invalid-event");
  }
  if (value.length > MAX_EVENTS) throw new GraphEvidenceError("too-many-events");
  const result: unknown[] = [];
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key !== "string" || (key !== "length" && !isArrayIndex(key, value.length))) {
      throw new GraphEvidenceError("invalid-event");
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor)) throw new GraphEvidenceError("invalid-event");
    result.push(descriptor.value);
  }
  return result;
}

interface AblationCoverage {
  allEngineGroups: boolean;
  allTaskCategories: boolean;
  completeMatrix: boolean;
  sufficientSamples: boolean;
  sufficientDistinctCases: boolean;
}

function assessAblationCoverage(
  runs: readonly GraphRunEvidenceEvent[],
  minimumCohortRuns: number,
): AblationCoverage {
  const observedEngineGroups = new Set<GraphEngineGroup>();
  const observedTaskCategories = new Set<GraphTaskCategory>();
  const runCounts = new Map<string, number>();
  const distinctCases = new Map<string, Set<string>>();
  for (const run of runs) {
    if (run.traceCompleteness !== "complete") continue;
    observedEngineGroups.add(run.engineGroup);
    observedTaskCategories.add(run.taskCategory);
    const key = cohortKey(run.engineGroup, run.taskCategory);
    runCounts.set(key, safeIntegerAdd(runCounts.get(key) ?? 0, 1));
    const cases = distinctCases.get(key) ?? new Set<string>();
    cases.add(run.corpusCaseId);
    distinctCases.set(key, cases);
  }

  let completeMatrix = true;
  let sufficientDistinctCases = true;
  for (const engineGroup of ENGINE_GROUPS) {
    for (const taskCategory of TASK_CATEGORIES) {
      const key = cohortKey(engineGroup, taskCategory);
      if ((runCounts.get(key) ?? 0) < minimumCohortRuns) completeMatrix = false;
      if ((distinctCases.get(key)?.size ?? 0) < minimumCohortRuns) sufficientDistinctCases = false;
    }
  }

  return {
    allEngineGroups: ENGINE_GROUPS.every((engineGroup) => observedEngineGroups.has(engineGroup)),
    allTaskCategories: TASK_CATEGORIES.every((taskCategory) => observedTaskCategories.has(taskCategory)),
    completeMatrix,
    sufficientSamples: completeMatrix,
    sufficientDistinctCases,
  };
}

function cohortKey(engineGroup: GraphEngineGroup, taskCategory: GraphTaskCategory): string {
  return `${engineGroup}\u0000${taskCategory}`;
}

function hasPairedBaselineCorpus(runs: readonly GraphRunEvidenceEvent[]): boolean {
  if (runs.length === 0) return true;
  const baselineCases = new Map<string, number>();
  const comparisonGroups = new Map<string, Map<string, number>>();
  for (const run of runs) {
    if (run.engineGroup === "G0" && run.traceCompleteness === "complete") {
      const caseKey = `${run.taskCategory}\u0000${run.corpusCaseId}`;
      baselineCases.set(caseKey, safeIntegerAdd(baselineCases.get(caseKey) ?? 0, 1));
    }
  }
  for (const run of runs) {
    if (run.engineGroup === "G0") continue;
    if (run.traceCompleteness !== "complete") return false;
    const groupKey = `${run.engineGroup}\u0000${run.taskCategory}`;
    const cases = comparisonGroups.get(groupKey) ?? new Map<string, number>();
    const caseKey = `${run.taskCategory}\u0000${run.corpusCaseId}`;
    cases.set(caseKey, safeIntegerAdd(cases.get(caseKey) ?? 0, 1));
    comparisonGroups.set(groupKey, cases);
  }
  if (comparisonGroups.size === 0) return false;
  for (const [groupKey, cases] of comparisonGroups) {
    const taskCategory = groupKey.slice(groupKey.indexOf("\u0000") + 1);
    const categoryBaselines = [...baselineCases.entries()]
      .filter(([caseKey]) => caseKey.startsWith(`${taskCategory}\u0000`));
    if (categoryBaselines.length === 0 || cases.size !== categoryBaselines.length) return false;
    for (const [caseKey, baselineCount] of categoryBaselines) {
      if (cases.get(caseKey) !== baselineCount) return false;
    }
  }
  return true;
}

function eventRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) fail("not-object");
  return value;
}

function nestedRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) fail("not-object");
  if (hasUnexpectedKey(value, allowed)) fail("unexpected-field");
  return value;
}

function hasUnexpectedKey(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedSet.has(key)) return true;
  }
  return false;
}

function opaqueIdentifier(value: unknown): asserts value is string {
  if (typeof value !== "string"
    || (!SHA256_IDENTIFIER.test(value) && !UUID_IDENTIFIER.test(value))) fail("invalid-token");
}

function semanticVersion(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > MAX_VERSION_LENGTH || !SEMVER.test(value)) fail("invalid-token");
}

function isoTime(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > MAX_TIMESTAMP_LENGTH) fail("invalid-time");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) fail("invalid-time");
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail("invalid-enum");
}

function enumArray<T extends string>(value: unknown, allowed: readonly T[], maximum: number): asserts value is T[] {
  if (!Array.isArray(value) || value.length > maximum) fail("unbounded-array");
  if (Object.getPrototypeOf(value) !== Array.prototype) fail("not-object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key !== "string" || (key !== "length" && !isArrayIndex(key, value.length))) fail("not-object");
  }
  let previousIndex = -1;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor)) fail("not-object");
    enumValue(descriptor.value, allowed);
    const allowedIndex = allowed.indexOf(descriptor.value as T);
    if (allowedIndex === previousIndex) fail("duplicate-array-value");
    if (allowedIndex < previousIndex) fail("inconsistent-metrics");
    previousIndex = allowedIndex;
  }
}

function evidenceNumber(value: unknown, maximum: number): asserts value is GraphEvidenceNumber {
  if (value === "unknown") return;
  if (typeof value !== "number"
    || !Number.isFinite(value)
    || value < 0
    || value > maximum
    || !Number.isSafeInteger(value * 100_000_000)) fail("invalid-number");
}

function evidenceInteger(value: unknown, maximum: number): asserts value is GraphEvidenceNumber {
  if (value === "unknown") return;
  boundedInteger(value, 0, maximum);
}

function boundedInteger(value: unknown, minimum: number, maximum: number): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) fail("invalid-number");
}

function booleanValue(value: unknown): asserts value is boolean {
  if (typeof value !== "boolean") fail("invalid-boolean");
}

function fail(code: GraphEvidenceValidationError): never {
  throw new EventValidationFailure(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => "value" in descriptor);
}

function isArrayIndex(value: string, length: number): boolean {
  if (!/^(0|[1-9]\d*)$/.test(value)) return false;
  const index = Number(value);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === value;
}

function strictRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): Record<string, unknown> {
  if (!isRecord(value) || hasUnexpectedKey(value, allowed)) {
    throw new GraphEvidenceError("invalid-experiment-manifest");
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new GraphEvidenceError("invalid-experiment-manifest");
    }
  }
  return value;
}

function plainDataArray(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum) {
    throw new GraphEvidenceError("invalid-experiment-manifest");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || (key !== "length" && !isArrayIndex(key, value.length))) {
      throw new GraphEvidenceError("invalid-experiment-manifest");
    }
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor)) {
      throw new GraphEvidenceError("invalid-experiment-manifest");
    }
    result.push(descriptor.value);
  }
  return result;
}

function sameFeatureVector(left: GraphEngineFeatureVector, right: GraphEngineFeatureVector): boolean {
  return left.graphDeclarations === right.graphDeclarations
    && left.activeOuterGraph === right.activeOuterGraph
    && left.durableScheduler === right.durableScheduler
    && left.immutableBuildDag === right.immutableBuildDag
    && left.typedRecovery === right.typedRecovery
    && left.isolatedParallelBuild === right.isolatedParallelBuild;
}

function canonicalJson(value: unknown): string {
  return canonicalValue(value);
}

function canonicalValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new GraphEvidenceError("invalid-experiment-manifest");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const entries = plainDataArray(value, MAX_EVENTS);
    return `[${entries.map(canonicalValue).join(",")}]`;
  }
  if (!isRecord(value)) throw new GraphEvidenceError("invalid-experiment-manifest");
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    throw new GraphEvidenceError("invalid-experiment-manifest");
  }
  const stringKeys = (keys as string[]).sort(compareCodeUnits);
  return `{${stringKeys.map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function safeIntegerAdd(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) {
    throw new GraphEvidenceError("aggregate-overflow");
  }
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new GraphEvidenceError("aggregate-overflow");
  return result;
}

function safeDecimalAdd(left: number, right: number): number {
  const leftScaled = scaledEvidenceDecimal(left);
  const rightScaled = scaledEvidenceDecimal(right);
  return safeIntegerAdd(leftScaled, rightScaled) / DECIMAL_SCALE;
}

function roundEvidenceDecimal(value: number): number {
  return scaledEvidenceDecimal(value) / DECIMAL_SCALE;
}

function scaledEvidenceDecimal(value: number): number {
  if (!Number.isFinite(value)) throw new GraphEvidenceError("aggregate-overflow");
  const scaled = Math.round(value * DECIMAL_SCALE);
  if (!Number.isSafeInteger(scaled)) throw new GraphEvidenceError("aggregate-overflow");
  return scaled;
}
