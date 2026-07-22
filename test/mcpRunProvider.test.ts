import { describe, expect, it, vi } from "vitest";
import type { RoutedCompletionAttempt, RoutedCompletionRequest, RoutedCompletionResult } from "../mcp/llm.js";
import { createRoutedMcpRunProvider } from "../mcp/runProvider.js";
import { DEFAULT_CONFIG, type OrchestratorConfig } from "../src/core/config.js";

describe("routed MCP run provider", () => {
  it("freezes routing authority before beforeAttempt and carries it unchanged to the result", async () => {
    const config = routedConfig();
    let observedDecision: RoutedCompletionAttempt["routingDecision"] | undefined;
    const beforeAttempt = vi.fn(async (attempt: RoutedCompletionAttempt) => {
      observedDecision = structuredClone(attempt.routingDecision);
    });
    const afterAttempt = vi.fn(async () => undefined);
    const complete = vi.fn(async (request: RoutedCompletionRequest): Promise<RoutedCompletionResult> => {
      expect(request.routingDecision).toMatchObject({
        decisionId: "decision-plan",
        policyVersion: config.routing.version,
        policyDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        configDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        candidatesDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      const candidate = request.candidates[0]!;
      const attempt: RoutedCompletionAttempt = {
        attempt: 1,
        providerRequestRef: "a".repeat(64),
        routingDecision: structuredClone(request.routingDecision!),
        identity: {
          provider: candidate.provider,
          model: candidate.model,
          ...(candidate.family === undefined ? {} : { family: candidate.family }),
        },
        thinking: candidate.thinking,
      };
      await request.beforeAttempt?.(attempt);
      await request.afterAttempt?.({ ...attempt, outcome: "succeeded" });
      return { text: "1. Plan", selectedIndex: 0, fallbackHistory: [] };
    });
    const provider = createRoutedMcpRunProvider("/unused", {
      loadConfig: () => config,
      complete,
      createDecisionId: (stage) => `decision-${stage}`,
    });

    const result = await provider.plan({ task: "task", beforeAttempt, afterAttempt });

    expect(beforeAttempt).toHaveBeenCalledOnce();
    expect(afterAttempt).toHaveBeenCalledOnce();
    expect(result.routing).toMatchObject(observedDecision!);
  });

  it("uses the trusted plan route and preserves fallback evidence", async () => {
    const config = routedConfig();
    const calls: RoutedCompletionRequest[] = [];
    const complete = vi.fn(async (request: RoutedCompletionRequest): Promise<RoutedCompletionResult> => {
      calls.push(request);
      return {
        text: "1. Inspect\n2. Implement\n3. Test",
        selectedIndex: 1,
        fallbackHistory: [{ identity: "p1/maker", reason: "schema_validation_failed" }],
      };
    });
    const provider = createRoutedMcpRunProvider("/unused", {
      loadConfig: () => config,
      complete,
      createDecisionId: (stage) => `decision-${stage}`,
    });

    const result = await provider.plan({
      task: "Add a feature",
      repoContext: "src/index.ts exports the API",
      ...attemptHooks(),
    });

    expect(calls[0]?.role).toBe("planner");
    expect(calls[0]?.candidates.map((candidate) => `${candidate.provider}/${candidate.model}`))
      .toEqual(["p1/maker", "p2/checker"]);
    expect(calls[0]?.prompt).toContain(JSON.stringify({ task: "Add a feature", repoContext: "src/index.ts exports the API" }));
    expect(result).toMatchObject({
      plan: "1. Inspect\n2. Implement\n3. Test",
      routing: {
        decisionId: "decision-plan",
        stage: "plan",
        selectedIndex: 1,
        selectedIdentity: { provider: "p2", model: "checker", family: "family-b" },
        fallbackHistory: [{ identity: "p1/maker", failureCode: "schema_validation_failed" }],
      },
    });
  });

  it("routes JUDGE independently from the declared coder and strictly parses its verdict", async () => {
    const config = routedConfig();
    const calls: RoutedCompletionRequest[] = [];
    const complete = vi.fn(async (request: RoutedCompletionRequest): Promise<RoutedCompletionResult> => {
      calls.push(request);
      return {
        text: JSON.stringify({ verdict: "reject", reasons: "Missing regression coverage", requiredFixes: "Add a regression test" }),
        selectedIndex: 0,
        fallbackHistory: [],
      };
    });
    const provider = createRoutedMcpRunProvider("/unused", {
      loadConfig: () => config,
      complete,
      createDecisionId: (stage) => `decision-${stage}`,
    });

    const result = await provider.judge({
      task: "Add a feature",
      plan: "1. Add it",
      diff: "diff --git a/a.ts b/a.ts",
      testOutput: "tests failed",
      coderIdentity: "p1/maker",
      iteration: 1,
      consecutiveRejections: 0,
      ...attemptHooks(),
    });

    expect(calls[0]?.role).toBe("judge");
    expect(calls[0]?.candidates.map((candidate) => `${candidate.provider}/${candidate.model}`)).toEqual(["p2/checker"]);
    expect(calls[0]?.validateText).toEqual(expect.any(Function));
    expect(result).toMatchObject({
      verdict: "reject",
      requiredFixes: "Add a regression test",
      routing: {
        decisionId: "decision-fast-judge",
        stage: "fast-judge",
        selectedIndex: 0,
        selectedIdentity: { provider: "p2", model: "checker", family: "family-b" },
      },
    });
  });

  it("fails before completion when maker/checker separation has no eligible checker", async () => {
    const config = routedConfig();
    config.mcp.models = config.mcp.models.slice(0, 1);
    delete config.routing.profiles["p2/checker"];
    const complete = vi.fn(async (): Promise<RoutedCompletionResult> => ({ text: "unused", selectedIndex: 0, fallbackHistory: [] }));
    const provider = createRoutedMcpRunProvider("/unused", { loadConfig: () => config, complete });

    expect(() => provider.preflight({
      task: "task",
      coderIdentity: "p1/maker",
    })).toThrow(/No eligible trusted MCP model|separation/i);
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects malformed judge JSON and includes trusted plan-revision context", async () => {
    const config = routedConfig();
    const calls: RoutedCompletionRequest[] = [];
    const complete = vi.fn(async (request: RoutedCompletionRequest): Promise<RoutedCompletionResult> => {
      calls.push(request);
      return request.role === "planner"
        ? { text: "1. Revised plan", selectedIndex: 0, fallbackHistory: [] }
        : { text: JSON.stringify({ verdict: "reject", reasons: "No fixes field" }), selectedIndex: 0, fallbackHistory: [] };
    });
    const provider = createRoutedMcpRunProvider("/unused", { loadConfig: () => config, complete });

    await provider.plan({
      task: "task",
      previousPlan: "1. Old plan",
      userFeedback: "Split the migration into two safe stages",
      ...attemptHooks(),
    });
    expect(calls[0]?.prompt).toContain("1. Old plan");
    expect(calls[0]?.prompt).toContain("Split the migration into two safe stages");

    await expect(provider.judge({
      task: "task",
      plan: "plan",
      diff: "diff",
      coderIdentity: "p1/maker",
      iteration: 1,
      consecutiveRejections: 0,
      ...attemptHooks(),
    })).rejects.toThrow(/requires non-empty requiredFixes/);
  });

  it("preflights and returns the frozen coder-family separation declaration without completion", async () => {
    const config = routedConfig();
    config.routing.separation.requireDifferentProviderFamilyFor = ["fast-judge"];
    const complete = vi.fn(async (): Promise<RoutedCompletionResult> => ({ text: "unused", selectedIndex: 0, fallbackHistory: [] }));
    const provider = createRoutedMcpRunProvider("/unused", { loadConfig: () => config, complete });

    expect(provider.preflight({ task: "task", coderIdentity: "p1/maker" })).toEqual({
      coderFamily: "family-a",
      requireDifferentCheckerFamily: true,
    });
    expect(complete).not.toHaveBeenCalled();
  });
});

function attemptHooks() {
  return {
    beforeAttempt: async () => undefined,
    afterAttempt: async () => undefined,
  };
}

function routedConfig(): OrchestratorConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.routing.engine = "capability";
  config.mcp.providers = {
    p1: { baseUrl: "https://p1.example/v1", api: "openai-responses", apiKey: "secret-1" },
    p2: { baseUrl: "https://p2.example/v1", api: "anthropic-messages", apiKey: "secret-2" },
  };
  config.mcp.models = [
    {
      provider: "p1", model: "maker", family: "family-a", reasoning: true,
      supportedThinking: ["off", "high"], input: ["text"], contextWindow: 64_000, maxOutputTokens: 8_000,
    },
    {
      provider: "p2", model: "checker", family: "family-b", reasoning: true,
      supportedThinking: ["off", "high"], input: ["text"], contextWindow: 64_000, maxOutputTokens: 8_000,
    },
  ];
  config.routing.profiles = {
    "p1/maker": {
      family: "family-a", confidence: 9_000, provenance: "user",
      scores: { architecture: 9_500, verification: 9_000, review: 9_000, structuredOutput: 9_000 },
    },
    "p2/checker": {
      family: "family-b", confidence: 9_000, provenance: "user",
      scores: { architecture: 8_000, verification: 8_500, review: 8_500, structuredOutput: 9_000 },
    },
  };
  return config;
}
