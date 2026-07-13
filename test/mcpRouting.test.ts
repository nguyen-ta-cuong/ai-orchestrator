import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type OrchestratorConfig } from "../src/core/config.js";
import { defaultTaskFeatures, mergeTaskFeatures, metadataFor, resolveMcpRoute } from "../mcp/routing.js";

function routedConfig(): OrchestratorConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.routing.engine = "capability";
  config.mcp.providers = {
    p1: { baseUrl: "https://p1.example/v1", api: "openai-responses", apiKey: "secret-1" },
    p2: { baseUrl: "https://p2.example/v1", api: "anthropic-messages", apiKey: "secret-2" },
    unsupported: { baseUrl: "https://bad.example/v1", api: "unknown", apiKey: "secret-3" },
  };
  config.mcp.models = [
    { provider: "p1", model: "maker", family: "family-a", reasoning: true, supportedThinking: ["off", "high"], input: ["text"], contextWindow: 64_000, maxOutputTokens: 8_000 },
    { provider: "p2", model: "checker", family: "family-b", reasoning: true, supportedThinking: ["off", "high"], input: ["text"], contextWindow: 64_000, maxOutputTokens: 8_000 },
    { provider: "unsupported", model: "ghost", reasoning: true, supportedThinking: ["high"], input: ["text"], contextWindow: 64_000, maxOutputTokens: 8_000 },
  ];
  config.routing.profiles = {
    "p1/maker": { family: "family-a", confidence: 9_000, provenance: "user", scores: { architecture: 9_500, verification: 9_000, review: 9_000, structuredOutput: 9_000 } },
    "p2/checker": { family: "family-b", confidence: 9_000, provenance: "user", scores: { architecture: 8_000, verification: 8_500, review: 8_500, structuredOutput: 9_000 } },
    "unsupported/ghost": { confidence: 9_000, provenance: "user", scores: { architecture: 10_000, verification: 10_000, review: 10_000, structuredOutput: 10_000 } },
  };
  return config;
}

