import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BuildWorkerRequest } from "../src/runtime/buildWorker.js";
import {
  buildWorkerToolDefinitions,
  createPiBuildWorkerAdapter,
  createWorkspaceReadGuard,
  type PiNestedSession,
  type PiNestedSessionFactory,
  type PiNestedSessionInput,
} from "../src/runtime/piBuildWorker.js";

const now = "2026-07-22T00:00:00.000Z";
const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function request(worktreePath?: string): BuildWorkerRequest {
  return {
    schemaVersion: 1,
    requestRef: "a".repeat(64),
    effectRequestRef: "b".repeat(64),
    idempotencyKey: "c".repeat(64),
    runId: "run-1",
    planVersion: 1,
    planHash: "d".repeat(64),
    nodeId: "inspect-a",
    visit: 1,
    attempt: 1,
    handler: "inspect",
    toolPolicy: "read-only",
    activeTools: ["read", "grep", "find", "ls"],
    declaredWriteSet: [],
    declaredOutputContracts: [{ id: "inspection", kind: "evidence", validation: "structured" }],
    workspace: worktreePath === undefined ? { kind: "shared" } : {
      kind: "owned-worktree",
      intentId: "e".repeat(64),
      runId: "run-1",
      planVersion: 1,
      planHash: "d".repeat(64),
      ownerNodeId: "inspect-a",
      baseSha: "f".repeat(40),
      ownershipReceiptHash: "1".repeat(64),
      worktreePath,
    },
    timeoutMs: 5_000,
    outerBuildBudgetRef: "2".repeat(64),
    prompt: "Execute only this immutable node.",
  };
}

function fakeFactory(
  onPrompt: (input: Readonly<PiNestedSessionInput>) => void,
): { factory: PiNestedSessionFactory; inputs: PiNestedSessionInput[]; dispose: ReturnType<typeof vi.fn> } {
  const inputs: PiNestedSessionInput[] = [];
  const dispose = vi.fn();
  const factory: PiNestedSessionFactory = {
    async create(input) {
      inputs.push(input as PiNestedSessionInput);
      const session: PiNestedSession = {
        isIdle: true,
        state: { messages: [] },
        async prompt() { onPrompt(input); },
        async waitForIdle() {},
        async abort() {},
        dispose,
        subscribe: () => () => undefined,
        getSessionStats: () => ({ tokens: { input: 40, output: 20 }, cost: 0.004 }),
      };
      return { session };
    },
  };
  return { factory, inputs, dispose };
}

