import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROUTING_BUDGETS,
  enforceRoutingBudget,
  estimateRoutingStageCost,
  reconcileObservedRoutingCost,
  type RoutingBudgetSnapshot,
} from "../src/core/routingBudget.js";
import type { DiscoveredModel, TaskFeatures } from "../src/core/modelRouting.js";

const task: TaskFeatures = {
  contextTokens: 10_000,
  expectedOutputTokens: 2_000,
  requiredInput: ["text"],
  risk: "medium",
  workKind: "feature",
  fileCount: 2,
  languages: ["typescript"],
  riskSignals: [],
  failureSignals: [],
};

const model: DiscoveredModel = {
  provider: "p",
  model: "m",
  callable: true,
  reasoning: true,
  supportedThinking: ["medium"],
  input: ["text"],
  contextWindow: 128_000,
  maxOutputTokens: 8_000,
  cost: { input: 2, output: 10, cacheRead: 0.5, cacheWrite: 2 },
};

describe("routing budgets", () => {
  it("estimates pre-stage cost from task token bands and model rates", () => {
    expect(estimateRoutingStageCost({ task, model, thinking: "medium" })).toEqual({
      status: "known",
      estimatedUsd: 0.042,
    });
  });

  it("keeps missing rates unknown instead of treating them as free", () => {
    expect(estimateRoutingStageCost({ task, model: { ...model, cost: undefined }, thinking: "medium" })).toEqual({
      status: "unknown",
      reason: "model cost metadata unavailable",
    });
  });

  it("fails closed before a stage would cross an estimated run ceiling", () => {
    const snapshot: RoutingBudgetSnapshot = {
      estimatedRunUsd: 0.04,
      observedRunUsd: 0.01,
      estimatedDayUsd: 0.04,
      observedDayUsd: 0.01,
      paidFallbacks: 0,
      attemptsByStage: { build: 1 },
    };

    const decision = enforceRoutingBudget({
      stage: "build",
      estimate: { status: "known", estimatedUsd: 0.04 },
      budgets: { ...DEFAULT_ROUTING_BUDGETS, maxEstimatedUsdPerRun: 0.05 },
      snapshot,
      unattended: true,
    });

    expect(decision).toMatchObject({ allowed: false, reason: expect.stringContaining("run estimated budget") });
  });

  it("asks in UI mode but fails closed in unattended mode for unknown cost when configured", () => {
    const budgets = { ...DEFAULT_ROUTING_BUDGETS, allowUnknownCost: false };
    const estimate = { status: "unknown" as const, reason: "missing" };

    expect(enforceRoutingBudget({ stage: "review", estimate, budgets, snapshot: emptySnapshot(), unattended: false })).toMatchObject({
      allowed: "ask",
    });
    expect(enforceRoutingBudget({ stage: "review", estimate, budgets, snapshot: emptySnapshot(), unattended: true })).toMatchObject({
      allowed: false,
    });
  });

  it("reconciles observed cost when available without overwriting unknown", () => {
    const snapshot = emptySnapshot();
    expect(reconcileObservedRoutingCost(snapshot, { status: "known", observedUsd: 0.03 })).toMatchObject({
      observedRunUsd: 0.03,
      observedDayUsd: 0.03,
    });
    expect(reconcileObservedRoutingCost(snapshot, { status: "unknown", reason: "provider omitted usage" })).toEqual(snapshot);
  });
});

function emptySnapshot(): RoutingBudgetSnapshot {
  return {
    estimatedRunUsd: 0,
    observedRunUsd: 0,
    estimatedDayUsd: 0,
    observedDayUsd: 0,
    paidFallbacks: 0,
    attemptsByStage: {},
  };
}
