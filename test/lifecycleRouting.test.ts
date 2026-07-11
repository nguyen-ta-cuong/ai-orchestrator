import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type OrchestratorConfig } from "../src/core/config.js";
import { lifecycleModelChoices } from "../src/core/lifecycleRouting.js";

const available = [
  { provider: "anthropic", model: "claude-fable-5" },
  { provider: "openai-codex", model: "gpt-5.6-sol" },
  { provider: "openai-codex", model: "gpt-5.5" },
];

describe("lifecycleModelChoices", () => {
  it("uses stage-specific priority among locally available models", () => {
    expect(lifecycleModelChoices("define", DEFAULT_CONFIG, available, DEFAULT_CONFIG.roles.spec)[0]).toMatchObject({
      candidate: { provider: "anthropic", model: "claude-fable-5" },
      source: "routing",
    });
    expect(lifecycleModelChoices("verify", DEFAULT_CONFIG, available, DEFAULT_CONFIG.roles.verifier)[0]).toMatchObject({
      candidate: { provider: "openai-codex", model: "gpt-5.6-sol" },
      source: "routing",
    });
  });

  it("filters unavailable candidates and preserves fallback order", () => {
    const choices = lifecycleModelChoices(
      "review",
      DEFAULT_CONFIG,
      [{ provider: "anthropic", model: "claude-fable-5" }],
      DEFAULT_CONFIG.roles.reviewer,
    );
    expect(choices).toHaveLength(1);
    expect(choices[0].candidate.model).toBe("claude-fable-5");
  });

  it("deduplicates a fixed role already present in routed candidates", () => {
    const choices = lifecycleModelChoices("plan", DEFAULT_CONFIG, available, DEFAULT_CONFIG.roles.planner);
    expect(choices.filter((choice) => choice.candidate.model === "claude-fable-5")).toHaveLength(1);
  });

  it("uses only the fixed role when routing is disabled", () => {
    const config: OrchestratorConfig = {
      ...DEFAULT_CONFIG,
      routing: { lifecycle: { ...DEFAULT_CONFIG.routing.lifecycle, enabled: false } },
    };
    const choices = lifecycleModelChoices("debug", config, available, config.roles.debugger);
    expect(choices).toEqual([
      expect.objectContaining({
        candidate: config.roles.debugger,
        source: "role-fallback",
      }),
    ]);
  });

  it("returns no choices when no configured candidate is locally available", () => {
    expect(lifecycleModelChoices("ship", DEFAULT_CONFIG, [], DEFAULT_CONFIG.roles.shipper)).toEqual([]);
  });
});
