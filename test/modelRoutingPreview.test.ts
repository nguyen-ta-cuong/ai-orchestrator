import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import modelRoutingPreviewExtension from "../extensions/modelRoutingPreview.js";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("/lifecycle-models", () => {
  it("reports legacy and capability choices without switching, invoking, or mutating run state", async () => {
    const cwd = join(tmpdir(), `ai-orchestrator-preview-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(cwd, { recursive: true });
    tempDirs.push(cwd);
    vi.stubEnv("HOME", join(cwd, "home"));
    writeFileSync(join(cwd, ".ai-orchestrator.json"), JSON.stringify({
      routing: {
        stages: { review: { prefer: ["custom/new-reviewer"] } },
        profiles: {
          "custom/new-reviewer": {
            family: "independent-reviewer",
            confidence: 9_000,
            provenance: "project",
            version: "test-v1",
            scores: { review: 9_000, architecture: 8_000, verification: 8_000, structuredOutput: 9_000, longContext: 8_000 },
          },
        },
      },
    }));
    const before = readdirSync(cwd).sort();
    const commands = new Map<string, CommandHandler>();
    const pi = {
      registerCommand: vi.fn((name: string, command: { handler: CommandHandler }) => commands.set(name, command.handler)),
      setModel: vi.fn(),
      setThinkingLevel: vi.fn(),
      setActiveTools: vi.fn(),
      sendMessage: vi.fn(),
      sendUserMessage: vi.fn(),
      appendEntry: vi.fn(),
    };
    modelRoutingPreviewExtension(pi as unknown as ExtensionAPI);
    const notify = vi.fn();
    const getAvailable = vi.fn(() => [
      {
        provider: "custom",
        id: "new-reviewer",
        name: "New Reviewer",
        reasoning: true,
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 16_000,
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      },
      { provider: "anthropic", id: "claude-fable-5", reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 16_000 },
    ]);
    const ctx = {
      cwd,
      waitForIdle: vi.fn(async () => undefined),
      modelRegistry: { getAvailable },
      ui: { notify },
    } as unknown as ExtensionCommandContext;

    await commands.get("lifecycle-models")!("review", ctx);

    expect(ctx.waitForIdle).toHaveBeenCalledOnce();
    expect(getAvailable).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Legacy selection: anthropic/claude-fable-5"), "info");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("1. custom/new-reviewer"), "info");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Shadow only; no model invoked or selected."), "info");
    expect(pi.setModel).not.toHaveBeenCalled();
    expect(pi.setThinkingLevel).not.toHaveBeenCalled();
    expect(pi.setActiveTools).not.toHaveBeenCalled();
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(pi.appendEntry).not.toHaveBeenCalled();
    expect(readdirSync(cwd).sort()).toEqual(before);
  });

  it("rejects an unknown stage without reading the model registry", async () => {
    const commands = new Map<string, CommandHandler>();
    const pi = { registerCommand: (name: string, command: { handler: CommandHandler }) => commands.set(name, command.handler) };
    modelRoutingPreviewExtension(pi as unknown as ExtensionAPI);
    const getAvailable = vi.fn();
    const notify = vi.fn();
    const ctx = {
      cwd: tmpdir(),
      waitForIdle: vi.fn(async () => undefined),
      modelRegistry: { getAvailable },
      ui: { notify },
    } as unknown as ExtensionCommandContext;

    await commands.get("lifecycle-models")!("unknown-stage", ctx);

    expect(getAvailable).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Usage: /lifecycle-models"), "error");
  });
});
