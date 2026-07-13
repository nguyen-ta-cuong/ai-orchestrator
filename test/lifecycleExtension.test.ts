import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  vi.stubEnv("HOME", join(cwd, "home"));
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
  vi.unstubAllEnvs();
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

    await buildHarness.events.get("session_shutdown")!({}, buildHarness.ctx as unknown as ExtensionContext);
    const resumeHarness = extensionHarness(run.cwd, models);
    await resumeHarness.commands.get("lifecycle")!("resume", resumeHarness.ctx);
    expect(readState(run.paths)?.modelSelections).toHaveLength(1);
    expect(readFileSync(run.paths.journal, "utf8")).toContain("reused saved decision");
    await resumeHarness.events.get("session_shutdown")!({}, resumeHarness.ctx as unknown as ExtensionContext);

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

  it("records a fresh routing decision for a later BUILD pass", async () => {
    const run = makeRun("building");
    writeFileSync(join(run.cwd, ".ai-orchestrator.json"), JSON.stringify({
      routing: { engine: "capability", unknownCost: "allow", profiles: {
        "invented/coder": { confidence: 9000, version: "test", scores: { coding: 9500 } },
      } },
    }));
    const models = [{ provider: "invented", id: "coder", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 16000 }];
    const first = extensionHarness(run.cwd, models);
    await first.commands.get("lifecycle")!("resume", first.ctx);
    await first.events.get("session_shutdown")!({}, first.ctx as unknown as ExtensionContext);

    const state = readState(run.paths)!;
    state.buildIterations += 1;
    writeState(run.paths, state);
    const next = extensionHarness(run.cwd, models);
    await next.commands.get("lifecycle")!("resume", next.ctx);

    expect(readState(run.paths)?.modelSelections.filter((selection) => selection.stage === "build")).toHaveLength(2);
  });

  it("exposes routing recommendations as a report without mutating policy", async () => {
    const { cwd } = makeRun("planning");
    const harness = extensionHarness(cwd);
    await harness.commands.get("lifecycle-routing-report")!("", harness.ctx);

    expect(harness.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("No routing recommendation") }),
      { triggerTurn: false },
    );
    expect(existsSync(join(cwd, ".ai-orchestrator.json"))).toBe(false);
  });

  it("rejects missing prerequisite artifacts before changing model or tools", async () => {
    const run = makeRun("planning");
    writeFileSync(run.paths.spec, "");
    const harness = extensionHarness(run.cwd);

    await expect(harness.commands.get("lifecycle")!("resume", harness.ctx)).rejects.toThrow(/spec artifact is missing/);

    expect(harness.pi.setModel).not.toHaveBeenCalled();
    expect(harness.activeTools()).toEqual(["read", "bash", "agent_team"]);
  });

  it("persists stage-ended usage, cost, compliance, and profile evidence", async () => {
    const run = makeRun("building");
    writeFileSync(join(run.cwd, ".ai-orchestrator.json"), JSON.stringify({
      routing: {
        engine: "capability",
        unknownCost: "allow",
        profiles: {
          "invented/coder": { family: "maker", confidence: 9000, version: "coder-profile-v1", scores: { coding: 9500, verification: 6000 } },
          "invented/checker": { family: "checker", confidence: 9000, version: "checker-profile-v1", scores: { coding: 6000, verification: 9500 } },
        },
      },
    }));
    const models = ["coder", "checker"].map((id) => ({
      provider: "invented", id, reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 16_000,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    }));
    const harness = extensionHarness(run.cwd, models);
    await harness.commands.get("lifecycle")!("resume", harness.ctx);
    await harness.events.get("message_end")!({
      message: { role: "assistant", usage: { input: 1000, output: 200, cacheRead: 50, cacheWrite: 10, cost: { total: 0.012 } } },
    }, harness.ctx as unknown as ExtensionContext);
    await harness.events.get("agent_end")!({ messages: [{ role: "assistant", content: "implemented" }] }, harness.ctx as unknown as ExtensionContext);
    await harness.events.get("agent_settled")!({}, harness.ctx as unknown as ExtensionContext);

    const events = readFileSync(run.paths.evidence, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events).toContainEqual(expect.objectContaining({
      stage: "build",
      profileVersion: "coder-profile-v1",
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 10 },
      cost: expect.objectContaining({ observedUsd: 0.012 }),
      outcome: expect.objectContaining({ type: "stage-ended", structuredToolCompliance: true }),
    }));
    const userEvents = readFileSync(join(run.cwd, "home", ".ai-orchestrator", "routing-evidence", "events.jsonl"), "utf8");
    expect(userEvents).toContain("coder-profile-v1");
    expect(userEvents).toContain('"type":"stage-ended"');
  });

  it("pauses a resumed run when its frozen routing policy changes", async () => {
    const run = makeRun("building");
    const configPath = join(run.cwd, ".ai-orchestrator.json");
    const writeRoutingConfig = (coding: number) => writeFileSync(configPath, JSON.stringify({
      routing: {
        engine: "capability",
        unknownCost: "allow",
        profiles: { "invented/coder": { confidence: 9000, version: `v-${coding}`, scores: { coding } } },
      },
    }));
    writeRoutingConfig(9500);
    const models = [{ provider: "invented", id: "coder", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 16000 }];
    const first = extensionHarness(run.cwd, models);
    await first.commands.get("lifecycle")!("resume", first.ctx);
    await first.events.get("session_shutdown")!({}, first.ctx as unknown as ExtensionContext);

    writeRoutingConfig(9000);
    const resumed = extensionHarness(run.cwd, models);
    await resumed.commands.get("lifecycle")!("resume", resumed.ctx);

    expect(readFileSync(run.paths.journal, "utf8")).toContain("routing policy changed");
    expect(readState(run.paths)?.phase).toBe("building");
    expect(resumed.pi.sendUserMessage).not.toHaveBeenCalled();

    await resumed.commands.get("lifecycle")!("migrate-routing", resumed.ctx);
    expect(readFileSync(run.paths.journal, "utf8")).toContain("Routing policy explicitly migrated");
    const migrated = extensionHarness(run.cwd, models);
    await migrated.commands.get("lifecycle")!("resume", migrated.ctx);
    expect(migrated.pi.sendUserMessage).toHaveBeenCalled();
    expect(readState(run.paths)?.modelSelections.at(-1)?.routing?.failureCategories).not.toContain("policy-migrated");
  });

  it.each([
    [{ rejectionFingerprints: ["aaaaaaaaaaaaaaaa", "aaaaaaaaaaaaaaaa"] }, { repeatedRejectionFingerprintLimit: 2 }, "identical checker rejections"],
    [{ buildEvidenceFingerprints: ["bbbbbbbbbbbbbbbb", "bbbbbbbbbbbbbbbb"] }, { maxBuildPassesWithoutImprovement: 1 }, "unchanged evidence"],
  ] as const)("pauses BUILD when a convergence circuit breaker trips %#", async (statePatch, breakerPatch, reason) => {
    const run = makeRun("building");
    const state = readState(run.paths)!;
    Object.assign(state, statePatch);
    writeState(run.paths, state);
    writeFileSync(join(run.cwd, ".ai-orchestrator.json"), JSON.stringify({ routing: { circuitBreakers: breakerPatch } }));
    const harness = extensionHarness(run.cwd);

    await harness.commands.get("lifecycle")!("resume", harness.ctx);

    expect(readFileSync(run.paths.journal, "utf8")).toContain(reason);
    expect(harness.pi.sendUserMessage).not.toHaveBeenCalled();
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
    harness.ctx.ui.confirm = vi.fn(async () => false);

    await harness.commands.get("lifecycle")!("resume", harness.ctx);

    expect(harness.pi.setModel).not.toHaveBeenCalledWith(expect.objectContaining({ id: "coder" }));
    expect(readFileSync(run.paths.journal, "utf8")).toContain("paused by routing budget");
  });

  it("counts prior user-store events toward the daily routing ceiling", async () => {
    const run = makeRun("building");
    writeFileSync(join(run.cwd, ".ai-orchestrator.json"), JSON.stringify({
      routing: {
        engine: "capability",
        budgets: { maxEstimatedUsdPerDay: 0.5 },
        evidence: { enabled: false },
        profiles: { "invented/coder": { confidence: 9000, scores: { coding: 9500 } } },
      },
    }));
    const harness = extensionHarness(run.cwd, [{
      provider: "invented", id: "coder", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 16000,
      cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    }]);
    harness.ctx.ui.confirm = vi.fn(async () => false);
    const userStore = join(run.cwd, "home", ".ai-orchestrator", "routing-evidence");
    mkdirSync(userStore, { recursive: true });
    writeFileSync(join(userStore, "budget.jsonl"), `${JSON.stringify({
      version: 1, eventId: "prior", runId: "prior-run", recordedAt: new Date().toISOString(),
      outcome: "stage-started", estimatedUsd: 0.5,
    })}\n`);

    await harness.commands.get("lifecycle")!("resume", harness.ctx);

    expect(readFileSync(run.paths.journal, "utf8")).toContain("daily estimated budget");
    expect(harness.pi.setModel).not.toHaveBeenCalledWith(expect.objectContaining({ id: "coder" }));
    expect(existsSync(join(userStore, "events.jsonl"))).toBe(false);
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

  it("persists provider errors and resumes with the next eligible candidate", async () => {
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
    const first = extensionHarness(run.cwd, models);
    await first.commands.get("lifecycle")!("resume", first.ctx);
    await first.events.get("message_end")!({ message: { role: "assistant", usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.03 } } } }, first.ctx as unknown as ExtensionContext);
    await first.events.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "error" }] }, first.ctx as unknown as ExtensionContext);
    await first.events.get("agent_settled")!({}, first.ctx as unknown as ExtensionContext);

    const resumed = extensionHarness(run.cwd, models);
    await resumed.commands.get("lifecycle")!("resume", resumed.ctx);

    expect(readState(run.paths)?.modelSelections).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: "first", routing: expect.objectContaining({ failureCategories: expect.arrayContaining(["provider-error"]) }) }),
      expect.objectContaining({ model: "second", routing: expect.objectContaining({ fallbackCount: 0 }) }),
    ]));
    const ledger = readFileSync(join(run.cwd, "home", ".ai-orchestrator", "routing-evidence", "budget.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(ledger).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: "stage-ended", observedUsd: 0.03 })]));
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

  it("keeps BUILD away from artifacts/publication and keeps PLAN bash read-only", async () => {
    const buildRun = makeRun("building");
    const buildHarness = extensionHarness(buildRun.cwd);
    await buildHarness.commands.get("lifecycle")!("resume", buildHarness.ctx);

    await expect(buildHarness.events.get("tool_call")!({ toolName: "bash", input: { command: "git push origin main" } }, buildHarness.ctx as unknown as ExtensionContext)).resolves.toMatchObject({ block: true });
    await expect(buildHarness.events.get("tool_call")!({ toolName: "bash", input: { command: "git -C . commit -am bypass" } }, buildHarness.ctx as unknown as ExtensionContext)).resolves.toMatchObject({ block: true });
    await expect(buildHarness.events.get("tool_call")!({ toolName: "bash", input: { command: "rm -rf .ai-orchestrator" } }, buildHarness.ctx as unknown as ExtensionContext)).resolves.toMatchObject({ block: true });
    await expect(buildHarness.events.get("tool_call")!({ toolName: "bash", input: { command: "git reset --hard" } }, buildHarness.ctx as unknown as ExtensionContext)).resolves.toMatchObject({ block: true });
    await expect(buildHarness.events.get("tool_call")!({ toolName: "edit", input: { path: buildRun.paths.plan } }, buildHarness.ctx as unknown as ExtensionContext)).resolves.toMatchObject({ block: true });
    await expect(buildHarness.events.get("tool_call")!({ toolName: "edit", input: { path: join(buildRun.cwd, "src.ts") } }, buildHarness.ctx as unknown as ExtensionContext)).resolves.toBeUndefined();

    const planRun = makeRun("planning");
    writeFileSync(join(planRun.cwd, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    const planHarness = extensionHarness(planRun.cwd);
    await planHarness.commands.get("lifecycle")!("resume", planHarness.ctx);
    await expect(planHarness.events.get("tool_call")!({ toolName: "bash", input: { command: "npm test" } }, planHarness.ctx as unknown as ExtensionContext)).resolves.toMatchObject({ block: true });
    await expect(planHarness.events.get("tool_call")!({ toolName: "bash", input: { command: "git diff" } }, planHarness.ctx as unknown as ExtensionContext)).resolves.toBeUndefined();
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

  it("retains terminal ownership until failed model restoration is retried", async () => {
    const run = makeRun("finalizing");
    const harness = extensionHarness(run.cwd);
    vi.mocked(harness.pi.setModel).mockResolvedValue(false);

    await harness.commands.get("ship")!("", harness.ctx);

    expect(readState(run.paths)).toMatchObject({ phase: "done", modelRestored: false });
    expect(existsSync(join(run.paths.root, "..", "current"))).toBe(true);

    vi.mocked(harness.pi.setModel).mockResolvedValue(true);
    await harness.commands.get("lifecycle")!("resume", harness.ctx);
    expect(readState(run.paths)?.modelRestored).toBe(true);
    expect(existsSync(join(run.paths.root, "..", "current"))).toBe(false);
  });

  it("resumes standalone SHIP from finalizing", async () => {
    const run = makeRun("finalizing");
    const harness = extensionHarness(run.cwd);

    await harness.commands.get("ship")!("", harness.ctx);

    expect(readState(run.paths)?.phase).toBe("done");
  });

  it("recovers a commit created before its SHA checkpoint was persisted", async () => {
    const run = makeRun("finalizing");
    const state = readState(run.paths)!;
    state.finalization = { commitBaseSha: "base123", commitMessage: "Implement recovered work" };
    writeState(run.paths, state);
    writeFileSync(join(run.cwd, ".ai-orchestrator.json"), JSON.stringify({ ship: { openPr: "never" } }));
    const harness = extensionHarness(run.cwd);
    harness.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === "git" && args.join(" ") === "rev-parse HEAD") return { code: 0, stdout: "new456\n", stderr: "" };
      if (command === "git" && args.join(" ") === "rev-parse HEAD^") return { code: 0, stdout: "base123\n", stderr: "" };
      if (command === "git" && args.join(" ") === "log -1 --format=%s") return { code: 0, stdout: "Implement recovered work\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });

    await harness.commands.get("lifecycle")!("resume", harness.ctx);

    expect(readState(run.paths)).toMatchObject({ phase: "done", finalization: { commitSha: "new456" } });
    expect(harness.exec).not.toHaveBeenCalledWith("git", expect.arrayContaining(["commit"]), expect.anything());
  });

  it("refuses PR creation until an explicitly pushed upstream matches HEAD", async () => {
    const run = makeRun("finalizing");
    const state = readState(run.paths)!;
    state.finalization = { commitSha: "abc123" };
    writeState(run.paths, state);
    const harness = extensionHarness(run.cwd);

    await harness.commands.get("lifecycle")!("resume", harness.ctx);

    expect(harness.exec).toHaveBeenCalledWith("git", ["rev-parse", "@{upstream}"], expect.anything());
    expect(harness.exec).not.toHaveBeenCalledWith("gh", expect.arrayContaining(["create"]), expect.anything());
    expect(harness.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("explicitly pushed"), "error");
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
