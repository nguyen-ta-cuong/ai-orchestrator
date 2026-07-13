import type { ThinkingLevel } from "./config.js";
import type { DiscoveredModel, RoutingStage, TaskFeatures } from "./modelRouting.js";

export interface RoutingBudgets {
  maxEstimatedUsdPerStage: number;
  maxEstimatedUsdPerRun: number;
  maxObservedUsdPerRun: number;
  maxEstimatedUsdPerDay: number;
  maxObservedUsdPerDay: number;
  maxPaidFallbacksPerRun: number;
  allowUnknownCost: boolean;
}

export interface RoutingCircuitBreakers {
  maxSelectionFailures: number;
  repeatedRejectionFingerprintLimit: number;
  maxBuildPassesWithoutImprovement: number;
  requireIndependentChecker: boolean;
}

export interface RoutingBudgetSnapshot {
  estimatedRunUsd: number;
  observedRunUsd: number;
  estimatedDayUsd: number;
  observedDayUsd: number;
  paidFallbacks: number;
  attemptsByStage: Partial<Record<RoutingStage, number>>;
}

export type RoutingCostEstimate =
  | { status: "known"; estimatedUsd: number }
  | { status: "unknown"; reason: string };

export type ObservedRoutingCost =
  | { status: "known"; observedUsd: number }
  | { status: "unknown"; reason: string };

export type RoutingBudgetDecision =
  | { allowed: true; reason: string }
  | { allowed: "ask"; reason: string }
  | { allowed: false; reason: string };

export const DEFAULT_ROUTING_BUDGETS: RoutingBudgets = {
  maxEstimatedUsdPerStage: 3,
  maxEstimatedUsdPerRun: 8,
  maxObservedUsdPerRun: 8,
  maxEstimatedUsdPerDay: 24,
  maxObservedUsdPerDay: 24,
  maxPaidFallbacksPerRun: 2,
  allowUnknownCost: true,
};

export const DEFAULT_ROUTING_CIRCUIT_BREAKERS: RoutingCircuitBreakers = {
  maxSelectionFailures: 3,
  repeatedRejectionFingerprintLimit: 2,
  maxBuildPassesWithoutImprovement: 3,
  requireIndependentChecker: true,
};

const THINKING_MULTIPLIER: Record<ThinkingLevel, number> = {
  off: 1,
  minimal: 1.02,
  low: 1.05,
  medium: 1.1,
  high: 1.2,
  xhigh: 1.35,
  max: 1.5,
};

export function estimateRoutingStageCost(input: {
  task: TaskFeatures;
  model: Pick<DiscoveredModel, "cost">;
  thinking: ThinkingLevel;
}): RoutingCostEstimate {
  if (!input.model.cost) return { status: "unknown", reason: "model cost metadata unavailable" };
  const multiplier = THINKING_MULTIPLIER[input.thinking];
  const estimatedUsd = ((input.task.contextTokens * input.model.cost.input) +
    (input.task.expectedOutputTokens * input.model.cost.output * multiplier)) / 1_000_000;
  return { status: "known", estimatedUsd: roundUsd(estimatedUsd) };
}

