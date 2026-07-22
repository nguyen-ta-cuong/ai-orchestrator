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

interface GraphEvidenceBase {
  schemaVersion: 1;
  /** Canonical SHA-256 digest or UUID; never a task, path, or provider label. */
  eventId: string;
  runId: string;
  /** Stable opaque identity shared by the same sanitized corpus case across ablation groups. */
  corpusCaseId: string;
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
  /** True only for complete, paired, known-cost cohorts above the hard sample floor. */
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
}

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
  decision: "enable-sequential-graph" | "enable-graph-dag";
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

export const GRAPH_ENGINE_GROUP_DESCRIPTIONS: Readonly<Record<GraphEngineGroup, string>> = Object.freeze({
  G0: "legacy-loop",
  G1: "graph-declarations-shadow",
  G2: "outer-graph-sequential-build",
  G3: "durable-scheduler-checkpoints",
  G4: "immutable-build-dag-sequential-writes",
  G5: "typed-recovery-and-replan",
  G6: "worktree-isolated-parallel-build",
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

export function buildGraphEvidenceReport(
  values: readonly unknown[],
  options: GraphEvidenceReportOptions = {},
): GraphEvidenceReport {
  validateReportOptions(options);
  const inputEvents = reportEventArray(values);
  const events: GraphEvidenceEvent[] = [];
  for (const value of inputEvents) {
    const validation = validateGraphEvidenceEvent(value);
    if (!validation.ok) throw new GraphEvidenceError("invalid-event");
    events.push(validation.event);
  }
  validateLedger(events);

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
  return {
    schemaVersion: 1,
    qualityClaim: "observed-executions-only",
    rolloutDecisionEligible: !limitations.some((limitation) => rolloutBlockingLimitations.includes(limitation)),
    eventCount: events.length,
    stageEventCount: events.length - runs.length,
    runCount: runs.length,
    totals: aggregateRuns(runs, decisionRatesAvailable),
    cohorts,
    limitations,
  };
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
  if (!value.rolloutReport) missing.push("decision-ready-rollout-report");
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
  if (rollout && value.decision !== "enable-sequential-graph" && value.decision !== "enable-graph-dag") {
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
  boundedInteger(event.readySetWidth, 1, MAX_COUNT);
  boundedInteger(event.retryCount, 0, MAX_COUNT);
  boundedInteger(event.fallbackCount, 0, MAX_COUNT);
  enumValue(event.recoveryLevel, RECOVERY_LEVELS);
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

function validateLedger(events: readonly GraphEvidenceEvent[]): void {
  const eventIds = new Set<string>();
  const sequencesByRun = new Map<string, Set<number>>();
  const summariesByRun = new Map<string, GraphRunEvidenceEvent>();
  const eventsByRun = new Map<string, GraphEvidenceEvent[]>();
  for (const event of events) {
    if (eventIds.has(event.eventId)) throw new GraphEvidenceError("duplicate-event-id");
    eventIds.add(event.eventId);
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
        || event.planVersion !== summary.planVersion
        || event.corpusCaseId !== summary.corpusCaseId) {
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
  let laterRejection = false;
  let recoveryLevel: GraphRecoveryLevel = "none";

  for (const stage of stages) {
    nodeIds.add(stage.nodeId);
    for (const validator of stage.validatorTypes) validators.add(validator);
    if (stage.contractStatus === "unknown") throw new GraphEvidenceError("inconsistent-run-trace");
    contracts[stage.contractStatus] = safeIntegerAdd(contracts[stage.contractStatus], 1);
    maxReadySetWidth = Math.max(maxReadySetWidth, stage.readySetWidth);
    retryCount = safeIntegerAdd(retryCount, stage.retryCount);
    fallbackCount = safeIntegerAdd(fallbackCount, stage.fallbackCount);
    if (stage.stage === "build") buildPasses = Math.max(buildPasses, stage.attempt);
    if (stage.status === "failed") failedNodeCount = safeIntegerAdd(failedNodeCount, 1);
    if (stage.status === "skipped") skippedNodeCount = safeIntegerAdd(skippedNodeCount, 1);
    if (stage.recoveryLevel !== "none") {
      recoveryAttempts = safeIntegerAdd(recoveryAttempts, 1);
      if (stage.status === "succeeded" && stage.contractStatus === "passed") {
        recoverySuccesses = safeIntegerAdd(recoverySuccesses, 1);
      }
    }
    if (stage.stage === "verify" && firstPassVerification === "unknown") {
      firstPassVerification = stage.attempt === 1
        && stage.status === "succeeded"
        && stage.contractStatus === "passed";
    }
    if (stage.stage === "verify" || stage.stage === "review" || stage.stage === "fast-judge") {
      const accepted = stage.status === "succeeded" && stage.contractStatus === "passed";
      if (acceptedCheckerSeen && !accepted) laterRejection = true;
      if (accepted) acceptedCheckerSeen = true;
    }
    if (RECOVERY_LEVELS.indexOf(stage.recoveryLevel) > RECOVERY_LEVELS.indexOf(recoveryLevel)) {
      recoveryLevel = stage.recoveryLevel;
    }
  }

  const expectedValidators = VALIDATORS.filter((validator) => validators.has(validator));
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
  addEvidenceNumber(aggregate.wallTimeMs, run.durationMs);
  addEvidenceNumber(aggregate.failureLocalizationMs, run.failureLocalizationMs);
  addEvidenceNumber(aggregate.inputTokens, run.usage.inputTokens);
  addEvidenceNumber(aggregate.outputTokens, run.usage.outputTokens);
  addEvidenceNumber(aggregate.cacheReadTokens, run.usage.cacheReadTokens);
  addEvidenceNumber(aggregate.cacheWriteTokens, run.usage.cacheWriteTokens);
  addEvidenceNumber(aggregate.estimatedCostUsd, run.cost.estimatedUsd);
  addEvidenceNumber(aggregate.observedCostUsd, run.cost.observedUsd);
  aggregate.redundantNodeExecutions = safeIntegerAdd(aggregate.redundantNodeExecutions, run.redundantNodeExecutions);
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
  if (parallelism.criticalPathDurationMs >= parallelism.summedNodeDurationMs
    || parallelism.failedNodeCount > 0
    || parallelism.skippedNodeCount > 0
    || parallelism.conflictingNodeCount > 0
    || run.redundantNodeExecutions > 0
    || run.contractChecks.failed > 0
    || run.contractChecks.skipped > 0) return;
  aggregate.usefulRuns = safeIntegerAdd(aggregate.usefulRuns, 1);
  aggregate.criticalPathSavingsMs = safeIntegerAdd(
    aggregate.criticalPathSavingsMs,
    parallelism.summedNodeDurationMs - parallelism.criticalPathDurationMs,
  );
}

function emptyTotal(): MutableKnownUnknownTotal {
  return { total: 0, knownSamples: 0, unknownSamples: 0 };
}

function addEvidenceNumber(total: MutableKnownUnknownTotal, value: GraphEvidenceNumber): void {
  if (value === "unknown") total.unknownSamples = safeIntegerAdd(total.unknownSamples, 1);
  else {
    total.knownSamples = safeIntegerAdd(total.knownSamples, 1);
    total.total = safeDecimalAdd(total.total, value);
  }
}

function finishTotal(total: MutableKnownUnknownTotal): KnownUnknownTotal {
  return { ...total, total: roundEvidenceDecimal(total.total) };
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
  if (!isRecord(options) || hasUnexpectedKey(options, ["minimumCohortRuns"])) {
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
  if (typeof value !== "string") fail("invalid-time");
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
  const result = roundEvidenceDecimal(left + right);
  if (!Number.isFinite(result) || Math.abs(result) > Number.MAX_SAFE_INTEGER) {
    throw new GraphEvidenceError("aggregate-overflow");
  }
  return result;
}

function roundEvidenceDecimal(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}
