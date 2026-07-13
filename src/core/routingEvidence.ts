import type { RoutingStage, TaskFeatures } from "./modelRouting.js";

export type EvidenceNumber = number | "unknown";
export type RoutingEvidenceOutcomeType = "stage-started" | "stage-ended" | "routing-fallback" | "human-override" | "final-status";
export type RoutingEvidenceVerdict = "approve" | "reject" | "unknown";
export type RoutingEvidenceFinalStatus = "done" | "failed" | "cancelled" | "unknown";

export interface EvidenceModelIdentity {
  provider: string;
  model: string;
  family?: string;
}

export interface RoutingEvidenceEvent {
  version: 1;
  eventId: string;
  runId: string;
  decisionId: string;
  stage: RoutingStage;
  recordedAt: string;
  policyVersion: string;
  profileVersion: string;
  task: Pick<TaskFeatures, "workKind" | "risk" | "languages" | "fileCount">;
  selected: EvidenceModelIdentity;
  durationMs?: EvidenceNumber;
  fallbackCount?: number;
  rejectionCategory?: string;
  fallback?: {
    from: EvidenceModelIdentity;
    reason: "unavailable" | "unconfigured" | "selection-failed" | "policy-mismatch";
  };
  usage: {
    inputTokens: EvidenceNumber;
    outputTokens: EvidenceNumber;
    cacheReadTokens: EvidenceNumber;
    cacheWriteTokens: EvidenceNumber;
  };
  cost: {
    estimatedUsd: EvidenceNumber;
    observedUsd: EvidenceNumber;
  };
  outcome: {
    type: RoutingEvidenceOutcomeType;
    structuredToolCompliance?: boolean | "unknown";
    verdict?: RoutingEvidenceVerdict;
    laterReversal?: boolean;
    buildIteration: number;
    humanOverride?: boolean;
    finalRunStatus?: RoutingEvidenceFinalStatus;
  };
}

export interface RoutingEvidenceValidation {
  ok: boolean;
  event?: RoutingEvidenceEvent;
  error?: string;
}

export interface StageEvidenceAggregate {
  events: number;
  approvals: number;
  rejections: number;
  reversals: number;
  humanOverrides: number;
  estimatedCostUsd: number;
  observedCostUsd: number;
  unknownEstimatedCostCount: number;
  unknownObservedCostCount: number;
}

export interface RoutingEvidenceAggregate {
  totalEvents: number;
  byStage: Partial<Record<RoutingStage, StageEvidenceAggregate>>;
  byModel: Record<string, StageEvidenceAggregate>;
}

export interface RoutingPolicyRecommendation {
  stage: RoutingStage;
  taskCategory: string;
  sampleCount: number;
  uncertainty: string;
  downstreamEvidence: string;
  expectedTradeoff: string;
  recommendedChange:
    | { kind: "prefer-model"; provider: string; model: string }
    | { kind: "adjust-weight"; capability: string; deltaBasisPoints: number }
    | { kind: "cost-mode"; mode: "quality" | "balanced" | "economy" };
  rollback: string;
}

export interface ShadowPolicyComparisonInput {
  stage: RoutingStage;
  selected: EvidenceModelIdentity;
  alternate?: EvidenceModelIdentity;
  selectedEstimatedCostUsd?: EvidenceNumber;
  alternateEstimatedCostUsd?: EvidenceNumber;
  observedOutcome?: {
    verdict?: RoutingEvidenceVerdict;
    finalRunStatus?: RoutingEvidenceFinalStatus;
  };
}

export interface ShadowPolicyComparison {
  stage: RoutingStage;
  sameChoice: boolean;
  selected: string;
  alternate?: string;
  expectedCostDeltaUsd?: number;
  observedOutcome?: ShadowPolicyComparisonInput["observedOutcome"];
  qualityClaim: "not-counterfactual";
}

const DISALLOWED_KEYS = new Set([
  "prompt",
  "source",
  "diff",
  "patch",
  "artifact",
  "credential",
  "credentials",
  "headers",
  "remoteUrl",
  "repositoryRemoteUrl",
]);

const ROUTING_STAGES = new Set<RoutingStage>(["define", "plan", "build", "verify", "debug", "review", "ship", "fast-judge"]);