describe("Pi nested BUILD worker", () => {
  it("uses the exact registry/model/auth, candidate cwd, strict tools, typed result, usage, and disposal", async () => {
    const selectedModel = { provider: "local", id: "coder" };
    const registry = { authStorage: { token: "trusted" }, find: vi.fn(), getAvailable: vi.fn() };
    const nested = fakeFactory((input) => input.onResult({
      outcome: "succeeded",
      summary: "Inspected the target.",
      outputs: [{ contractId: "inspection", content: "{\"files\":[]}" }],
    }));
    const adapter = createPiBuildWorkerAdapter({
      repositoryRoot: "/repo",
      model: selectedModel,
      thinkingLevel: "high",
      modelRegistry: registry,
      now: () => now,
      protectedWorkspacePaths: [".ai-orchestrator"],
      sessionFactory: nested.factory,
    });
    const controller = new AbortController();

    const receipt = await adapter.invoke(request("/repo/.ai-orchestrator/build-worktrees/run-1"), {
      signal: controller.signal,
    });

    expect(nested.inputs).toHaveLength(1);
    expect(nested.inputs[0]).toMatchObject({
      cwd: "/repo/.ai-orchestrator/build-worktrees/run-1",
      model: selectedModel,
      thinkingLevel: "high",
      modelRegistry: registry,
      authStorage: registry.authStorage,
      tools: ["read", "grep", "find", "ls", "submit_build_worker_result"],
      toolPolicy: "read-only",
      declaredWriteSet: [],
      protectedWorkspacePaths: [".ai-orchestrator"],
    });
    expect(receipt).toMatchObject({
      outcome: "succeeded",
      worker: { provider: "local", model: "coder" },
      claimedOutputPaths: ["nodes/1/inspect-a/attempt-1/inspection.json"],
      outputPayloads: [{ contractId: "inspection", content: "{\"files\":[]}" }],
      usage: { inputTokens: 40, outputTokens: 20, observedUsd: 0.004 },
      completedAt: now,
    });
    expect(nested.dispose).toHaveBeenCalledOnce();
  });

  it("fails closed when the nested model omits the terminating result tool", async () => {
    const nested = fakeFactory(() => undefined);
    const adapter = createPiBuildWorkerAdapter({
      repositoryRoot: "/repo",
      model: { provider: "local", id: "coder" },
      thinkingLevel: "medium",
      modelRegistry: { authStorage: {}, find: vi.fn(), getAvailable: vi.fn() },
      now: () => now,
      protectedWorkspacePaths: [".ai-orchestrator"],
      sessionFactory: nested.factory,
    });

    await expect(adapter.invoke(request(), { signal: new AbortController().signal }))
      .resolves.toMatchObject({ outcome: "failed", claimedOutputPaths: [] });
    expect(nested.inputs[0]?.cwd).toBe("/repo");
    expect(nested.dispose).toHaveBeenCalledOnce();
  });

  it("treats a final model error as failure even after a success result was submitted", async () => {
    let listener: ((event: unknown) => void) | undefined;
    const dispose = vi.fn();
    const factory: PiNestedSessionFactory = {
      async create(input) {
        return {
          session: {
            isIdle: true,
            state: { messages: [] },
            async prompt() {
              input.onResult({
                outcome: "succeeded",
                summary: "Claimed success before the provider failed.",
                outputs: [{ contractId: "inspection", content: "{}" }],
              });
              listener?.({
                type: "message_end",
                message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider stream failed" },
              });
            },
            async waitForIdle() {},
            async abort() {},
            dispose,
            subscribe(callback) { listener = callback; return () => { listener = undefined; }; },
            getSessionStats: () => ({ tokens: { input: 4, output: 2 }, cost: 0.001 }),
          },
        };
      },
    };
    const adapter = createPiBuildWorkerAdapter({
      repositoryRoot: "/repo",
      model: { provider: "local", id: "coder" },
      thinkingLevel: "medium",
      modelRegistry: { authStorage: {}, find: vi.fn(), getAvailable: vi.fn() },
      now: () => now,
      protectedWorkspacePaths: [".ai-orchestrator"],
      sessionFactory: factory,
    });

    await expect(adapter.invoke(request(), { signal: new AbortController().signal })).resolves.toMatchObject({
      outcome: "failed",
      summary: "provider stream failed",
      claimedOutputPaths: [],
      outputPayloads: [],
    });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("rejects direct and symlinked reads outside the assigned workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-build-read-root-"));
    const outside = mkdtempSync(join(tmpdir(), "pi-build-read-outside-"));
    tempDirs.push(root, outside);
    writeFileSync(join(root, "safe.txt"), "safe\n");
    writeFileSync(join(outside, "secret.txt"), "secret\n");
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "config"), "secret git config\n");
    symlinkSync(join(outside, "secret.txt"), join(root, "leak.txt"));
    const guard = createWorkspaceReadGuard(root);

    expect(guard(join(root, "safe.txt"))).toBe(realpathSync(join(root, "safe.txt")));
    expect(() => guard(join(outside, "secret.txt"))).toThrow(/escaped its workspace/i);
    expect(() => guard(join(root, "leak.txt"))).toThrow(/read path contains a symlink/i);
    expect(() => guard(join(root, ".git", "config"))).toThrow(/protected orchestration or Git metadata/i);
  });

  it("guards read, grep, find, and ls operations and never walks repository symlinks", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-build-search-root-"));
    const outside = mkdtempSync(join(tmpdir(), "pi-build-search-outside-"));
    tempDirs.push(root, outside);
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, ".ai-orchestrator"));
    mkdirSync(join(root, "src", "orch-runs"), { recursive: true });
    writeFileSync(join(root, "src", "safe.ts"), "export const needle = true;\n");
    writeFileSync(join(root, ".git", "config"), "secret git config\n");
    linkSync(join(root, ".git", "config"), join(root, "src", "git-config-alias.txt"));
    writeFileSync(join(root, ".ai-orchestrator", "state.json"), "secret default state\n");
    writeFileSync(join(root, "src", "orch-runs", "state.json"), "secret custom state\n");
    writeFileSync(join(root, "src", "oversized.txt"), "bounded\n");
    truncateSync(join(root, "src", "oversized.txt"), 8 * 1024 * 1024 + 1);
    writeFileSync(join(outside, "secret.ts"), "export const token = 'secret';\n");
    symlinkSync(outside, join(root, "linked-outside"));
    const definitions = buildWorkerToolDefinitions({
      cwd: root,
      model: { provider: "test", id: "coder" },
      thinkingLevel: "medium",
      modelRegistry: { authStorage: {}, find: vi.fn(), getAvailable: vi.fn() },
      authStorage: {},
      tools: ["read", "grep", "find", "ls"],
      toolPolicy: "read-only",
      declaredWriteSet: [],
      protectedWorkspacePaths: ["src/orch-runs"],
      onResult: vi.fn(),
    }) as Array<{
      name: string;
      options?: { operations: Record<string, (...args: any[]) => any> };
      execute?: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<{
        content: Array<{ type: string; text: string }>;
      }>;
    }>;
    const operations = (name: string) => definitions.find((definition) => definition.name === name)!.options.operations;
    const execute = (name: string, params: Record<string, unknown>, signal?: AbortSignal) =>
      definitions.find((definition) => definition.name === name)!.execute!("test-call", params, signal);

    await expect(operations("read").readFile(join(root, "linked-outside", "secret.ts"))).rejects.toThrow(/symlink/i);
    await expect(execute("read", { path: join(root, "src", "git-config-alias.txt") }))
      .rejects.toThrow(/hard linked/i);
    await expect(execute("read", { path: join(root, "src", "oversized.txt") }))
      .rejects.toThrow(/exceeds its .*byte bound/i);
    await expect(execute("find", { pattern: "**/*.ts", path: root, limit: 100 }))
      .resolves.toMatchObject({ content: [{ text: "src/safe.ts" }] });
    await expect(execute("find", { pattern: `${"*a".repeat(28)}b`, path: root, limit: 100 }))
      .resolves.toMatchObject({ content: [{ text: "No files found matching pattern" }] });
    const abortedFind = new AbortController();
    abortedFind.abort();
    await expect(execute("find", { pattern: "**/*", path: root }, abortedFind.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    await expect(execute("ls", { path: outside })).rejects.toThrow(/escaped its workspace/i);
    await expect(execute("ls", { path: join(root, "linked-outside") })).rejects.toThrow(/symlink/i);
    const listed = await execute("ls", { path: join(root, "src") });
    expect(listed.content[0]?.text).not.toMatch(/orch-runs|git-config-alias/);

    const found = await execute("grep", { pattern: "needle", path: root, limit: 20 });
    expect(found.content[0]?.text).toContain("src/safe.ts:1: export const needle = true;");
    const protectedSearch = await execute("grep", { pattern: "secret", path: root, limit: 20 });
    expect(protectedSearch.content[0]?.text).toBe("No matches found");
    await expect(execute("grep", { pattern: "secret", path: join(root, "src", "orch-runs") }))
      .rejects.toThrow(/protected orchestration or Git metadata/i);
  });

  it("blocks actual edit and write tools from broad write sets, Git metadata, and custom artifact roots", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-build-mutation-root-"));
    tempDirs.push(root);
    mkdirSync(join(root, "src", "orch-runs"), { recursive: true });
    mkdirSync(join(root, "src", ".git"), { recursive: true });
    writeFileSync(join(root, "src", "safe.ts"), "before\n");
    writeFileSync(join(root, "src", "orch-runs", "state.json"), "authoritative\n");
    writeFileSync(join(root, "src", ".git", "config"), "git metadata\n");
    linkSync(join(root, "src", ".git", "config"), join(root, "src", "git-config-alias"));
    const definitions = buildWorkerToolDefinitions({
      cwd: root,
      model: { provider: "test", id: "coder" },
      thinkingLevel: "medium",
      modelRegistry: { authStorage: {}, find: vi.fn(), getAvailable: vi.fn() },
      authStorage: {},
      tools: ["read", "grep", "find", "ls", "edit", "write"],
      toolPolicy: "read-write",
      declaredWriteSet: ["src"],
      protectedWorkspacePaths: ["src/orch-runs"],
      onResult: vi.fn(),
    }) as Array<{
      name: string;
      execute?: (id: string, params: Record<string, unknown>) => Promise<unknown>;
    }>;
    const execute = (name: string, params: Record<string, unknown>) =>
      definitions.find((definition) => definition.name === name)!.execute!("test-call", params);

    await expect(execute("edit", {
      path: join(root, "src", "orch-runs", "state.json"),
      oldText: "authoritative",
      newText: "forged",
    })).rejects.toThrow(/cannot mutate protected/i);
    await expect(execute("write", {
      path: join(root, "src", "orch-runs", "receipt.json"),
      content: "forged\n",
    })).rejects.toThrow(/cannot mutate protected/i);
    await expect(execute("write", {
      path: join(root, "src", ".git", "config"),
      content: "forged\n",
    })).rejects.toThrow(/cannot mutate protected/i);
    await expect(execute("edit", {
      path: join(root, "src", "git-config-alias"),
      oldText: "git metadata",
      newText: "forged",
    })).rejects.toThrow(/hard linked/i);
    await expect(execute("write", {
      path: join(root, "src", "git-config-alias"),
      content: "forged\n",
    })).rejects.toThrow(/hard linked/i);

    await expect(execute("edit", {
      path: join(root, "src", "safe.ts"),
      oldText: "before",
      newText: "after",
    })).resolves.toBeDefined();
    expect(readFileSync(join(root, "src", "safe.ts"), "utf8")).toBe("after\n");
    expect(readFileSync(join(root, "src", "orch-runs", "state.json"), "utf8")).toBe("authoritative\n");
    expect(readFileSync(join(root, "src", ".git", "config"), "utf8")).toBe("git metadata\n");
  });

  it("normalizes contained custom artifact paths before enforcing worker boundaries", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-build-normalized-protected-root-"));
    tempDirs.push(root);
    mkdirSync(join(root, "src", "orch-runs"), { recursive: true });
    writeFileSync(join(root, "src", "orch-runs", "state.json"), "authoritative\n");
    const definitions = buildWorkerToolDefinitions({
      cwd: root,
      model: { provider: "test", id: "coder" },
      thinkingLevel: "medium",
      modelRegistry: { authStorage: {}, find: vi.fn(), getAvailable: vi.fn() },
      authStorage: {},
      tools: ["read", "grep", "find", "ls"],
      toolPolicy: "read-only",
      declaredWriteSet: [],
      protectedWorkspacePaths: ["src/ignored/../orch-runs"],
      onResult: vi.fn(),
    }) as Array<{ name: string; execute?: (id: string, params: Record<string, unknown>) => Promise<unknown> }>;

    await expect(definitions.find(({ name }) => name === "read")!.execute!("test-call", {
      path: join(root, "src", "orch-runs", "state.json"),
    })).rejects.toThrow(/protected orchestration/i);
  });

  it("bounds and cancels directory listing and batches grep across many small files", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-build-bounded-tools-root-"));
    tempDirs.push(root);
    mkdirSync(join(root, "many"));
    for (let index = 0; index < 256; index += 1) {
      writeFileSync(join(root, "many", `file-${String(index).padStart(3, "0")}.txt`), "hay\n");
    }
    const definitions = buildWorkerToolDefinitions({
      cwd: root,
      model: { provider: "test", id: "coder" },
      thinkingLevel: "medium",
      modelRegistry: { authStorage: {}, find: vi.fn(), getAvailable: vi.fn() },
      authStorage: {},
      tools: ["read", "grep", "find", "ls"],
      toolPolicy: "read-only",
      declaredWriteSet: [],
      protectedWorkspacePaths: [".ai-orchestrator/runs"],
      onResult: vi.fn(),
    }) as Array<{
      name: string;
      execute?: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<{
        content: Array<{ type: string; text: string }>;
        details?: Record<string, unknown>;
      }>;
    }>;
    const execute = (name: string, params: Record<string, unknown>, signal?: AbortSignal) =>
      definitions.find((definition) => definition.name === name)!.execute!("test-call", params, signal);

    await expect(execute("ls", { path: join(root, "many"), limit: 5 })).resolves.toMatchObject({
      details: { entryLimitReached: 5 },
    });
    const abortedLs = new AbortController();
    abortedLs.abort();
    await expect(execute("ls", { path: root }, abortedLs.signal)).rejects.toMatchObject({ name: "AbortError" });
    const matched = await execute("grep", { pattern: "hay", path: join(root, "many"), limit: 2 });
    expect(matched.content[0]?.text.match(/file-\d{3}\.txt:1: hay/g)).toHaveLength(2);
    await expect(execute("grep", { pattern: "needle", path: join(root, "many"), limit: 20 }))
      .resolves.toMatchObject({ content: [{ text: "No matches found" }] });
  });
});
