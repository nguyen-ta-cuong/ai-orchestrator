import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireRunLease,
  appendJournal,
  appendRoutingTrace,
  createRun,
  currentRun,
  ownsRunLease,
  readState,
  releaseRun,
  releaseRunLease,
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
    expect(existsSync(run.paths.debug)).toBe(true);
    expect(readFileSync(run.paths.routing, "utf8")).toBe("");
    expect(readFileSync(join(cwd, ".ai-orchestrator", "runs", "current"), "utf8").trim()).toBe(run.runId);
    expect(readFileSync(run.paths.journal, "utf8")).toContain("Task: ship a feature");
    expect(readState(run.paths)).toMatchObject({ runId: run.runId, phase: "defining", task: "ship a feature" });

    expect(currentRun(cwd, artifactsDir)?.runId).toBe(run.runId);
  });

  it("appends bounded routing decision records", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, artifactsDir, "task");
    appendRoutingTrace(run.paths, {
      decisionId: "decision-1",
      runId: run.runId,
      stage: "build",
      recordedAt: new Date(0).toISOString(),
      plan: { engine: "capability", candidates: [] },
      attempts: [{ provider: "p", model: "m", outcome: "selected" }],
    });
    expect(JSON.parse(readFileSync(run.paths.routing, "utf8"))).toMatchObject({ decisionId: "decision-1", stage: "build" });
    expect(() => appendRoutingTrace(run.paths, {
      decisionId: "oversized", runId: run.runId, stage: "build", recordedAt: "now",
      plan: { text: "x".repeat(300_000) }, attempts: [],
    })).toThrow(/exceeds 256 KiB/);
  });

  it("writes and reads state atomically", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, artifactsDir, "task");
    const state = createIdleLifecycleState({ runId: run.runId, phase: "defining", task: "task" });

    writeState(run.paths, state);

    expect(readState(run.paths)).toEqual(state);
    expect(readFileSync(run.paths.state, "utf8")).toContain('"phase": "defining"');
  });

  it("persists the DEBUG diagnosis checkpoint for crash-safe resume", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, artifactsDir, "task");
    const state = createIdleLifecycleState({
      runId: run.runId,
      phase: "debugging",
      task: "task",
      verdicts: [{ stage: "verify", verdict: "reject", reasons: "failed" }],
      debugDiagnosisVerdictIndex: 0,
    });

    writeState(run.paths, state);
    expect(readState(run.paths)).toMatchObject({ phase: "debugging", debugDiagnosisVerdictIndex: 0 });
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
    for (const counters of [{ buildIterations: -1 }, { consecutiveRejections: 1.5 }]) {
      writeFileSync(run.paths.state, JSON.stringify({
        ...createIdleLifecycleState({ runId: run.runId, phase: "defining", task: "task" }),
        ...counters,
      }));
      expect(readState(run.paths)).toBeUndefined();
    }
    writeFileSync(run.paths.state, JSON.stringify(createIdleLifecycleState({ runId: run.runId, phase: "defining", task: "task", verdicts: [{ stage: "bad", verdict: "approve", reasons: "x" } as never] })));
    expect(readState(run.paths)).toBeUndefined();
    writeFileSync(run.paths.state, JSON.stringify(createIdleLifecycleState({
      runId: run.runId,
      phase: "debugging",
      task: "task",
      modelSelections: [{ stage: "debug", provider: "", model: "bad", thinking: "xhigh", reason: "", selectedAt: "now" }],
    })));
    expect(readState(run.paths)).toBeUndefined();
    writeFileSync(run.paths.state, JSON.stringify({
      ...createIdleLifecycleState({ runId: run.runId, phase: "defining", task: "task" }),
      originalModel: { provider: "anthropic", id: "model", thinking: "impossible" },
    }));
    expect(readState(run.paths)).toBeUndefined();
    writeFileSync(run.paths.state, JSON.stringify({
      ...createIdleLifecycleState({ runId: run.runId, phase: "debugging", task: "task" }),
      debugDiagnosisVerdictIndex: -1,
    }));
    expect(readState(run.paths)).toBeUndefined();
  });

  it("migrates older version-one state without model selections", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, artifactsDir, "task");
    const oldState = createIdleLifecycleState({ runId: run.runId, phase: "defining", task: "task" }) as unknown as Record<string, unknown>;
    delete oldState.modelSelections;
    writeFileSync(run.paths.state, JSON.stringify(oldState));

    expect(readState(run.paths)?.modelSelections).toEqual([]);
  });

  it("blocks creating a new run immediately while the current state is active", () => {
    const cwd = makeTempDir();
    createRun(cwd, artifactsDir, "first");

    expect(() => createRun(cwd, artifactsDir, "second")).toThrow(/already active/);
  });

  it("prevents concurrent execution and reclaims a dead-process lease", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, artifactsDir, "task");
    acquireRunLease(run.paths, "owner-a");
    expect(ownsRunLease(run.paths, "owner-a")).toBe(true);
    expect(() => acquireRunLease(run.paths, "owner-b")).toThrow(/already executing/);
    expect(releaseRunLease(run.paths, "owner-b")).toBe(false);
    expect(releaseRunLease(run.paths, "owner-a")).toBe(true);

    writeFileSync(run.paths.executionLease, `${JSON.stringify({ owner: "dead", pid: 99_999_999, createdAt: new Date().toISOString() })}\n`);
    acquireRunLease(run.paths, "owner-b");
    expect(ownsRunLease(run.paths, "owner-b")).toBe(true);
    expect(releaseRunLease(run.paths, "owner-b")).toBe(true);
  });

  it("blocks creating a run while another process holds the current-run lock", () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, ".ai-orchestrator", "runs", "current.lock"), { recursive: true });

    expect(() => createRun(cwd, artifactsDir, "second")).toThrow(/active or starting/);
    expect(existsSync(join(cwd, ".ai-orchestrator", "runs", "current"))).toBe(false);
  });

  it("allows terminal replacement but fails closed on corrupt current state", () => {
    const cwd = makeTempDir();
    const first = createRun(cwd, artifactsDir, "first");
    writeState(first.paths, createIdleLifecycleState({ runId: first.runId, phase: "done", task: "first" }));

    const second = createRun(cwd, artifactsDir, "second");
    expect(second.runId).not.toBe(first.runId);

    writeFileSync(second.paths.state, "not json");
    expect(() => createRun(cwd, artifactsDir, "third")).toThrow(/corrupt state/);

    writeFileSync(second.paths.state, JSON.stringify({ ...createIdleLifecycleState({ runId: second.runId, task: "second" }), phase: "unknown" }));
    expect(() => createRun(cwd, artifactsDir, "third")).toThrow(/corrupt state/);
  });

  it("ignores invalid current run ids instead of joining untrusted path text", () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, ".ai-orchestrator", "runs"), { recursive: true });
    writeFileSync(join(cwd, ".ai-orchestrator", "runs", "current"), "../../outside\n");

    expect(currentRun(cwd, artifactsDir)).toBeUndefined();
    expect(() => createRun(cwd, artifactsDir, "task")).toThrow(/current pointer is invalid/);
  });

  it("keeps the current pointer inside the artifact directory for non-default artifact directories", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, ".orch/runs", "task");

    expect(readFileSync(join(cwd, ".orch", "runs", "current"), "utf8").trim()).toBe(run.runId);
    expect(existsSync(join(cwd, ".orch", "current"))).toBe(false);
    expect(existsSync(join(cwd, "current"))).toBe(false);
  });

  it("does not delete sibling current files under artifact parents", () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "current"), "user-owned file\n");

    const run = createRun(cwd, "src/orch-runs", "task");

    expect(readFileSync(join(cwd, "src", "current"), "utf8")).toBe("user-owned file\n");
    expect(readFileSync(join(cwd, "src", "orch-runs", "current"), "utf8").trim()).toBe(run.runId);
  });

  it("normalizes backslash separators before deriving run and current paths", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, ".orch\\runs", "task");

    expect(run.paths.root).toBe(join(realpathSync(cwd), ".orch", "runs", run.runId));
    expect(readFileSync(join(cwd, ".orch", "runs", "current"), "utf8").trim()).toBe(run.runId);
    expect(existsSync(join(cwd, ".orch", "current"))).toBe(false);
    expect(existsSync(join(cwd, "current"))).toBe(false);
    expect(existsSync(join(cwd, ".orch\\runs"))).toBe(false);
  });

  it("rejects symlinked artifact ancestors and artifact files", () => {
    const cwd = makeTempDir();
    const outside = makeTempDir();
    symlinkSync(outside, join(cwd, ".ai-orchestrator"), "dir");
    expect(() => createRun(cwd, artifactsDir, "task")).toThrow(/must not contain symlinks/);
    expect(existsSync(join(outside, "runs"))).toBe(false);

    unlinkSync(join(cwd, ".ai-orchestrator"));
    const run = createRun(cwd, artifactsDir, "task");
    const outsideJournal = join(outside, "journal.md");
    writeFileSync(outsideJournal, "outside\n");
    unlinkSync(run.paths.journal);
    symlinkSync(outsideJournal, run.paths.journal);
    expect(() => appendJournal(run.paths, "must not escape")).toThrow(/must not contain symlinks/);
    expect(readFileSync(outsideJournal, "utf8")).toBe("outside\n");
  });

  it("rejects artifact directories that collide with current coordination names", () => {
    const cwd = makeTempDir();

    expect(() => createRun(cwd, ".ai-orchestrator/current", "task")).toThrow(/reserved/);
    expect(() => createRun(cwd, ".ai-orchestrator/current.lock", "task")).toThrow(/reserved/);
    expect(existsSync(join(cwd, ".ai-orchestrator", "current"))).toBe(false);
    expect(existsSync(join(cwd, ".ai-orchestrator", "current.lock"))).toBe(false);
  });

  it("rejects artifact directories with control characters before writing git excludes", () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, ".git", "info"), { recursive: true });

    expect(() => createRun(cwd, ".orch/runs\n*.ts\n#", "task")).toThrow(/control characters/);
    expect(existsSync(join(cwd, ".git", "info", "exclude"))).toBe(false);
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
    expect(exclude).not.toContain("/src/current");
    expect(exclude).not.toContain("/src/current.lock/");
    expect(exclude).not.toMatch(/^\/src\/$/m);
    expect(exclude.match(/^\/src\/orch-runs\/$/gm)).toHaveLength(1);
  });

  it("adds repo-root-relative git excludes when cwd is a repository subdirectory", () => {
    const repo = makeTempDir();
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const packageDir = join(repo, "packages", "pkg");
    mkdirSync(packageDir, { recursive: true });

    createRun(packageDir, ".ai-orchestrator/runs", "task");

    const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("/packages/pkg/.ai-orchestrator/runs/");
    expect(exclude).not.toMatch(/^\/\.ai-orchestrator\/runs\/$/m);
  });

  it("escapes gitignore metacharacters in lifecycle artifact patterns", () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, ".git", "info"), { recursive: true });

    createRun(cwd, "src/*[tmp]?/runs", "task");

    const exclude = readFileSync(join(cwd, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("/src/\\*\\[tmp\\]\\?/runs/");
    expect(exclude).not.toContain("/src/\\*\\[tmp\\]\\?/current");
    expect(exclude).not.toContain("/src/*[tmp]?/runs/");
  });

  it("resolves gitdir files before adding local git excludes", () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, ".real-git"), { recursive: true });
    writeFileSync(join(cwd, ".git"), "gitdir: .real-git\n");

    createRun(cwd, ".orch/runs", "task");

    const exclude = readFileSync(join(cwd, ".real-git", "info", "exclude"), "utf8");
    expect(exclude).toContain("/.orch/runs/");
    expect(exclude).not.toContain("/.orch/current");
    expect(exclude).not.toContain("/.orch/current.lock/");
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