export function validateRoutingEvidenceEvent(value: unknown): RoutingEvidenceValidation {
  const forbidden = findDisallowedKey(value);
  if (forbidden) return { ok: false, error: `routing evidence contains disallowed field ${forbidden}` };
  if (!isRecord(value)) return { ok: false, error: "routing evidence event must be an object" };
  const unexpected = unexpectedEvidenceField(value);
  if (unexpected) return { ok: false, error: `routing evidence contains unexpected field ${unexpected}` };
  if (value.version !== 1) return { ok: false, error: "routing evidence event version must be 1" };
  for (const key of ["eventId", "runId", "decisionId", "recordedAt", "policyVersion", "profileVersion"] as const) {
    if (typeof value[key] !== "string" || value[key].length === 0) return { ok: false, error: `${key} must be a non-empty string` };
  }
  if (typeof value.stage !== "string" || !ROUTING_STAGES.has(value.stage as RoutingStage)) {
    return { ok: false, error: "stage must be a routing stage" };
  }
  if (!isModelIdentity(value.selected)) return { ok: false, error: "selected model identity is invalid" };
  if (value.durationMs !== undefined && !isEvidenceNumber(value.durationMs)) return { ok: false, error: "durationMs is invalid" };
  if (value.fallbackCount !== undefined && (!Number.isInteger(value.fallbackCount) || (value.fallbackCount as number) < 0)) return { ok: false, error: "fallbackCount is invalid" };
  if (value.rejectionCategory !== undefined && (typeof value.rejectionCategory !== "string" || value.rejectionCategory.length === 0)) return { ok: false, error: "rejectionCategory is invalid" };
  if (!isUsage(value.usage)) return { ok: false, error: "usage is invalid" };
  if (!isCost(value.cost)) return { ok: false, error: "cost is invalid" };
  if (!isTaskSummary(value.task)) return { ok: false, error: "task summary is invalid" };
  if (!isOutcome(value.outcome)) return { ok: false, error: "outcome is invalid" };
  if (value.fallback !== undefined && !isFallback(value.fallback)) return { ok: false, error: "fallback is invalid" };
  return { ok: true, event: value as unknown as RoutingEvidenceEvent };
}

export function aggregateRoutingEvidence(events: readonly RoutingEvidenceEvent[]): RoutingEvidenceAggregate {
  const byStage: Partial<Record<RoutingStage, StageEvidenceAggregate>> = {};
  const byModel: Record<string, StageEvidenceAggregate> = {};
  for (const event of events) {
    addToAggregate(byStage[event.stage] ??= emptyStageAggregate(), event);
    addToAggregate(byModel[identityKey(event.selected)] ??= emptyStageAggregate(), event);
  }
  return { totalEvents: events.length, byStage, byModel };
}

