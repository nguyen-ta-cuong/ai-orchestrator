import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, UNCONFIGURED_FABLE_BASE_URL, loadConfig, loadConfigWithProvenance, loopConfigFrom } from "../src/core/config.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join(tmpdir(), `ai-orchestrator-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadConfig", () => {
  it("reports explicit role identity provenance without treating thinking-only changes as pins", () => {
    const home = makeTempDir();
    const project = makeTempDir();
    mkdirSync(join(home, ".ai-orchestrator"), { recursive: true });
    vi.stubEnv("HOME", home);
    writeJson(join(home, ".ai-orchestrator", "config.json"), {
      roles: { coder: { model: "user-coder" }, judge: { thinking: "medium" } },
    });
    writeJson(join(project, ".ai-orchestrator.json"), {
      roles: { planner: { provider: "project-provider" } },
    });

    expect(loadConfigWithProvenance(project).provenance.roles).toMatchObject({
      planner: "project",
      coder: "user",
      judge: "builtin",
      verifier: "builtin",
    });
  });

  it("applies precedence: project config beats user config which beats defaults", () => {
    const home = makeTempDir();
    const project = makeTempDir();
    mkdirSync(join(home, ".ai-orchestrator"), { recursive: true });
    vi.stubEnv("HOME", home);

    writeJson(join(home, ".ai-orchestrator", "config.json"), {
      roles: {
        planner: { model: "user-planner" },
        coder: { provider: "user-openai", model: "user-coder", thinking: "high" },
      },
      loop: { maxCoderIterations: 5 },
      judge: { runTests: false },
    });
    writeJson(join(project, ".ai-orchestrator.json"), {
      roles: {
        planner: { model: "project-planner", thinking: "medium" },
      },
      approval: { requirePlanApproval: false },
    });

    const config = loadConfig(project);

    expect(config.roles.planner).toEqual({
      provider: DEFAULT_CONFIG.roles.planner.provider,
      model: "project-planner",
      thinking: "medium",
    });
    expect(config.roles.coder).toEqual({
      provider: "user-openai",
      model: "user-coder",
      thinking: "high",
    });
    expect(config.loop.maxCoderIterations).toBe(5);
    expect(config.loop.plannerEscalationAfterRejections).toBe(2);
    expect(config.approval.requirePlanApproval).toBe(false);
    expect(config.judge.runTests).toBe(false);
  });

  it("interpolates mcp provider apiKey values from environment variables only", () => {
    const home = makeTempDir();
    const project = makeTempDir();
    vi.stubEnv("HOME", home);
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-secret");
    vi.stubEnv("FABLE_API_KEY", "fable-secret");
    vi.stubEnv("OPENAI_API_KEY", "openai-secret");
    vi.stubEnv("CUSTOM_API_KEY", "custom-secret");

    writeJson(join(project, ".ai-orchestrator.json"), {
      mcp: {
        providers: {
          custom: {
            baseUrl: "https://custom.example/v1",
            api: "openai-completions",
            apiKey: "$CUSTOM_API_KEY",
          },
        },
      },
    });

    const config = loadConfig(project);

    expect(config.mcp.providers.anthropic.apiKey).toBe("anthropic-secret");
    expect(config.mcp.providers.fable.apiKey).toBe("fable-secret");
    expect(config.mcp.providers.openai.apiKey).toBe("openai-secret");
    expect(config.mcp.providers.custom.apiKey).toBe("custom-secret");
    expect(config.mcp.providers.custom.baseUrl).toBe("https://custom.example/v1");
  });

  it("rejects near-miss apiKey environment reference syntax instead of sending it as a literal key", () => {
    const home = makeTempDir();
    const project = makeTempDir();
    vi.stubEnv("HOME", home);

    writeJson(join(project, ".ai-orchestrator.json"), {
      mcp: { providers: { custom: { baseUrl: "https://example.test", api: "openai-responses", apiKey: "${CUSTOM_API_KEY}" } } },
    });

    expect(() => loadConfig(project)).toThrow(/Invalid mcp provider apiKey environment reference/);
  });

  it("omits missing apiKey environment variables instead of silently using an empty string", () => {
    const home = makeTempDir();
    const project = makeTempDir();
    vi.stubEnv("HOME", home);
    vi.stubEnv("MISSING_API_KEY", undefined);

    writeJson(join(project, ".ai-orchestrator.json"), {
      mcp: { providers: { custom: { baseUrl: "https://example.test", api: "openai-responses", apiKey: "$MISSING_API_KEY" } } },
    });

    expect(loadConfig(project).mcp.providers.custom.apiKey).toBeUndefined();
  });

  it("rejects non-HTTPS MCP provider base URLs", () => {
    const home = makeTempDir();
    const project = makeTempDir();
    vi.stubEnv("HOME", home);

    writeJson(join(project, ".ai-orchestrator.json"), {
      mcp: { providers: { custom: { baseUrl: "http://example.test/v1", api: "openai-responses", apiKey: "literal-key" } } },
    });

    expect(() => loadConfig(project)).toThrow("mcp.providers.custom.baseUrl must use https:");
  });

  it("rejects invalid MCP provider base URLs", () => {
    const home = makeTempDir();
    const project = makeTempDir();
    vi.stubEnv("HOME", home);

    writeJson(join(project, ".ai-orchestrator.json"), {
      mcp: { providers: { custom: { baseUrl: "not a url", api: "openai-responses", apiKey: "literal-key" } } },
    });

    expect(() => loadConfig(project)).toThrow("mcp.providers.custom.baseUrl must be a valid HTTPS URL");
  });

  it("uses an intentionally invalid placeholder until the Fable MCP endpoint is configured", () => {
    const home = makeTempDir();
    const project = makeTempDir();
    vi.stubEnv("HOME", home);

    expect(loadConfig(project).mcp.providers.fable.baseUrl).toBe(UNCONFIGURED_FABLE_BASE_URL);
  });

  it("can ignore mcp provider overrides for the pi surface", () => {
    const home = makeTempDir();
    const project = makeTempDir();
    vi.stubEnv("HOME", home);

    writeJson(join(project, ".ai-orchestrator.json"), {
      roles: { planner: { model: "project-planner" } },
      mcp: { providers: { custom: { apiKey: "$CUSTOM_API_KEY" } } },
    });

    expect(() => loadConfig(project)).toThrow("mcp.providers.custom.baseUrl must be a non-empty string");
    const piConfig = loadConfig(project, { ignoreMcpProviders: true });
    expect(piConfig.roles.planner.model).toBe("project-planner");
    expect(piConfig.mcp.providers.custom).toBeUndefined();
  });

  it("can ignore only project mcp provider overrides for the MCP surface", () => {
    const home = makeTempDir();
    const project = makeTempDir();
    mkdirSync(join(home, ".ai-orchestrator"), { recursive: true });
    vi.stubEnv("HOME", home);
    vi.stubEnv("USER_API_KEY", "user-secret");
    vi.stubEnv("PROJECT_API_KEY", "project-secret");

    writeJson(join(home, ".ai-orchestrator", "config.json"), {
      mcp: {
        providers: {
          custom: { baseUrl: "https://user.example/v1", api: "openai-responses", apiKey: "$USER_API_KEY" },
        },
      },
    });
    writeJson(join(project, ".ai-orchestrator.json"), {
      roles: { planner: { provider: "custom" } },
      mcp: {
        providers: {
          custom: { baseUrl: "https://attacker.example/v1", api: "openai-responses", apiKey: "$PROJECT_API_KEY" },
        },
      },
    });

    const config = loadConfig(project, { ignoreProjectMcpProviders: true });
    expect(config.roles.planner.provider).toBe("custom");
    expect(config.mcp.providers.custom).toEqual({
      baseUrl: "https://user.example/v1",
      api: "openai-responses",
      apiKey: "user-secret",
    });
  });

  it("does not merge prototype-pollution keys from config files", () => {
    const home = makeTempDir();
    const project = makeTempDir();
    vi.stubEnv("HOME", home);

    writeFileSync(
      join(project, ".ai-orchestrator.json"),
      '{"__proto__":{"polluted":true},"constructor":{"polluted":true},"roles":{"planner":{"model":"safe"}}}\n',
    );

    const config = loadConfig(project);
    expect(config.roles.planner.model).toBe("safe");
    expect((config as unknown as { polluted?: boolean }).polluted).toBeUndefined();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("rejects non-object config roots with the config file path", () => {
    const home = makeTempDir();
    const project = makeTempDir();
    vi.stubEnv("HOME", home);
    const projectConfigPath = join(project, ".ai-orchestrator.json");

    writeJson(projectConfigPath, null);

    expect(() => loadConfig(project)).toThrow(`Failed to read orchestrator config at ${projectConfigPath}: config root must be a JSON object`);
  });

  it("rejects invalid config values with precise paths", () => {
    const home = makeTempDir();
    const project = makeTempDir();
    vi.stubEnv("HOME", home);

    writeJson(join(project, ".ai-orchestrator.json"), {
      roles: { planner: { thinking: "maximum" } },
      loop: { maxCoderIterations: "3" },
    });

    expect(() => loadConfig(project)).toThrow("roles.planner.thinking must be one of");
  });

  it("adds lifecycle roles and options with safe defaults", () => {
    const home = makeTempDir();
    const project = makeTempDir();
    vi.stubEnv("HOME", home);

    const config = loadConfig(project);

    expect(config.roles.spec).toEqual(DEFAULT_CONFIG.roles.spec);
    expect(config.roles.verifier.model).toBe("claude-fable-5");
    expect(config.roles.reviewer.thinking).toBe("xhigh");
    expect(config.roles.debugger.model).toBe("claude-fable-5");
    expect(config.roles.shipper.provider).toBe("anthropic");
    expect(config.routing.lifecycle.enabled).toBe(true);
    expect(config.routing.lifecycle.stages.define[0].model).toBe("claude-fable-5");
    expect(config.routing.lifecycle.stages.verify[0].model).toBe("gpt-5.6-sol");
    expect(config.routing.engine).toBe("capability-shadow");
    expect(config.routing.mode).toBe("balanced");
    expect(config.routing.evidence).toMatchObject({ enabled: true, userStoreDir: "routing-evidence", minRecommendationSamples: 10 });
    expect(config.routing.budgets.maxEstimatedUsdPerRun).toBe(8);
    expect(config.routing.circuitBreakers.maxSelectionFailures).toBe(3);
    expect(config.lifecycle.artifactsDir).toBe(".ai-orchestrator/runs");
    expect(config.build.commitPerTask).toBe(false);
    expect(config.ship).toEqual({ commit: "ask", openPr: "ask" });
  });

  it("loads additive capability routing policy without changing legacy routes", () => {
    const home = makeTempDir();
    const project = makeTempDir();
    vi.stubEnv("HOME", home);
    writeJson(join(project, ".ai-orchestrator.json"), {
      routing: {
        engine: "legacy",
        mode: "quality",
        deny: { models: ["unsafe/model"] },
        limits: { maxEstimatedUsdPerRun: 3, maxAttemptsPerStage: 2 },
        budgets: { maxEstimatedUsdPerRun: 3, maxEstimatedUsdPerStage: 1, allowUnknownCost: false },
        circuitBreakers: { maxSelectionFailures: 2 },
        evidence: { enabled: false, minRecommendationSamples: 20 },
        stages: { review: { minimumScores: { review: 8_000 }, prefer: ["custom/reviewer"] } },
        profiles: {
          "custom/reviewer": {
            family: "review-family",
            confidence: 9_000,
            provenance: "project",
            version: "v1",
            scores: { review: 9_000, architecture: 8_000 },
          },
        },
      },
    });

    const config = loadConfig(project);
    expect(config.routing.engine).toBe("legacy");
    expect(config.routing.mode).toBe("quality");
    expect(config.routing.budgets.maxEstimatedUsdPerStage).toBe(1);
    expect(config.routing.budgets.allowUnknownCost).toBe(false);
    expect(config.routing.circuitBreakers.maxSelectionFailures).toBe(2);
    expect(config.routing.evidence.enabled).toBe(false);
    expect(config.routing.profiles["custom/reviewer"]?.scores.review).toBe(9_000);
    expect(config.routing.lifecycle.stages.review).toEqual(DEFAULT_CONFIG.routing.lifecycle.stages.review);
  });

  it("prevents project config from loosening user routing ceilings or deny rules", () => {
    const home = makeTempDir();
    const project = makeTempDir();
    mkdirSync(join(home, ".ai-orchestrator"), { recursive: true });
    vi.stubEnv("HOME", home);
    writeJson(join(home, ".ai-orchestrator", "config.json"), {
      routing: {
        deny: { providers: ["denied-provider"], models: ["denied/model"] },
        limits: { maxEstimatedUsdPerRun: 2, maxAttemptsPerStage: 2 },
        budgets: { maxEstimatedUsdPerRun: 2, maxEstimatedUsdPerStage: 1, allowUnknownCost: false, maxPaidFallbacksPerRun: 1 },
        circuitBreakers: { maxSelectionFailures: 2, requireIndependentChecker: true },
        separation: { checkerMustDifferFromBuilder: true, requireDifferentProviderFamilyFor: ["review"] },
      },
    });
    writeJson(join(project, ".ai-orchestrator.json"), {
      routing: {
        deny: { providers: [], models: [] },
        limits: { maxEstimatedUsdPerRun: 20, maxAttemptsPerStage: 8 },
        budgets: { maxEstimatedUsdPerRun: 20, maxEstimatedUsdPerStage: 10, allowUnknownCost: true, maxPaidFallbacksPerRun: 9 },
        circuitBreakers: { maxSelectionFailures: 9, requireIndependentChecker: false },
        separation: { checkerMustDifferFromBuilder: false, requireDifferentProviderFamilyFor: [] },
      },
    });

    const config = loadConfig(project);
    expect(config.routing.deny.providers).toContain("denied-provider");
    expect(config.routing.deny.models).toContain("denied/model");
    expect(config.routing.limits).toEqual({ maxEstimatedUsdPerRun: 2, maxAttemptsPerStage: 2 });
    expect(config.routing.budgets.maxEstimatedUsdPerRun).toBe(2);
    expect(config.routing.budgets.maxEstimatedUsdPerStage).toBe(1);
    expect(config.routing.budgets.allowUnknownCost).toBe(false);
    expect(config.routing.budgets.maxPaidFallbacksPerRun).toBe(1);
    expect(config.routing.circuitBreakers.maxSelectionFailures).toBe(2);
    expect(config.routing.circuitBreakers.requireIndependentChecker).toBe(true);
    expect(config.routing.separation.checkerMustDifferFromBuilder).toBe(true);
    expect(config.routing.separation.requireDifferentProviderFamilyFor).toContain("review");
  });

  it.each([
    [{ routing: { engine: "automatic" } }, "routing.engine must be one of"],
    [{ routing: { mode: "fastest" } }, "routing.mode must be one of"],
    [{ routing: { deny: { providers: "unsafe" } } }, "routing.deny.providers must be an array"],
    [{ routing: { separation: { checkerMustDifferFromBuilder: "yes" } } }, "routing.separation.checkerMustDifferFromBuilder must be a boolean"],
    [{ routing: { profiles: { "": { confidence: 1, scores: {} } } } }, "routing.profiles keys must be non-empty provider/model identities"],
    [{ routing: { profiles: { "p/m": { confidence: 10_001, scores: {} } } } }, "routing.profiles.p/m.confidence must be an integer between 0 and 10000"],
    [{ routing: { profiles: { "p/m": { confidence: 1, provenance: "marketing", scores: {} } } } }, "routing.profiles.p/m.provenance must be one of"],
    [{ routing: { profiles: { "p/m": { confidence: 1, scores: { coding: -1 } } } } }, "routing.profiles.p/m.scores.coding must be an integer between 0 and 10000"],
    [{ routing: { stages: { review: { minimumScores: { review: 10_001 } } } } }, "routing.stages.review.minimumScores.review must be an integer between 0 and 10000"],
    [{ routing: { limits: { maxEstimatedUsdPerRun: -1 } } }, "routing.limits.maxEstimatedUsdPerRun must be a non-negative number"],
    [{ routing: { budgets: { maxEstimatedUsdPerRun: -1 } } }, "routing.budgets.maxEstimatedUsdPerRun must be a non-negative number"],
    [{ routing: { evidence: { userStoreDir: "../outside" } } }, "routing.evidence.userStoreDir must be a relative path inside the user ai-orchestrator directory"],
    [{ routing: { circuitBreakers: { maxSelectionFailures: 0 } } }, "routing.circuitBreakers.maxSelectionFailures must be a positive integer"],
  ])("rejects invalid capability routing config %#", (patch, message) => {
    const home = makeTempDir();
    const project = makeTempDir();
    vi.stubEnv("HOME", home);
    writeJson(join(project, ".ai-orchestrator.json"), patch);
    expect(() => loadConfig(project)).toThrow(message);
  });

  it("allows project config to override lifecycle roles and options", () => {
    const home = makeTempDir();
    const project = makeTempDir();
    vi.stubEnv("HOME", home);

    writeJson(join(project, ".ai-orchestrator.json"), {
      roles: {
        spec: { provider: "cheap", model: "fast-planner", thinking: "high" },
        verifier: { model: "fast-verifier" },
      },
      lifecycle: { artifactsDir: ".orch/runs" },
      routing: {
        lifecycle: {
          stages: {
            debug: [{ provider: "local", model: "debug-model", thinking: "high" }],
          },
        },
      },
      build: { commitPerTask: true },
      ship: { commit: "auto", openPr: "never" },
    });

    const config = loadConfig(project);
    expect(config.roles.spec).toEqual({ provider: "cheap", model: "fast-planner", thinking: "high" });
    expect(config.roles.verifier.model).toBe("fast-verifier");
    expect(config.roles.verifier.provider).toBe(DEFAULT_CONFIG.roles.verifier.provider);
    expect(config.lifecycle.artifactsDir).toBe(".orch/runs");
    expect(config.routing.lifecycle.stages.debug).toEqual([
      { provider: "local", model: "debug-model", thinking: "high" },
    ]);
    expect(config.routing.lifecycle.stages.verify).toEqual(DEFAULT_CONFIG.routing.lifecycle.stages.verify);
    expect(config.build.commitPerTask).toBe(true);
    expect(config.ship).toEqual({ commit: "auto", openPr: "never" });
  });

  it("rejects unsafe lifecycle paths and invalid ship modes", () => {
    const home = makeTempDir();
    const project = makeTempDir();
    vi.stubEnv("HOME", home);

    for (const artifactsDir of ["../outside", "..\\outside", "a/../../outside", "/tmp/outside", "C:outside"] as const) {
      writeJson(join(project, ".ai-orchestrator.json"), {
        lifecycle: { artifactsDir },
      });
      expect(() => loadConfig(project), artifactsDir).toThrow("lifecycle.artifactsDir must be a relative path inside the project");
    }

    for (const artifactsDir of ["runs", ".", "a/../runs"] as const) {
      writeJson(join(project, ".ai-orchestrator.json"), {
        lifecycle: { artifactsDir },
      });
      expect(() => loadConfig(project), artifactsDir).toThrow(
        "lifecycle.artifactsDir must contain a dedicated parent directory and child directory inside the project",
      );
    }

    writeJson(join(project, ".ai-orchestrator.json"), {
      ship: { commit: "sometimes" },
    });
    expect(() => loadConfig(project)).toThrow("ship.commit must be one of ask, never, auto");

    writeJson(join(project, ".ai-orchestrator.json"), {
      ship: { openPr: "auto" },
    });
    expect(() => loadConfig(project)).toThrow("ship.openPr must be one of ask, never");
  });

  it("rejects empty or malformed lifecycle routing candidates", () => {
    const home = makeTempDir();
    const project = makeTempDir();
    vi.stubEnv("HOME", home);

    writeJson(join(project, ".ai-orchestrator.json"), {
      routing: { lifecycle: { stages: { verify: [] } } },
    });
    expect(() => loadConfig(project)).toThrow("routing.lifecycle.stages.verify must be a non-empty array");

    writeJson(join(project, ".ai-orchestrator.json"), {
      routing: { lifecycle: { stages: { verify: [{ provider: "openai-codex", model: "gpt-5.6-sol", thinking: "maximum" }] } } },
    });
    expect(() => loadConfig(project)).toThrow("routing.lifecycle.stages.verify[0].thinking must be one of");
  });

  it("maps shared config to loop config", () => {
    const loopConfig = loopConfigFrom({
      ...DEFAULT_CONFIG,
      loop: { maxCoderIterations: 7, plannerEscalationAfterRejections: 4 },
      approval: { requirePlanApproval: false },
    });

    expect(loopConfig).toEqual({
      maxCoderIterations: 7,
      plannerEscalationAfterRejections: 4,
      requirePlanApproval: false,
    });
  });
});
