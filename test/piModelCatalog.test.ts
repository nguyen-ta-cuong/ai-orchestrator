import { describe, expect, it } from "vitest";
import { normalizePiModelCatalog } from "../src/adapters/piModelCatalog.js";

describe("Pi model catalog normalization", () => {
  it("normalizes objective metadata without retaining credentials or endpoints", () => {
    const [normalized] = normalizePiModelCatalog([{
      provider: "custom",
      id: "vision-reasoner",
      name: "Vision Reasoner",
      api: "openai-responses",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 200_000,
      maxTokens: 32_000,
      cost: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2 },
      privacy: "private",
      thinkingLevelMap: { off: null, high: "high", xhigh: null, max: "max" },
      baseUrl: "https://secret.invalid",
      headers: { authorization: "secret" },
    }]);

    expect(normalized).toEqual({
      provider: "custom",
      model: "vision-reasoner",
      displayName: "Vision Reasoner",
      api: "openai-responses",
      callable: true,
      reasoning: true,
      supportedThinking: ["minimal", "low", "medium", "high", "max"],
      input: ["text", "image"],
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      cost: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2 },
      privacy: "private",
    });
    expect(JSON.stringify(normalized)).not.toContain("secret");
  });

  it("uses conservative defaults and off-only thinking for non-reasoning models", () => {
    expect(normalizePiModelCatalog([{ provider: "local", id: "plain", reasoning: false }])).toEqual([{
      provider: "local",
      model: "plain",
      callable: true,
      reasoning: false,
      supportedThinking: ["off"],
      input: ["text"],
      contextWindow: 0,
      maxOutputTokens: 0,
    }]);
  });

  it("drops catalog entries without non-empty provider/model identities", () => {
    expect(normalizePiModelCatalog([
      { provider: "", id: "missing-provider" },
      { provider: "local", id: "" },
      { provider: "local", id: "valid" },
    ])).toHaveLength(1);
  });
});