export function enforceRoutingBudget(input: {
  stage: RoutingStage;
  estimate: RoutingCostEstimate;
  budgets: RoutingBudgets;
  snapshot: RoutingBudgetSnapshot;
  unattended: boolean;
}): RoutingBudgetDecision {
  const attempts = input.snapshot.attemptsByStage[input.stage] ?? 0;
  if (attempts >= Number.MAX_SAFE_INTEGER) return { allowed: false, reason: `${input.stage} attempt counter is invalid` };
  if (input.snapshot.paidFallbacks > input.budgets.maxPaidFallbacksPerRun) {
    return { allowed: false, reason: `paid fallback budget exceeded: ${input.snapshot.paidFallbacks} > ${input.budgets.maxPaidFallbacksPerRun}` };
  }
  if (input.snapshot.observedRunUsd >= input.budgets.maxObservedUsdPerRun) {
    return { allowed: false, reason: `run observed budget reached: $${input.snapshot.observedRunUsd.toFixed(4)} >= $${input.budgets.maxObservedUsdPerRun.toFixed(4)}` };
  }
  if (input.snapshot.observedDayUsd >= input.budgets.maxObservedUsdPerDay) {
    return { allowed: false, reason: `daily observed budget reached: $${input.snapshot.observedDayUsd.toFixed(4)} >= $${input.budgets.maxObservedUsdPerDay.toFixed(4)}` };
  }
  if (input.estimate.status === "unknown") {
    if (input.budgets.allowUnknownCost) return { allowed: true, reason: `cost unknown allowed: ${input.estimate.reason}` };
    return input.unattended
      ? { allowed: false, reason: `cost unknown and unattended mode fails closed: ${input.estimate.reason}` }
      : { allowed: "ask", reason: `cost unknown before ${input.stage}: ${input.estimate.reason}` };
  }

  const amount = input.estimate.estimatedUsd;
  if (amount > input.budgets.maxEstimatedUsdPerStage) {
    return overrun(`stage estimated budget`, amount, input.budgets.maxEstimatedUsdPerStage, input.unattended);
  }
  if (input.snapshot.estimatedRunUsd + amount > input.budgets.maxEstimatedUsdPerRun) {
    return overrun(`run estimated budget`, input.snapshot.estimatedRunUsd + amount, input.budgets.maxEstimatedUsdPerRun, input.unattended);
  }
  if (input.snapshot.estimatedDayUsd + amount > input.budgets.maxEstimatedUsdPerDay) {
    return overrun(`daily estimated budget`, input.snapshot.estimatedDayUsd + amount, input.budgets.maxEstimatedUsdPerDay, input.unattended);
  }
  return { allowed: true, reason: `estimated cost $${amount.toFixed(4)} is within configured routing budgets` };
}

export function addEstimatedRoutingCost(
  snapshot: RoutingBudgetSnapshot,
  stage: RoutingStage,
  estimate: RoutingCostEstimate,
): RoutingBudgetSnapshot {
  const next = cloneSnapshot(snapshot);
  next.attemptsByStage[stage] = (next.attemptsByStage[stage] ?? 0) + 1;
  if (estimate.status === "known") {
    next.estimatedRunUsd = roundUsd(next.estimatedRunUsd + estimate.estimatedUsd);
    next.estimatedDayUsd = roundUsd(next.estimatedDayUsd + estimate.estimatedUsd);
  }
  return next;
}

export function reconcileObservedRoutingCost(
  snapshot: RoutingBudgetSnapshot,
  observed: ObservedRoutingCost,
): RoutingBudgetSnapshot {
  if (observed.status === "unknown") return snapshot;
  const next = cloneSnapshot(snapshot);
  next.observedRunUsd = roundUsd(next.observedRunUsd + observed.observedUsd);
  next.observedDayUsd = roundUsd(next.observedDayUsd + observed.observedUsd);
  return next;
}

function overrun(label: string, actual: number, limit: number, unattended: boolean): RoutingBudgetDecision {
  const reason = `${label} would be $${actual.toFixed(4)}, above configured ceiling $${limit.toFixed(4)}`;
  return unattended ? { allowed: false, reason } : { allowed: "ask", reason };
}

function cloneSnapshot(snapshot: RoutingBudgetSnapshot): RoutingBudgetSnapshot {
  return {
    estimatedRunUsd: snapshot.estimatedRunUsd,
    observedRunUsd: snapshot.observedRunUsd,
    estimatedDayUsd: snapshot.estimatedDayUsd,
    observedDayUsd: snapshot.observedDayUsd,
    paidFallbacks: snapshot.paidFallbacks,
    attemptsByStage: { ...snapshot.attemptsByStage },
  };
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
