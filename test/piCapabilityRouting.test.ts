import { describe, expect, it } from "vitest";
import { createPiRoutingPlan } from "../src/adapters/piCapabilityRouting.js";
import { DEFAULT_CONFIG, type ConfigProvenance, type OrchestratorConfig } from "../src/core/config.js";

const builtin: ConfigProvenance = { roles: Object.fromEntries(
  ["planner", "coder", "judge", "spec", "verifier", "reviewer", "debugger", "shipper"].map((role) => [role, "builtin"]),
) as ConfigProvenance["roles"] };

function available(provider: string, id: string) {
  return { provider, id, reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 16_000 };
}

function capableConfig(): OrchestratorConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.routing.engine = "capability";
  config.routing.unknownCost = "allow";
  config.routing.profiles = {
    "invented/coder": { family: "maker", confidence: 9_000, version: "test", scores: { coding: 9_500, verification: 7_000, review: 7_000 } },
    "invented/checker": { family: "checker", confidence: 9_000, version: "test", scores: { coding: 6_000, verification: 9_500, review: 9_500 } },
  };
  return config;
}

describe("Pi capability routing plan", () => {
  it("selects a coding model for BUILD and excludes it from checker routing", () => {
    const config = capableConfig();
    const models = [available("invented", "coder"), available("invented", "checker")];
    const build = createPiRoutingPlan({ config, provenance: builtin, stage: "build", role: "coder", available: models, evidence: "build a feature" });
    expect(build.candidates[0]?.model).toBe("coder");
    const verify = createPiRoutingPlan({
      config,
      provenance: builtin,
      stage: "verify",
      role: "verifier",
      available: models,
      evidence: "build a feature",
      priorSelections: [{ stage: "build", provider: "invented", model: "coder", family: "maker" }],
    });
    expect(verify.candidates[0]?.model).toBe("checker");
    expect(verify.decision?.excluded).toContainEqual(expect.objectContaining({ code: "same-builder-model" }));
  });

  it("keeps thinking clamp rationale in the selected candidate explanation", () => {
    const config = capableConfig();
    const plan = createPiRoutingPlan({
      config,
      provenance: builtin,
      stage: "build",
      role: "coder",
      available: [{ ...available("invented", "coder"), thinkingLevelMap: { medium: null, low: "low", high: null } }],
      evidence: "build a feature",
    });
    expect(plan.candidates[0]).toMatchObject({ thinking: "low", reason: expect.stringContaining("clamped to low") });
  });

  it("turns an explicit role override into an exact pin", () => {
    const config = capableConfig();
    config.roles.coder = { provider: "invented", model: "checker", thinking: "high" };
    const provenance = structuredClone(builtin);
    provenance.roles.coder = "project";
    const plan = createPiRoutingPlan({
      config,
      provenance,
      stage: "build",
      role: "coder",
      available: [available("invented", "coder"), available("invented", "checker")],
      evidence: "build a feature",
    });
    expect(plan.candidates.map((candidate) => candidate.model)).toEqual(["checker"]);
  });

  it("honors an explicit callable pin even when it has no capability profile", () => {
    const config = capableConfig();
    config.roles.coder = { provider: "private", model: "trusted-coder", thinking: "high" };
    const provenance = structuredClone(builtin);
    provenance.roles.coder = "user";
    const plan = createPiRoutingPlan({
      config,
      provenance,
      stage: "build",
      role: "coder",
      available: [available("private", "trusted-coder"), available("invented", "coder")],
      evidence: "build a feature",
    });
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]).toMatchObject({ provider: "private", model: "trusted-coder" });
  });

  it("keeps legacy and shadow engines on exact legacy selection without allowing self-review", () => {
    for (const engine of ["legacy", "capability-shadow"] as const) {
      const config = structuredClone(DEFAULT_CONFIG);
      config.routing.engine = engine;
      const build = createPiRoutingPlan({
        config,
        provenance: builtin,
        stage: "build",
        role: "coder",
        available: [available("openai-codex", "gpt-5.5")],
        evidence: "task",
      });
      expect(build.candidates[0]).toMatchObject({ provider: "openai-codex", model: "gpt-5.5" });

      config.roles.judge = { ...config.roles.coder };
      const judge = createPiRoutingPlan({
        config,
        provenance: builtin,
        stage: "fast-judge",
        role: "judge",
        available: [available("openai-codex", "gpt-5.5")],
        evidence: "task",
        priorSelections: [
          { stage: "build", provider: "old", model: "builder" },
          { stage: "build", provider: "openai-codex", model: "gpt-5.5" },
        ],
      });
      expect(judge.candidates).toEqual([]);
    }
  });
});
