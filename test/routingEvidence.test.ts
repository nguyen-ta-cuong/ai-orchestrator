import { describe, expect, it } from "vitest";
import {
  aggregateRoutingEvidence,
  compareRoutingPolicies,
  recommendRoutingPolicyChanges,
  validateRoutingEvidenceEvent,
  type RoutingEvidenceEvent,
} from "../src/core/routingEvidence.js";

const baseEvent: RoutingEvidenceEvent = {
  version: 1,
  eventId: "event-1",
  runId: "run-opaque",
  decisionId: "decision-1",
  stage: "build",
  recordedAt: "2026-07-12T00:00:00.000Z",
  policyVersion: "policy-v1",
  profileVersion: "profiles-v1",
  task: { workKind: "feature", risk: "medium", languages: ["typescript"], fileCount: 3 },
  selected: { provider: "p", model: "strong", family: "family-a" },
  usage: { inputTokens: 1_000, outputTokens: 500, cacheReadTokens: "unknown", cacheWriteTokens: "unknown" },
  cost: { estimatedUsd: 0.01, observedUsd: 0.02 },
  outcome: { type: "stage-ended", verdict: "approve", finalRunStatus: "done", buildIteration: 1 },
};

describe("routing evidence", () => {
  it("accepts privacy-minimized valid events and rejects prompt/source payloads", () => {
    expect(validateRoutingEvidenceEvent(baseEvent)).toEqual({ ok: true, event: baseEvent });

    expect(validateRoutingEvidenceEvent({
      ...baseEvent,
      prompt: "do not store me",
    })).toMatchObject({ ok: false, error: expect.stringContaining("disallowed field") });
    expect(validateRoutingEvidenceEvent({ ...baseEvent, rawPrompt: "SECRET" }))
      .toMatchObject({ ok: false, error: expect.stringContaining("unexpected field rawPrompt") });
    expect(validateRoutingEvidenceEvent({ ...baseEvent, task: { ...baseEvent.task, sourceText: "SECRET" } }))
      .toMatchObject({ ok: false, error: expect.stringContaining("task.sourceText") });
  });

  it("aggregates observed cost without converting unknown values to zero", () => {
    const aggregate = aggregateRoutingEvidence([
      baseEvent,
      { ...baseEvent, eventId: "event-2", cost: { estimatedUsd: "unknown", observedUsd: "unknown" } },
    ]);

    expect(aggregate.totalEvents).toBe(2);
    expect(aggregate.byStage.build.observedCostUsd).toBe(0.02);
    expect(aggregate.byStage.build.unknownObservedCostCount).toBe(1);
    expect(aggregate.byStage.build.approvals).toBe(2);
  });

  it("requires enough comparable downstream samples before recommending bounded policy changes", () => {
    const samples = Array.from({ length: 10 }, (_, index): RoutingEvidenceEvent => ({
      ...baseEvent,
      eventId: `event-${index}`,
      decisionId: `decision-${index}`,
      selected: { provider: "p", model: index < 7 ? "strong" : "cheap", family: "family-a" },
      cost: { estimatedUsd: index < 7 ? 0.04 : 0.01, observedUsd: index < 7 ? 0.04 : 0.01 },
      outcome: { type: "stage-ended", verdict: index < 7 ? "approve" : "reject", finalRunStatus: index < 7 ? "done" : "failed", buildIteration: 1 },
    }));

    expect(recommendRoutingPolicyChanges(samples.slice(0, 9))).toEqual([]);
    const recommendations = recommendRoutingPolicyChanges(samples);

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]).toMatchObject({
      stage: "build",
      sampleCount: 10,
      recommendedChange: { kind: "prefer-model", provider: "p", model: "strong" },
    });
    expect(recommendations[0]?.rollback).toContain("Remove");
  });

  it("does not reward approvals that are later reversed or overridden", () => {
    const samples = Array.from({ length: 10 }, (_, index): RoutingEvidenceEvent => ({
      ...baseEvent,
      eventId: `adverse-${index}`,
      decisionId: `adverse-decision-${index}`,
      selected: { provider: "p", model: index < 7 ? "rubber-stamp" : "reliable" },
      outcome: index < 7
        ? { type: "stage-ended", verdict: "approve", finalRunStatus: "done", laterReversal: true, humanOverride: true, buildIteration: 1 }
        : { type: "stage-ended", verdict: "approve", finalRunStatus: "done", buildIteration: 1 },
    }));

    expect(recommendRoutingPolicyChanges(samples)[0]).toMatchObject({
      recommendedChange: { kind: "prefer-model", provider: "p", model: "reliable" },
      downstreamEvidence: expect.stringContaining("non-reversed, non-overridden"),
    });
  });

  it("reports shadow policy differences without claiming counterfactual quality", () => {
    const comparison = compareRoutingPolicies({
      stage: "review",
      selected: { provider: "p", model: "actual" },
      alternate: { provider: "p", model: "shadow" },
      selectedEstimatedCostUsd: 0.03,
      alternateEstimatedCostUsd: 0.01,
      observedOutcome: { verdict: "approve", finalRunStatus: "done" },
    });

    expect(comparison.sameChoice).toBe(false);
    expect(comparison.expectedCostDeltaUsd).toBeCloseTo(-0.02);
    expect(comparison.qualityClaim).toBe("not-counterfactual");
  });
});
