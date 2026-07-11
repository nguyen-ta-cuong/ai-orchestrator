import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

function extensionHarness(cwd: string) {
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
      getAvailable: () => [{ provider: "anthropic", id: "claude-fable-5" }],
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
