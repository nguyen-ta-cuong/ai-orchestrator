import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROUTING_POLICY,
  modelIdentityKey,
  rankModels,
  resolveModelProfiles,
  selectThinkingLevel,
  type DiscoveredModel,
  type ModelCapabilityProfile,
  type RoutingPolicy,
  type RoutingRequest,
} from "../src/core/modelRouting.js";

function model(overrides: Partial<DiscoveredModel> & Pick<DiscoveredModel, "provider" | "model">): DiscoveredModel {
  return {
    callable: true,
    reasoning: true,
    supportedThinking: ["off", "low", "medium", "high"],
    input: ["text"],
    contextWindow: 128_000,
    maxOutputTokens: 16_000,
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
    ...overrides,
  };
}

function profile(overrides: Partial<ModelCapabilityProfile> = {}): ModelCapabilityProfile {
  return {
    confidence: 8_000,
    provenance: "project",
    version: "test-v1",
    scores: {
      requirements: 7_000,
      architecture: 7_000,
      coding: 7_000,
      debugging: 7_000,
      verification: 7_000,
      review: 7_000,
      release: 7_000,
      structuredOutput: 7_000,
      longContext: 7_000,
      speed: 7_000,
      economy: 7_000,
    },
    ...overrides,
  };
}

function request(
  models: readonly DiscoveredModel[],
  profiles: Readonly<Record<string, ModelCapabilityProfile>>,
  overrides: Partial<RoutingRequest> = {},
): RoutingRequest {
  return {
    stage: "review",
    task: {
      contextTokens: 32_000,
      expectedOutputTokens: 4_000,
      requiredInput: ["text"],
      risk: "medium",
      workKind: "feature",
      fileCount: 6,
      languages: ["typescript"],
      riskSignals: [],
      failureSignals: [],
    },
    models,
    profiles,
    policy: structuredClone(DEFAULT_ROUTING_POLICY),
    priorSelections: [],
    ...overrides,
  };
}

