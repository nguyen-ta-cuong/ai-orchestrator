import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import lifecycleExtension from "../extensions/lifecycle.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { createRun, readState, writeState } from "../src/lifecycle/artifacts.js";
import type { LifecyclePhase } from "../src/core/lifecycle.js";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<void>;

const tempDirs: string[] = [];

function makeRun(phase: LifecyclePhase) {
  const cwd = join(tmpdir(), `ai-orchestrator-extension-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(cwd, { recursive: true });
  tempDirs.push(cwd);
  const created = createRun(cwd, DEFAULT_CONFIG.lifecycle.artifactsDir, "fix lifecycle races");
  const state = readState(created.paths)!;
  Object.assign(state, {
    phase,
    baselinePaths: [],
    baselineStagedPaths: [],
    originalModel: { provider: "test", id: "original-model", thinking: "high" },
    modelRestored: false,
  });
  writeFileSync(created.paths.spec, "# Specification\n");
  writeFileSync(created.paths.plan, "# Plan\n");
  writeState(created.paths, state);
  return { cwd, paths: created.paths };
}

function extensionHarness(cwd: string, models: Array<Record<string, unknown>> = [{ provider: "anthropic", id: "claude-fable-5" }]) {
  const commands = new Map<string, CommandHandler>();
  const events = new Map<string, EventHandler>();
  let activeTools = ["read", "bash", "agent_team"];
  const exec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
  const pi = {
    registerFlag: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn((name: string, command: { handler: CommandHandler }) => commands.set(name, command.handler)),
    on: vi.fn((name: string, handler: EventHandler) => events.set(name, handler)),
    getActiveTools: vi.fn(() => [...activeTools]),
    setActiveTools: vi.fn((tools: string[]) => { activeTools = [...tools]; }),
    getFlag: vi.fn(() => false),
    getThinkingLevel: vi.fn(() => "high"),
    setThinkingLevel: vi.fn(),
    setModel: vi.fn(async () => true),
    appendEntry: vi.fn(),
    sendUserMessage: vi.fn(),
    sendMessage: vi.fn(),
    exec,
  };
  lifecycleExtension(pi as unknown as ExtensionAPI);

  const ctx = {
    cwd,
    hasUI: true,
    mode: "tui",
    signal: new AbortController().signal,
    model: { provider: "test", id: "current-model" },
    modelRegistry: {
      getAvailable: () => models,
      find: (provider: string, id: string) => ({ provider, id }),
    },
    sessionManager: { getBranch: () => [] },
    ui: {
      confirm: vi.fn(async () => true),
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    waitForIdle: vi.fn(async () => undefined),
    isIdle: vi.fn(() => true),
    abort: vi.fn(),
  } as unknown as ExtensionCommandContext;

  return { commands, events, exec, pi, ctx, activeTools: () => activeTools };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("lifecycle Pi extension safety", () => {
  it("uses capability routing for BUILD and an independent VERIFY model", async () => {
    const run = makeRun("building");
    writeFileSync(join(run.cwd, ".ai-orchestrator.json"), JSON.stringify({
      routing: {
        engine: "capability",
        unknownCost: "allow",
        profiles: {
          "invented/coder": { family: "maker", confidence: 9000, version: "test", scores: { coding: 9500, verification: 6000 } },
          "invented/checker": { family: "checker", confidence: 9000, version: "test", scores: { coding: 6000, verification: 9500 } },
        },
      },
    }));
    const models = ["coder", "checker"].map((id) => ({
      provider: "invented", id, reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 16_000,
    }));
    const buildHarness = extensionHarness(run.cwd, models);
    await buildHarness.commands.get("lifecycle")!("resume", buildHarness.ctx);
    expect(readState(run.paths)?.modelSelections.at(-1)).toMatchObject({
      stage: "build", model: "coder", family: "maker", routing: { engine: "capability" },
    });
    const evidence = JSON.parse(readFileSync(run.paths.evidence, "utf8").trim());
    expect(evidence).toMatchObject({ stage: "build", selected: { provider: "invented", model: "coder" } });
    expect(JSON.stringify(evidence)).not.toContain("# Plan");

    const resumeHarness = extensionHarness(run.cwd, models);
    await resumeHarness.commands.get("lifecycle")!("resume", resumeHarness.ctx);
    expect(readState(run.paths)?.modelSelections).toHaveLength(1);
    expect(readFileSync(run.paths.journal, "utf8")).toContain("reused saved decision");

    const state = readState(run.paths)!;
    state.phase = "verifying";
    writeState(run.paths, state);
    const verifyHarness = extensionHarness(run.cwd, models);
    await verifyHarness.commands.get("lifecycle")!("resume", verifyHarness.ctx);
    expect(readState(run.paths)?.modelSelections.at(-1)).toMatchObject({
      stage: "verify", model: "checker", family: "checker", routing: { separation: "different-family" },
    });
    expect(readFileSync(run.paths.routing, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("pauses before model activation when a routing budget would be exceeded", async () => {
    const run = makeRun("building");
    writeFileSync(join(run.cwd, ".ai-orchestrator.json"), JSON.stringify({
      routing: {
        engine: "capability",
        budgets: { maxEstimatedUsdPerStage: 0.001 },
        profiles: {
          "invented/coder": { confidence: 9000, version: "test", scores: { coding: 9500 } },
        },
      },
    }));
    const harness = extensionHarness(run.cwd, [{
      provider: "invented", id: "coder", reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 16_000,
      cost: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 },
    }]);

    await harness.commands.get("lifecycle")!("resume", harness.ctx);

    expect(harness.pi.setModel).not.toHaveBeenCalledWith(expect.objectContaining({ id: "coder" }));
    expect(readFileSync(run.paths.journal, "utf8")).toContain("paused by routing budget");
  });

  it("does not access runtime tool state while the extension factory is loading", () => {
    const getActiveTools = vi.fn(() => {
      throw new Error("Extension runtime not initialized");
    });
    const pi = {
      registerFlag: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
      getActiveTools,
    };

    expect(() => lifecycleExtension(pi as unknown as ExtensionAPI)).not.toThrow();
    expect(getActiveTools).not.toHaveBeenCalled();
  });

  it("records a typed fallback when the highest-ranked model cannot be activated", async () => {
    const run = makeRun("building");
    writeFileSync(join(run.cwd, ".ai-orchestrator.json"), JSON.stringify({
      routing: {
        engine: "capability", unknownCost: "allow",
        profiles: {
          "invented/first": { confidence: 9000, version: "test", scores: { coding: 9500 } },
          "invented/second": { confidence: 9000, version: "test", scores: { coding: 8500 } },
        },
      },
    }));
    const models = ["first", "second"].map((id) => ({
      provider: "invented", id, reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 16_000,
    }));
    const harness = extensionHarness(run.cwd, models);
    vi.mocked(harness.pi.setModel).mockImplementation(async (model: unknown) => (model as { id: string }).id !== "first");
    await harness.commands.get("lifecycle")!("resume", harness.ctx);
    expect(readState(run.paths)?.modelSelections.at(-1)).toMatchObject({
      model: "second",
      routing: { fallbackCount: 1, attemptedModels: ["invented/first", "invented/second"], failureCategories: ["unavailable"] },
    });
  });

  it("does not expose agent_team during SHIP", async () => {
    const run = makeRun("shipping");
    const harness = extensionHarness(run.cwd);

    await harness.commands.get("lifecycle")!("resume", harness.ctx);

    expect(harness.activeTools()).toEqual(["read", "grep", "find", "ls", "bash", "ship_decision"]);
  });

  it("persists modelRestored on the authoritative runtime state", async () => {
    const run = makeRun("shipping");
    const harness = extensionHarness(run.cwd);
    await harness.commands.get("lifecycle")!("resume", harness.ctx);

    await harness.events.get("session_shutdown")!({}, harness.ctx as unknown as ExtensionContext);

    expect(readState(run.paths)?.modelRestored).toBe(true);
  });

  it("does not commit after a stale confirmation cancels the run", async () => {
    const run = makeRun("finalizing");
    const harness = extensionHarness(run.cwd);
    const confirm = vi.mocked(harness.ctx.ui.confirm);
    confirm.mockImplementationOnce(async () => {
      await harness.commands.get("lifecycle-stop")!("", harness.ctx);
      return true;
    });

    await expect(harness.commands.get("lifecycle")!("resume", harness.ctx)).resolves.toBeUndefined();

    expect(harness.exec).not.toHaveBeenCalledWith("git", expect.arrayContaining(["add"]), expect.anything());
    expect(harness.exec).not.toHaveBeenCalledWith("git", expect.arrayContaining(["commit"]), expect.anything());
  });

  it("does not open a pull request after a stale confirmation cancels the run", async () => {
    const run = makeRun("finalizing");
    const state = readState(run.paths)!;
    state.finalization = { commitSha: "abc123" };
    writeState(run.paths, state);
    const harness = extensionHarness(run.cwd);
    const confirm = vi.mocked(harness.ctx.ui.confirm);
    confirm.mockImplementationOnce(async () => {
      await harness.commands.get("lifecycle-stop")!("", harness.ctx);
      return true;
    });

    await expect(harness.commands.get("lifecycle")!("resume", harness.ctx)).resolves.toBeUndefined();

    expect(harness.exec).not.toHaveBeenCalledWith("gh", expect.arrayContaining(["create"]), expect.anything());
  });
});
