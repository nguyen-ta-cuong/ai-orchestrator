import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, UNCONFIGURED_FABLE_BASE_URL, loadConfig, loopConfigFrom } from "../src/core/config.js";

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
            baseUrl: "$CUSTOM_BASE_URL",
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
    expect(config.mcp.providers.custom.baseUrl).toBe("$CUSTOM_BASE_URL");
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