describe("MCP capability routing", () => {
  it("normalizes the trusted catalog through shared rankModels and filters unsupported provider APIs", () => {
    const route = resolveMcpRoute({ config: routedConfig(), stage: "plan", role: "planner", task: defaultTaskFeatures("plan a feature") });
    expect(route.candidates.map((candidate) => `${candidate.provider}/${candidate.model}`)).toEqual(["p1/maker", "p2/checker"]);
    expect(route.excluded).toEqual(expect.arrayContaining([expect.objectContaining({ identity: expect.objectContaining({ provider: "unsupported" }), code: "not-callable" })]));
    expect(metadataFor(route, 0, [])).toMatchObject({
      selectedIdentity: { provider: "p1", model: "maker", family: "family-a" },
      policyVersion: DEFAULT_CONFIG.routing.version,
      score: { total: expect.any(Number) },
      legacyFallback: false,
    });
  });

  it("applies trusted MCP catalog privacy as a hard eligibility gate", () => {
    const config = routedConfig();
    config.mcp.models[0]!.privacy = "public";
    config.mcp.models[1]!.privacy = "private";
    config.routing.privacy = { allowed: ["private"], allowUnknown: false, providers: {} };

    const route = resolveMcpRoute({ config, stage: "plan", role: "planner", task: defaultTaskFeatures("plan") });
    expect(route.candidates.map((candidate) => candidate.model)).toEqual(["checker"]);
    expect(route.excluded).toEqual(expect.arrayContaining([
      expect.objectContaining({ identity: expect.objectContaining({ model: "maker" }), code: "privacy-not-allowed" }),
    ]));
  });

  it("enforces MCP stage budget and fallback-attempt ceilings", () => {
    const config = routedConfig();
    config.mcp.models = config.mcp.models.map((model) => ({
      ...model,
      cost: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
    }));
    config.routing.budgets.maxEstimatedUsdPerStage = 0.001;
    expect(() => resolveMcpRoute({ config, stage: "plan", role: "planner", task: defaultTaskFeatures("plan") }))
      .toThrow(/estimated cost/);

    config.routing.budgets.maxEstimatedUsdPerStage = 8;
    config.routing.limits.maxAttemptsPerStage = 1;
    const attemptCapped = resolveMcpRoute({ config, stage: "plan", role: "planner", task: defaultTaskFeatures("plan") });
    const preview = resolveMcpRoute({ config, stage: "plan", role: "planner", task: defaultTaskFeatures("plan"), preview: true });
    expect(attemptCapped.candidates).toHaveLength(1);
    expect(preview.candidates).toHaveLength(2);

    config.routing.limits.maxAttemptsPerStage = 3;
    config.routing.budgets.maxEstimatedUsdPerStage = 0.1;
    const cumulativelyCapped = resolveMcpRoute({ config, stage: "plan", role: "planner", task: defaultTaskFeatures("plan") });
    expect(cumulativelyCapped.candidates).toHaveLength(1);

    const skipExpensiveMiddle = routedConfig();
    skipExpensiveMiddle.mcp.providers.p3 = { baseUrl: "https://p3.example/v1", api: "openai-responses", apiKey: "secret-3" };
    skipExpensiveMiddle.mcp.models[0]!.cost = { input: 0, output: 12, cacheRead: 0, cacheWrite: 0 };
    skipExpensiveMiddle.mcp.models[1]!.cost = { input: 0, output: 10, cacheRead: 0, cacheWrite: 0 };
    skipExpensiveMiddle.mcp.models.push({
      provider: "p3", model: "cheap", family: "family-c", reasoning: true,
      supportedThinking: ["high"], input: ["text"], contextWindow: 64_000, maxOutputTokens: 8_000,
      cost: { input: 0, output: 2, cacheRead: 0, cacheWrite: 0 },
    });
    skipExpensiveMiddle.routing.profiles["p3/cheap"] = {
      family: "family-c", confidence: 9_000, provenance: "user",
      scores: { architecture: 7_000, structuredOutput: 9_000 },
    };
    skipExpensiveMiddle.routing.budgets.maxEstimatedUsdPerStage = 0.06;
    const affordablePrefix = resolveMcpRoute({
      config: skipExpensiveMiddle, stage: "plan", role: "planner", task: defaultTaskFeatures("plan"),
    });
    expect(affordablePrefix.candidates.map((candidate) => candidate.model)).toEqual(["maker", "cheap"]);
  });

  it("merges client task features without allowing cost/context understatement", () => {
    const merged = mergeTaskFeatures("x".repeat(40_000), {
      ...defaultTaskFeatures("tiny"),
      contextTokens: 1,
      expectedOutputTokens: 1,
      risk: "low",
    });
    expect(merged.contextTokens).toBe(40_000);
    expect(merged.expectedOutputTokens).toBe(4_096);
    expect(merged.risk).toBe("medium");
  });

  it("keeps preview independent of API-key presence and returns exclusions when eligibility is empty", () => {
    const withKey = routedConfig();
    const withoutKey = routedConfig();
    delete withoutKey.mcp.providers.p1.apiKey;
    delete withoutKey.mcp.providers.p2.apiKey;
    const input = { stage: "plan" as const, role: "planner" as const, task: defaultTaskFeatures("plan"), preview: true };
    expect(resolveMcpRoute({ config: withoutKey, ...input }).candidates)
      .toEqual(resolveMcpRoute({ config: withKey, ...input }).candidates);

    withoutKey.routing.stages.plan.minimumScores = { architecture: 10_000 };
    const empty = resolveMcpRoute({ config: withoutKey, ...input });
    expect(empty.candidates).toEqual([]);
    expect(empty.excluded).toHaveLength(3);
  });

  it("fails closed without coder identity under strict active judge separation", () => {
    expect(() => resolveMcpRoute({ config: routedConfig(), stage: "fast-judge", role: "judge", task: defaultTaskFeatures("judge") }))
      .toThrow(/requires coderIdentity/);

    const emptyCatalog = routedConfig();
    emptyCatalog.mcp.models = [];
    expect(() => resolveMcpRoute({ config: emptyCatalog, stage: "fast-judge", role: "judge", task: defaultTaskFeatures("judge") }))
      .toThrow(/requires coderIdentity/);
    expect(() => resolveMcpRoute({ config: emptyCatalog, stage: "plan", role: "planner", task: defaultTaskFeatures("plan") }))
      .toThrow(/No trusted MCP model catalog/);
  });

  it("excludes the coder and selects an independent checker", () => {
    const route = resolveMcpRoute({ config: routedConfig(), stage: "fast-judge", role: "judge", task: defaultTaskFeatures("judge"), coderIdentity: "p1/maker" });
    expect(route.candidates[0]).toMatchObject({ provider: "p2", model: "checker" });
    expect(route.excluded).toEqual(expect.arrayContaining([expect.objectContaining({ code: "same-builder-model" })]));
    expect(route.separation).toMatchObject({ required: true, satisfied: true, builderIdentity: "p1/maker" });
  });

  it("enforces configured family separation using trusted catalog families", () => {
    const config = routedConfig();
    config.routing.separation.requireDifferentProviderFamilyFor = ["fast-judge"];
    const independent = resolveMcpRoute({
      config,
      stage: "fast-judge",
      role: "judge",
      task: defaultTaskFeatures("judge"),
      coderIdentity: "p1/maker",
    });
    expect(metadataFor(independent, 0, []).separation).toMatchObject({ satisfied: true });

    config.mcp.models[1]!.family = "family-a";
    config.routing.profiles["p2/checker"]!.family = "family-a";
    expect(() => resolveMcpRoute({
      config,
      stage: "fast-judge",
      role: "judge",
      task: defaultTaskFeatures("judge"),
      coderIdentity: "p1/maker",
    })).toThrow(/No eligible trusted MCP model/);
  });

  it("previews capability ranking without activating capability-shadow", () => {
    const config = routedConfig();
    config.routing.engine = "capability-shadow";
    config.roles.planner = { provider: "p2", model: "exact-pin", thinking: "minimal" };

    const active = resolveMcpRoute({ config, stage: "plan", role: "planner", task: defaultTaskFeatures("plan") });
    const preview = resolveMcpRoute({ config, stage: "plan", role: "planner", task: defaultTaskFeatures("plan"), preview: true });

    expect(active.candidates).toEqual([{ provider: "p2", model: "exact-pin", thinking: "minimal", requestedOutputTokens: 4_096 }]);
    expect(active.legacyFallback).toBe(true);
    expect(preview.candidates[0]).toMatchObject({ provider: "p1", model: "maker" });
    expect(preview.legacyFallback).toBe(false);
  });

  it.each(["legacy", "capability-shadow"] as const)("preserves exact role fallback in %s mode", (engine) => {
    const config = routedConfig();
    config.routing.engine = engine;
    config.roles.planner = { provider: "p2", model: "exact-pin", thinking: "minimal" };
    const route = resolveMcpRoute({ config, stage: "plan", role: "planner", task: defaultTaskFeatures("plan") });
    expect(route.candidates).toEqual([{ provider: "p2", model: "exact-pin", thinking: "minimal", requestedOutputTokens: 4_096 }]);
    expect(route.legacyFallback).toBe(true);
  });
});