export function recommendRoutingPolicyChanges(
  events: readonly RoutingEvidenceEvent[],
  options: { minimumSamples?: number } = {},
): RoutingPolicyRecommendation[] {
  const minimumSamples = options.minimumSamples ?? 10;
  const latestByDecision = new Map<string, RoutingEvidenceEvent>();
  for (const event of events) {
    if (event.outcome.type !== "stage-ended") continue;
    const previous = latestByDecision.get(event.decisionId);
    if (!previous || event.recordedAt >= previous.recordedAt || event.outcome.laterReversal || event.outcome.humanOverride) {
      latestByDecision.set(event.decisionId, event);
    }
  }
  const groups = new Map<string, RoutingEvidenceEvent[]>();
  for (const event of latestByDecision.values()) {
    const key = `${event.stage}\u0000${event.task.workKind}\u0000${event.task.risk}\u0000${event.policyVersion}\u0000${event.profileVersion}`;
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }

  const recommendations: RoutingPolicyRecommendation[] = [];
  for (const [key, group] of groups) {
    if (group.length < minimumSamples) continue;
    const [stage, workKind, risk] = key.split("\u0000") as [RoutingStage, string, string, string, string];
    const modelStats = new Map<string, { model: EvidenceModelIdentity; count: number; successes: number; reversals: number; overrides: number; cost: number }>();
    for (const event of group) {
      const identity = identityKey(event.selected);
      const stats = modelStats.get(identity) ?? { model: event.selected, count: 0, successes: 0, reversals: 0, overrides: 0, cost: 0 };
      stats.count += 1;
      if (event.outcome.laterReversal) stats.reversals += 1;
      if (event.outcome.humanOverride) stats.overrides += 1;
      const initiallySuccessful = event.outcome.verdict === "approve" || event.outcome.finalRunStatus === "done";
      if (initiallySuccessful && !event.outcome.laterReversal && !event.outcome.humanOverride) stats.successes += 1;
      if (typeof event.cost.observedUsd === "number") stats.cost += event.cost.observedUsd;
      modelStats.set(identity, stats);
    }
    const ranked = [...modelStats.values()].sort((left, right) => {
      const leftRate = left.successes / left.count;
      const rightRate = right.successes / right.count;
      if (rightRate !== leftRate) return rightRate - leftRate;
      return left.cost / left.count - right.cost / right.count;
    });
    const best = ranked[0];
    const second = ranked[1];
    if (!best || !second) continue;
    const bestRate = best.successes / best.count;
    const secondRate = second.successes / second.count;
    if (bestRate - secondRate < 0.15) continue;
    recommendations.push({
      stage,
      taskCategory: `${workKind}/${risk}`,
      sampleCount: group.length,
      uncertainty: `simple approval-rate band: ${Math.round(bestRate * 100)}% vs ${Math.round(secondRate * 100)}% across ${group.length} samples`,
      downstreamEvidence: `${best.successes}/${best.count} non-reversed, non-overridden downstream successes for ${identityKey(best.model)}; ${best.reversals} reversals; ${best.overrides} human overrides`,
      expectedTradeoff: `Prefer ${identityKey(best.model)}; average observed cost $${averageCost(best).toFixed(4)} versus $${averageCost(second).toFixed(4)} for next ranked observed model.`,
      recommendedChange: { kind: "prefer-model", provider: best.model.provider, model: best.model.model },
      rollback: `Remove ${identityKey(best.model)} from routing.stages.${stage}.prefer or restore the previous user config version.`,
    });
  }
  return recommendations;
}

export function compareRoutingPolicies(input: ShadowPolicyComparisonInput): ShadowPolicyComparison {
  const selected = identityKey(input.selected);
  const alternate = input.alternate ? identityKey(input.alternate) : undefined;
  const selectedCost = input.selectedEstimatedCostUsd;
  const alternateCost = input.alternateEstimatedCostUsd;
  return {
    stage: input.stage,
    selected,
    ...(alternate ? { alternate } : {}),
    sameChoice: alternate === undefined || selected === alternate,
    ...(typeof selectedCost === "number" && typeof alternateCost === "number"
      ? { expectedCostDeltaUsd: alternateCost - selectedCost }
      : {}),
    ...(input.observedOutcome ? { observedOutcome: input.observedOutcome } : {}),
    qualityClaim: "not-counterfactual",
  };
}

function addToAggregate(aggregate: StageEvidenceAggregate, event: RoutingEvidenceEvent): void {
  aggregate.events += 1;
  if (event.outcome.verdict === "approve" || event.outcome.finalRunStatus === "done") aggregate.approvals += 1;
  if (event.outcome.verdict === "reject" || event.outcome.finalRunStatus === "failed") aggregate.rejections += 1;
  if (event.outcome.laterReversal) aggregate.reversals += 1;
  if (event.outcome.humanOverride) aggregate.humanOverrides += 1;
  if (typeof event.cost.estimatedUsd === "number") aggregate.estimatedCostUsd += event.cost.estimatedUsd;
  else aggregate.unknownEstimatedCostCount += 1;
  if (typeof event.cost.observedUsd === "number") aggregate.observedCostUsd += event.cost.observedUsd;
  else aggregate.unknownObservedCostCount += 1;
}

function emptyStageAggregate(): StageEvidenceAggregate {
  return {
    events: 0,
    approvals: 0,
    rejections: 0,
    reversals: 0,
    humanOverrides: 0,
    estimatedCostUsd: 0,
    observedCostUsd: 0,
    unknownEstimatedCostCount: 0,
    unknownObservedCostCount: 0,
  };
}

function averageCost(value: { cost: number; count: number }): number {
  return value.count === 0 ? 0 : value.cost / value.count;
}