describe("capability model routing", () => {
  it("uses collision-safe provider/model identity keys", () => {
    expect(modelIdentityKey({ provider: "a/b", model: "c" })).not.toBe(
      modelIdentityKey({ provider: "a", model: "b/c" }),
    );
  });

  it("resolves explicit profile precedence and preserves unknown models", () => {
    const models = [model({ provider: "local", model: "novel" }), model({ provider: "local", model: "unknown" })];
    const resolved = resolveModelProfiles(
      models,
      [
        { provenance: "builtin", profiles: { "local/novel": profile({ scores: { coding: 4_000 } }) } },
        { provenance: "project", profiles: { "local/novel": profile({ scores: { coding: 7_000 } }) } },
        { provenance: "user", profiles: { "local/novel": profile({ scores: { coding: 9_000 } }) } },
      ],
      DEFAULT_ROUTING_POLICY,
    );

    expect(resolved.get(modelIdentityKey(models[0]!))?.scores.coding).toBe(9_000);
    expect(resolved.get(modelIdentityKey(models[0]!))?.provenance).toBe("user");
    expect(resolved.has(modelIdentityKey(models[1]!))).toBe(false);
  });

  it("excludes unknown profiles unless inferred profiles are explicitly allowed", () => {
    const unknown = model({ provider: "local", model: "unknown" });
    const strict = rankModels(request([unknown], {}));
    expect(strict.eligible).toEqual([]);
    expect(strict.excluded[0]?.code).toBe("profile-unknown");

    const permissivePolicy = structuredClone(DEFAULT_ROUTING_POLICY);
    permissivePolicy.allowInferredProfiles = true;
    permissivePolicy.stages.review.minimumProfileConfidence = 0;
    permissivePolicy.stages.review.minimumScores = {};
    expect(rankModels(request([unknown], {}, { policy: permissivePolicy })).eligible).toHaveLength(1);
  });

  it.each([
    ["context", model({ provider: "p", model: "m", contextWindow: 8_000 }), "context-insufficient"],
    ["image input", model({ provider: "p", model: "m", input: ["text"] }), "input-unsupported"],
    ["reasoning", model({ provider: "p", model: "m", reasoning: false, supportedThinking: ["off"] }), "reasoning-required"],
  ] as const)("hard-excludes a candidate that fails %s requirements", (_label, candidate, code) => {
    const policy = structuredClone(DEFAULT_ROUTING_POLICY);
    policy.stages.review.requiresReasoning = true;
    const task = request([candidate], { "p/m": profile() }, { policy }).task;
    const decision = rankModels(request([candidate], { "p/m": profile() }, {
      policy,
      task: { ...task, requiredInput: code === "input-unsupported" ? ["text", "image"] : ["text"] },
    }));
    expect(decision.excluded[0]?.code).toBe(code);
  });

  it("treats unknown cost according to policy instead of as zero", () => {
    const candidate = model({ provider: "p", model: "m", cost: undefined });
    const strict = structuredClone(DEFAULT_ROUTING_POLICY);
    strict.unknownCost = "exclude";
    expect(rankModels(request([candidate], { "p/m": profile() }, { policy: strict })).excluded[0]?.code).toBe("cost-unknown");

    const penalized = structuredClone(DEFAULT_ROUTING_POLICY);
    penalized.unknownCost = "penalize";
    const ranked = rankModels(request([candidate], { "p/m": profile() }, { policy: penalized })).eligible[0]!;
    expect(ranked.scoreBreakdown.some((component) => component.name === "unknown-cost" && component.value < 0)).toBe(true);
  });

  it("applies model and family separation independently", () => {
    const exact = model({ provider: "maker", model: "build", family: "family-a" });
    const sibling = model({ provider: "other", model: "review", family: "family-a" });
    const profiles = { "maker/build": profile(), "other/review": profile() };
    const priorSelections = [{ stage: "build" as const, provider: "maker", model: "build", family: "family-a" }];

    const exactDecision = rankModels(request([exact, sibling], profiles, { priorSelections }));
    expect(exactDecision.excluded.find((item) => item.identity.model === "build")?.code).toBe("same-builder-model");
    expect(exactDecision.eligible.map((item) => item.identity.model)).toEqual(["review"]);

    const separationDisabled = structuredClone(DEFAULT_ROUTING_POLICY);
    separationDisabled.separation.checkerMustDifferFromBuilder = false;
    expect(rankModels(request([exact], profiles, { priorSelections, policy: separationDisabled })).excluded[0]?.code).toBe("same-builder-model");

    const previousBuilder = { stage: "build" as const, provider: "old", model: "builder", family: "family-old" };
    const latestDecision = rankModels(request([exact, sibling], profiles, {
      priorSelections: [previousBuilder, ...priorSelections],
    }));
    expect(latestDecision.excluded.find((item) => item.identity.model === "build")?.code).toBe("same-builder-model");

    const strictPolicy = structuredClone(DEFAULT_ROUTING_POLICY);
    strictPolicy.separation.requireDifferentProviderFamilyFor = ["review"];
    const familyDecision = rankModels(request([exact, sibling], profiles, { priorSelections, policy: strictPolicy }));
    expect(familyDecision.excluded.find((item) => item.identity.model === "review")?.code).toBe("same-builder-family");
  });

  it("returns deterministic scores whose named components sum to the final score", () => {
    const models = [model({ provider: "z", model: "second" }), model({ provider: "a", model: "first" })];
    const profiles = { "z/second": profile(), "a/first": profile() };
    const first = rankModels(request(models, profiles));
    const second = rankModels(request(models, profiles));

    expect(first).toEqual(second);
    for (const candidate of first.eligible) {
      expect(candidate.scoreBreakdown.reduce((sum, component) => sum + component.value, 0)).toBe(candidate.score);
    }
    expect(first.eligible.map((item) => `${item.identity.provider}/${item.identity.model}`)).toEqual(["a/first", "z/second"]);
  });

  it("breaks score ties by prefer order, confidence, cost, then lexical identity", () => {
    const models = [
      model({ provider: "p", model: "preferred", cost: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 } }),
      model({ provider: "p", model: "confident" }),
      model({ provider: "p", model: "cheap", cost: { input: 0.5, output: 0.5, cacheRead: 0, cacheWrite: 0 } }),
      model({ provider: "a", model: "lexical" }),
    ];
    const equalScores = profile();
    const profiles = Object.fromEntries(models.map((item) => [`${item.provider}/${item.model}`, equalScores]));
    profiles["p/confident"] = profile({ confidence: 9_000 });
    const policy = structuredClone(DEFAULT_ROUTING_POLICY);
    policy.stages.review.prefer = ["p/preferred"];
    policy.costPenaltyBasisPointsPerUsd = 0;
    policy.confidenceBonusBasisPoints = 0;

    const ranked = rankModels(request(models, profiles, { policy })).eligible;
    expect(ranked[0]?.identity.model).toBe("preferred");
    expect(ranked[1]?.identity.model).toBe("confident");
    expect(ranked[2]?.identity.model).toBe("cheap");
    expect(ranked[3]?.identity.model).toBe("lexical");
  });

  it("clamps thinking targets to supported levels and raises the request for high risk", () => {
    const candidate = model({ provider: "p", model: "m", supportedThinking: ["off", "low", "high"] });
    const policy: RoutingPolicy = structuredClone(DEFAULT_ROUTING_POLICY);
    policy.stages.build.thinking = "medium";

    expect(selectThinkingLevel("build", candidate, policy, "low")).toMatchObject({ requested: "medium", selected: "low", clamped: true });
    expect(selectThinkingLevel("build", candidate, policy, "high")).toMatchObject({ requested: "high", selected: "high", clamped: false });
  });

  it("returns typed exclusions when no candidate is eligible", () => {
    const unavailable = model({ provider: "p", model: "m", callable: false });
    const decision = rankModels(request([unavailable], { "p/m": profile() }));
    expect(decision.eligible).toEqual([]);
    expect(decision.excluded).toEqual([
      expect.objectContaining({ code: "not-callable", detail: expect.any(String) }),
    ]);
  });
});
