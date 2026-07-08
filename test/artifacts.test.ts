import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendJournal,
  createRun,
  currentRun,
  readState,
  releaseRun,
  writeState,
} from "../src/lifecycle/artifacts.js";
import { createIdleLifecycleState } from "../src/core/lifecycle.js";

const tempDirs: string[] = [];
const artifactsDir = ".ai-orchestrator/runs";

function makeTempDir(): string {
  const dir = join(tmpdir(), `ai-orchestrator-artifacts-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("lifecycle artifacts", () => {
  it("creates a run directory, current pointer, and journal", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, artifactsDir, "ship a feature");

    expect(run.runId).toMatch(/^\d{8}-\d{4}-[a-f0-9]{6}$/);
    expect(existsSync(run.paths.root)).toBe(true);
    expect(existsSync(run.paths.spec)).toBe(true);
    expect(existsSync(run.paths.plan)).toBe(true);
    expect(readFileSync(join(cwd, ".ai-orchestrator", "current"), "utf8").trim()).toBe(run.runId);
    expect(readFileSync(run.paths.journal, "utf8")).toContain("Task: ship a feature");
    expect(readState(run.paths)).toMatchObject({ runId: run.runId, phase: "defining", task: "ship a feature" });

    expect(currentRun(cwd, artifactsDir)?.runId).toBe(run.runId);
  });

  it("writes and reads state atomically", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, artifactsDir, "task");
    const state = createIdleLifecycleState({ runId: run.runId, phase: "defining", task: "task" });

    writeState(run.paths, state);

    expect(readState(run.paths)).toEqual(state);
    expect(readFileSync(run.paths.state, "utf8")).toContain('"phase": "defining"');
  });

  it("persists yolo on the initial lifecycle run state", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, artifactsDir, "task", true);

    expect(readState(run.paths)).toMatchObject({ yolo: true, phase: "defining" });
  });

  it("returns undefined for missing or corrupt state", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, artifactsDir, "task");

    unlinkSync(run.paths.state);
    expect(readState(run.paths)).toBeUndefined();
    writeFileSync(run.paths.state, "not json");
    expect(readState(run.paths)).toBeUndefined();
    writeFileSync(run.paths.state, JSON.stringify({ phase: "defining" }));
    expect(readState(run.paths)).toBeUndefined();
    writeFileSync(run.paths.state, JSON.stringify(createIdleLifecycleState({ runId: run.runId, phase: "defining", task: "task", verdicts: [{ stage: "bad", verdict: "approve", reasons: "x" } as never] })));
    expect(readState(run.paths)).toBeUndefined();
  });

  it("blocks creating a new run immediately while the current state is active", () => {
    const cwd = makeTempDir();
    createRun(cwd, artifactsDir, "first");

    expect(() => createRun(cwd, artifactsDir, "second")).toThrow(/already active/);
  });

  it("blocks creating a run while another process holds the current-run lock", () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, ".ai-orchestrator", "current.lock"), { recursive: true });

    expect(() => createRun(cwd, artifactsDir, "second")).toThrow(/active or starting/);
    expect(existsSync(join(cwd, ".ai-orchestrator", "runs"))).toBe(false);
  });

  it("allows a new run when current state is terminal or corrupt", () => {
    const cwd = makeTempDir();
    const first = createRun(cwd, artifactsDir, "first");
    writeState(first.paths, createIdleLifecycleState({ runId: first.runId, phase: "done", task: "first" }));

    const second = createRun(cwd, artifactsDir, "second");
    expect(second.runId).not.toBe(first.runId);

    writeFileSync(second.paths.state, "not json");
    const third = createRun(cwd, artifactsDir, "third");
    expect(third.runId).not.toBe(second.runId);

    writeFileSync(third.paths.state, JSON.stringify({ ...createIdleLifecycleState({ runId: third.runId, task: "third" }), phase: "unknown" }));
    const fourth = createRun(cwd, artifactsDir, "fourth");
    expect(fourth.runId).not.toBe(third.runId);
  });

  it("ignores invalid current run ids instead of joining untrusted path text", () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, ".ai-orchestrator"), { recursive: true });
    writeFileSync(join(cwd, ".ai-orchestrator", "current"), "../../outside\n");

    expect(currentRun(cwd, artifactsDir)).toBeUndefined();
  });

  it("keeps the current pointer under the dedicated parent for non-default artifact directories", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, ".orch/runs", "task");

    expect(readFileSync(join(cwd, ".orch", "current"), "utf8").trim()).toBe(run.runId);
    expect(existsSync(join(cwd, "current"))).toBe(false);
  });

  it("normalizes backslash separators before deriving run and current paths", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, ".orch\\runs", "task");

    expect(run.paths.root).toBe(join(cwd, ".orch", "runs", run.runId));
    expect(readFileSync(join(cwd, ".orch", "current"), "utf8").trim()).toBe(run.runId);
    expect(existsSync(join(cwd, "current"))).toBe(false);
    expect(existsSync(join(cwd, ".orch\\runs"))).toBe(false);
  });

  it("rejects artifact directories that collide with current coordination names", () => {
    const cwd = makeTempDir();

    expect(() => createRun(cwd, ".ai-orchestrator/current", "task")).toThrow(/reserved/);
    expect(() => createRun(cwd, ".ai-orchestrator/current.lock", "task")).toThrow(/reserved/);
    expect(existsSync(join(cwd, ".ai-orchestrator", "current"))).toBe(false);
    expect(existsSync(join(cwd, ".ai-orchestrator", "current.lock"))).toBe(false);
  });

  it("adds narrow lifecycle artifact patterns to local git excludes", () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, ".git", "info"), { recursive: true });
    writeFileSync(join(cwd, ".git", "info", "exclude"), "# existing\n");

    const first = createRun(cwd, "src/orch-runs", "task");
    writeState(first.paths, createIdleLifecycleState({ runId: first.runId, phase: "done", task: "task" }));
    createRun(cwd, "src/orch-runs", "task 2");

    const exclude = readFileSync(join(cwd, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("/src/orch-runs/");
    expect(exclude).toContain("/src/current");
    expect(exclude).toContain("/src/current.lock/");
    expect(exclude).not.toMatch(/^\/src\/$/m);
    expect(exclude.match(/^\/src\/orch-runs\/$/gm)).toHaveLength(1);
  });

  it("escapes gitignore metacharacters in lifecycle artifact patterns", () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, ".git", "info"), { recursive: true });

    createRun(cwd, "src/*[tmp]?/runs", "task");

    const exclude = readFileSync(join(cwd, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("/src/\\*\\[tmp\\]\\?/runs/");
    expect(exclude).toContain("/src/\\*\\[tmp\\]\\?/current");
    expect(exclude).not.toContain("/src/*[tmp]?/runs/");
  });

  it("resolves gitdir files before adding local git excludes", () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, ".real-git"), { recursive: true });
    writeFileSync(join(cwd, ".git"), "gitdir: .real-git\n");

    createRun(cwd, ".orch/runs", "task");

    const exclude = readFileSync(join(cwd, ".real-git", "info", "exclude"), "utf8");
    expect(exclude).toContain("/.orch/runs/");
    expect(exclude).toContain("/.orch/current");
    expect(exclude).toContain("/.orch/current.lock/");
  });

  it("appends journal entries and releases the current run pointer", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, artifactsDir, "task");

    appendJournal(run.paths, "moved to planning");
    expect(readFileSync(run.paths.journal, "utf8")).toContain("moved to planning");

    expect(releaseRun(cwd, artifactsDir, run.runId)).toBe(true);
    expect(currentRun(cwd, artifactsDir)).toBeUndefined();

    const next = createRun(cwd, artifactsDir, "next");
    expect(next.runId).not.toBe(run.runId);
  });

  it("does not release a newer run's pointer from an older run", () => {
    const cwd = makeTempDir();
    const oldRun = createRun(cwd, artifactsDir, "old");
    writeState(oldRun.paths, createIdleLifecycleState({ runId: oldRun.runId, phase: "done", task: "old" }));
    const newRun = createRun(cwd, artifactsDir, "new");

    expect(releaseRun(cwd, artifactsDir, oldRun.runId)).toBe(false);
    expect(currentRun(cwd, artifactsDir)?.runId).toBe(newRun.runId);
    expect(releaseRun(cwd, artifactsDir, newRun.runId)).toBe(true);
    expect(currentRun(cwd, artifactsDir)).toBeUndefined();
  });
});