function isTaskSummary(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (value.workKind === "feature" || value.workKind === "bug-fix" || value.workKind === "refactor" ||
      value.workKind === "migration" || value.workKind === "test-only" || value.workKind === "documentation" ||
      value.workKind === "configuration" || value.workKind === "release" || value.workKind === "unknown") &&
    (value.risk === "low" || value.risk === "medium" || value.risk === "high") &&
    Array.isArray(value.languages) && value.languages.every((item) => typeof item === "string") &&
    Number.isInteger(value.fileCount) && (value.fileCount as number) >= 0;
}

function isModelIdentity(value: unknown): value is EvidenceModelIdentity {
  if (!isRecord(value)) return false;
  return typeof value.provider === "string" && value.provider.length > 0 &&
    typeof value.model === "string" && value.model.length > 0 &&
    (value.family === undefined || typeof value.family === "string");
}

function isFallback(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return isModelIdentity(value.from) &&
    (value.reason === "unavailable" || value.reason === "unconfigured" ||
      value.reason === "selection-failed" || value.reason === "policy-mismatch");
}

function isUsage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return isEvidenceNumber(value.inputTokens) && isEvidenceNumber(value.outputTokens) &&
    isEvidenceNumber(value.cacheReadTokens) && isEvidenceNumber(value.cacheWriteTokens);
}

function isCost(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return isEvidenceNumber(value.estimatedUsd) && isEvidenceNumber(value.observedUsd);
}

function isOutcome(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (value.type === "stage-started" || value.type === "stage-ended" || value.type === "routing-fallback" ||
      value.type === "human-override" || value.type === "final-status") &&
    (value.verdict === undefined || value.verdict === "approve" || value.verdict === "reject" || value.verdict === "unknown") &&
    (value.finalRunStatus === undefined || value.finalRunStatus === "done" || value.finalRunStatus === "failed" ||
      value.finalRunStatus === "cancelled" || value.finalRunStatus === "unknown") &&
    (value.structuredToolCompliance === undefined || typeof value.structuredToolCompliance === "boolean" || value.structuredToolCompliance === "unknown") &&
    (value.laterReversal === undefined || typeof value.laterReversal === "boolean") &&
    Number.isInteger(value.buildIteration) && (value.buildIteration as number) >= 0 &&
    (value.humanOverride === undefined || typeof value.humanOverride === "boolean");
}

function isEvidenceNumber(value: unknown): value is EvidenceNumber {
  return value === "unknown" || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function unexpectedEvidenceField(value: Record<string, unknown>): string | undefined {
  const top = unexpectedKey(value, ["version", "eventId", "runId", "decisionId", "stage", "recordedAt", "policyVersion", "profileVersion", "task", "selected", "durationMs", "fallbackCount", "rejectionCategory", "fallback", "usage", "cost", "outcome"]);
  if (top) return top;
  const nested: Array<[unknown, readonly string[], string]> = [
    [value.task, ["workKind", "risk", "languages", "fileCount"], "task"],
    [value.selected, ["provider", "model", "family"], "selected"],
    [value.usage, ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"], "usage"],
    [value.cost, ["estimatedUsd", "observedUsd"], "cost"],
    [value.outcome, ["type", "structuredToolCompliance", "verdict", "laterReversal", "buildIteration", "humanOverride", "finalRunStatus"], "outcome"],
  ];
  if (value.fallback !== undefined) nested.push([value.fallback, ["from", "reason"], "fallback"]);
  for (const [candidate, keys, prefix] of nested) {
    if (!isRecord(candidate)) continue;
    const extra = unexpectedKey(candidate, keys);
    if (extra) return `${prefix}.${extra}`;
  }
  if (isRecord(value.fallback) && isRecord(value.fallback.from)) {
    const extra = unexpectedKey(value.fallback.from, ["provider", "model", "family"]);
    if (extra) return `fallback.from.${extra}`;
  }
  return undefined;
}

function unexpectedKey(value: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  const allowedSet = new Set(allowed);
  return Object.keys(value).find((key) => !allowedSet.has(key));
}

function identityKey(identity: EvidenceModelIdentity): string {
  return `${identity.provider}/${identity.model}`;
}

function findDisallowedKey(value: unknown): string | undefined {
  if (!isRecord(value) && !Array.isArray(value)) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDisallowedKey(item);
      if (found) return found;
    }
    return undefined;
  }
  for (const [key, child] of Object.entries(value)) {
    if (DISALLOWED_KEYS.has(key)) return key;
    const found = findDisallowedKey(child);
    if (found) return found;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
