import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import orchestratorExtension from "../extensions/orchestrator.js";

const dirs: string[] = [];

describe("fast Pi capability routing", () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("routes planner, coder, and an independent judge without changing loop transitions", async () => {
    const cwd = join(tmpdir(), `ai-orchestrator-fast-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(cwd, { recursive: true });
    dirs.push(cwd);
    vi.stubEnv("HOME", join(cwd, "home"));
    writeFileSync(join(cwd, ".ai-orchestrator.json"), JSON.stringify({
      routing: {
        engine: "capability",
        unknownCost: "allow",
        profiles: {
          "invented/planner": { family: "architect", confidence: 9000, version: "test", scores: { architecture: 9500, coding: 6000, verification: 6000, review: 6000 } },
          "invented/planner-backup": { family: "architect-backup", confidence: 9000, version: "test", scores: { architecture: 8500, coding: 6000, verification: 6000, review: 6000 } },
          "invented/coder": { family: "maker", confidence: 9000, version: "test", scores: { architecture: 6000, coding: 9500, verification: 6000, review: 6000 } },
          "invented/checker": { family: "checker", confidence: 9000, version: "test", scores: { architecture: 6000, coding: 6000, verification: 9500, review: 9500 } },
        },
      },
    }));
    const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
    const events = new Map<string, (event: any, ctx: ExtensionContext) => Promise<void>>();
    let activeTools = ["read", "edit", "bash"];
    const setModel = vi.fn(async () => true);
    const appendEntry = vi.fn();
    const pi = {
      registerFlag: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn((name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => commands.set(name, command.handler)),
      on: vi.fn((name: string, handler: (event: any, ctx: ExtensionContext) => Promise<void>) => events.set(name, handler)),
      getFlag: vi.fn(() => false),
      getThinkingLevel: vi.fn(() => "high"),
      setThinkingLevel: vi.fn(),
      setModel,
      getActiveTools: vi.fn(() => [...activeTools]),
      setActiveTools: vi.fn((tools: string[]) => { activeTools = [...tools]; }),
      appendEntry,
      sendUserMessage: vi.fn(),
      sendMessage: vi.fn(),
      exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    };
    orchestratorExtension(pi as unknown as ExtensionAPI);
    const models = ["planner", "planner-backup", "coder", "checker"].map((id) => ({
      provider: "invented", id, reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 16_000,
    }));
    const ctx = {
      cwd,
      hasUI: true,
      mode: "tui",
      signal: new AbortController().signal,
      model: { provider: "original", id: "model" },
      modelRegistry: { getAvailable: () => models, find: (provider: string, id: string) => ({ provider, id }) },
      sessionManager: { getBranch: () => [] },
      ui: { notify: vi.fn(), select: vi.fn(async () => "Approve and code"), editor: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
      waitForIdle: vi.fn(async () => undefined),
      isIdle: vi.fn(() => true),
      abort: vi.fn(),
    } as unknown as ExtensionCommandContext;

    await commands.get("orchestrate")!("--yolo build a feature", ctx);
    expect(activeTools).toEqual(["read", "grep", "find", "ls", "bash"]);
    await expect(events.get("tool_call")!({ toolName: "edit", input: {} }, ctx as unknown as ExtensionContext)).resolves.toMatchObject({ block: true });
    await expect(events.get("tool_call")!({ toolName: "bash", input: { command: "rm -rf src" } }, ctx as unknown as ExtensionContext)).resolves.toMatchObject({ block: true });

    await events.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "error" }] }, ctx as unknown as ExtensionContext);
    await events.get("agent_settled")!({}, ctx as unknown as ExtensionContext);
    expect(setModel.mock.calls.map(([model]) => (model as { id: string }).id)).toEqual(["planner", "planner-backup"]);

    await events.get("message_end")!({ message: { role: "assistant", usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } } } }, ctx as unknown as ExtensionContext);
    await events.get("agent_end")!({ messages: [{ role: "assistant", content: "Implementation plan" }] }, ctx as unknown as ExtensionContext);
    expect(activeTools).toEqual(["read", "grep", "find", "ls", "bash"]);
    await events.get("agent_settled")!({}, ctx as unknown as ExtensionContext);
    expect(activeTools).toEqual(["read", "edit", "bash"]);
    await expect(events.get("tool_call")!({ toolName: "bash", input: { command: "git push origin main" } }, ctx as unknown as ExtensionContext)).resolves.toMatchObject({ block: true });
    await expect(events.get("tool_call")!({ toolName: "bash", input: { command: "git -C . push origin main" } }, ctx as unknown as ExtensionContext)).resolves.toMatchObject({ block: true });
    await expect(events.get("tool_call")!({ toolName: "bash", input: { command: "bash -lc 'git push origin main'" } }, ctx as unknown as ExtensionContext)).resolves.toMatchObject({ block: true });
    await expect(events.get("tool_call")!({ toolName: "bash", input: { command: "g\\it push origin main" } }, ctx as unknown as ExtensionContext)).resolves.toMatchObject({ block: true });

    await events.get("message_end")!({ message: { role: "assistant", usage: { input: 200, output: 40, cacheRead: 0, cacheWrite: 0, cost: { total: 0.04 } } } }, ctx as unknown as ExtensionContext);
    await events.get("agent_end")!({ messages: [{ role: "assistant", content: "Implemented" }] }, ctx as unknown as ExtensionContext);
    expect(activeTools).toEqual(["read", "edit", "bash"]);
    await events.get("agent_settled")!({}, ctx as unknown as ExtensionContext);
    expect(activeTools).toEqual(["read", "grep", "find", "ls", "bash", "judge_verdict"]);
    await expect(events.get("tool_call")!({ toolName: "bash", input: { command: "git diff --staged" } }, ctx as unknown as ExtensionContext)).resolves.toBeUndefined();
    await expect(events.get("tool_call")!({ toolName: "bash", input: { command: "git reset --hard" } }, ctx as unknown as ExtensionContext)).resolves.toMatchObject({ block: true });

    expect(setModel.mock.calls.map(([model]) => (model as { id: string }).id)).toEqual(["planner", "planner-backup", "coder", "checker"]);
    const latest = appendEntry.mock.calls.at(-1)?.[1] as { phase: string; modelSelections: Array<{ stage: string; model: string }> };
    expect(latest.phase).toBe("judging");
    expect(latest.modelSelections.map(({ stage, model }) => [stage, model])).toEqual([
      ["plan", "planner"], ["plan", "planner-backup"], ["build", "coder"], ["fast-judge", "checker"],
    ]);
    expect((latest.modelSelections[0] as { failureCategories?: string[] }).failureCategories).toContain("provider-error");
    expect(activeTools).toContain("judge_verdict");
    const evidence = readFileSync(join(cwd, "home", ".ai-orchestrator", "routing-evidence", "events.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(evidence.filter((event) => event.outcome.type === "stage-ended").map((event) => event.cost.observedUsd)).toEqual([0.02, 0.04]);

    setModel.mockImplementation(async (model: unknown) => (model as { id: string }).id !== "model");
    await commands.get("orchestrate-stop")!("", ctx);
    const pending = appendEntry.mock.calls.at(-1)?.[1] as { phase: string; originalModel?: { id: string } };
    expect(pending).toMatchObject({ phase: "idle", originalModel: { id: "model" } });
    const callsBeforeBlockedStart = setModel.mock.calls.length;
    await commands.get("orchestrate")!("--yolo another task", ctx);
    expect(setModel).toHaveBeenCalledTimes(callsBeforeBlockedStart);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("restoration is pending"), "error");

    setModel.mockResolvedValue(true);
    await commands.get("orchestrate-stop")!("", ctx);
    const restored = appendEntry.mock.calls.at(-1)?.[1] as { phase: string; originalModel?: unknown };
    expect(restored.phase).toBe("idle");
    expect(restored.originalModel).toBeUndefined();
    expect(activeTools).toEqual(["read", "edit", "bash"]);
  });
});
