import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertOwnedWorktree,
  inspectOwnedWorktreeChanges,
  materializeWorktree,
  prepareWorktreeIntent,
  reconcileWorktreeIntent,
  type GitCommandResult,
  type GitRunner,
  type WorktreeExecutionIntent,
  type WorktreeOwnershipRecord,
} from "../src/lifecycle/worktreeExecution.js";

const tempDirs: string[] = [];
const baseSha = "a".repeat(40);

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

interface ListedWorktree {
  path: string;
  head: string;
  branch: string;
}

class FakeGit implements GitRunner {
  readonly calls: { cwd: string; args: string[] }[] = [];
  status = "";
  branchExists = false;
  addCode = 0;
  addCreatesListing = true;
  worktrees: ListedWorktree[] = [];
  unstaged: string[] = [];
  staged: string[] = [];
  untracked: string[] = [];
  ignored: string[] = [];

  constructor(
    readonly repositoryRoot: string,
    readonly commonDir: string,
  ) {}

  run(args: readonly string[], options: { cwd: string }): GitCommandResult {
    const copy = [...args];
    this.calls.push({ cwd: options.cwd, args: copy });
    const key = copy.join("\u0000");
    if (key === "rev-parse\u0000--show-toplevel") return ok(`${this.repositoryRoot}\n`);
    if (key === "rev-parse\u0000--path-format=absolute\u0000--git-common-dir") return ok(`${this.commonDir}\n`);
    if (key === "rev-parse\u0000HEAD") return ok(`${baseSha}\n`);
    if (key === "-c\u0000core.fsmonitor=false\u0000status\u0000--porcelain=v1\u0000--untracked-files=all") return ok(this.status);
    if (key === "worktree\u0000list\u0000--porcelain") return ok(renderWorktrees(this.worktrees));
    if (copy[0] === "show-ref" && copy[1] === "--verify" && copy[2] === "--quiet") {
      return this.branchExists || this.worktrees.some(({ branch }) => `refs/heads/${branch}` === copy[3])
        ? ok("")
        : { code: 1, stdout: "", stderr: "" };
    }
    if (copy[0] === "worktree" && copy[1] === "add") {
      if (this.addCode !== 0) return { code: this.addCode, stdout: "", stderr: "simulated worktree add failure" };
      const branch = copy[3]!;
      const path = copy[4]!;
      const head = copy[5]!;
      this.branchExists = true;
      if (this.addCreatesListing) {
        mkdirSync(path, { recursive: true });
        this.worktrees.push({ path, head, branch });
      }
      return ok("prepared\n");
    }
    if (key === "-c\u0000core.fsmonitor=false\u0000diff\u0000--no-ext-diff\u0000--no-textconv\u0000--name-only\u0000-z") {
      return ok(nul(this.unstaged));
    }
    if (key === "-c\u0000core.fsmonitor=false\u0000diff\u0000--cached\u0000--no-ext-diff\u0000--no-textconv\u0000--name-only\u0000-z") {
      return ok(nul(this.staged));
    }
    if (key === "-c\u0000core.fsmonitor=false\u0000ls-files\u0000--others\u0000--exclude-standard\u0000-z") {
      return ok(nul(this.untracked));
    }
    if (key === "-c\u0000core.fsmonitor=false\u0000ls-files\u0000--others\u0000--ignored\u0000--exclude-standard\u0000-z") {
      return ok(nul(this.ignored));
    }
    return { code: 2, stdout: "", stderr: `unexpected fake git argv: ${copy.join(" ")}` };
  }
}

function fixture(): {
  repositoryRoot: string;
  candidateRoot: string;
  commonDir: string;
  git: FakeGit;
} {
  const repositoryRoot = mkdtempSync(join(tmpdir(), "build-worktree-repo-"));
  tempDirs.push(repositoryRoot);
  const candidateRoot = join(repositoryRoot, ".ai-orchestrator", "build-worktrees");
  const commonDir = join(repositoryRoot, ".git-common");
  mkdirSync(candidateRoot, { recursive: true });
  mkdirSync(commonDir);
  return {
    repositoryRoot: realpathSync(repositoryRoot),
    candidateRoot: realpathSync(candidateRoot),
    commonDir: realpathSync(commonDir),
    git: new FakeGit(realpathSync(repositoryRoot), realpathSync(commonDir)),
  };
}

function prepare(selected = fixture()): { intent: WorktreeExecutionIntent } & ReturnType<typeof fixture> {
  const intent = prepareWorktreeIntent({
    repositoryRoot: selected.repositoryRoot,
    candidateRoot: selected.candidateRoot,
    runId: "run-001",
    nodeId: "implement-a",
    planVersion: 1,
  }, selected.git);
  return { ...selected, intent };
}

function materialized(): { record: WorktreeOwnershipRecord; intent: WorktreeExecutionIntent; git: FakeGit } & ReturnType<typeof fixture> {
  const selected = prepare();
  const record = materializeWorktree(selected.intent, selected.git, {
    allowCreate: true,
    trustRepositoryCheckout: true,
  });
  return { ...selected, record };
}

function ok(stdout: string): GitCommandResult {
  return { code: 0, stdout, stderr: "" };
}

function renderWorktrees(worktrees: readonly ListedWorktree[]): string {
  return worktrees.map(({ path, head, branch }) => [
    `worktree ${path}`,
    `HEAD ${head}`,
    `branch refs/heads/${branch}`,
    "",
  ].join("\n")).join("\n");
}

function nul(paths: readonly string[]): string {
  return paths.length === 0 ? "" : `${paths.join("\u0000")}\u0000`;
}

function mutatingCalls(git: FakeGit): string[][] {
  return git.calls.map(({ args }) => args).filter((args) => args[0] === "worktree" && args[1] === "add");
}

function expectNoForbiddenGit(git: FakeGit): void {
  const forbidden = new Set(["commit", "merge", "cherry-pick", "push"]);
  expect(git.calls.filter(({ args }) => forbidden.has(args[0]!) || (args[0] === "worktree" && args[1] === "remove"))).toEqual([]);
}

describe("owned BUILD worktree execution", () => {
  it("prepares a canonical immutable intent from common-dir, base SHA, run, and node identity", () => {
    const { repositoryRoot, candidateRoot, commonDir, intent, git } = prepare();

    expect(intent).toMatchObject({
      schemaVersion: 1,
      repositoryRoot,
      commonDir,
      candidateRoot,
      baseSha,
      branch: "codex/build/run-001/v1/implement-a",
      worktreePath: join(candidateRoot, "run-001-v1-implement-a"),
      runId: "run-001",
      nodeId: "implement-a",
      planVersion: 1,
    });
    expect(intent.intentId).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(intent)).toBe(true);
    expect(mutatingCalls(git)).toEqual([]);
    expect(git.calls.map(({ args }) => args)).toContainEqual(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    expectNoForbiddenGit(git);
  });

  it.each([
    ["unstaged", " M src/a.ts\n"],
    ["staged", "M  src/a.ts\n"],
    ["untracked", "?? src/new.ts\n"],
  ])("refuses a %s base tree before any mutation", (_label, status) => {
    const selected = fixture();
    selected.git.status = status;
    expect(() => prepareWorktreeIntent({
      repositoryRoot: selected.repositoryRoot,
      candidateRoot: selected.candidateRoot,
      runId: "run-001",
      nodeId: "implement-a",
      planVersion: 1,
    }, selected.git)).toThrow(/working tree.*clean|dirty|staged/);
    expect(mutatingCalls(selected.git)).toEqual([]);
    expectNoForbiddenGit(selected.git);
  });

  it("requires explicit opt-in and materializes with one fixed worktree-add argv", () => {
    const selected = prepare();
    expect(() => materializeWorktree(selected.intent, selected.git, {
      allowCreate: false,
      trustRepositoryCheckout: true,
    })).toThrow(/explicit.*opt-in/);
    expect(() => materializeWorktree(selected.intent, selected.git, {
      allowCreate: true,
      trustRepositoryCheckout: false,
    })).toThrow(/trust.*checkout|checkout.*hook|filter/);
    expect(mutatingCalls(selected.git)).toEqual([]);

    const record = materializeWorktree(selected.intent, selected.git, {
      allowCreate: true,
      trustRepositoryCheckout: true,
    });
    expect(record).toMatchObject({
      schemaVersion: 1,
      intentId: selected.intent.intentId,
      branch: selected.intent.branch,
      worktreePath: selected.intent.worktreePath,
      baseSha,
      reconciled: false,
      cleanupStatus: "active",
    });
    expect(mutatingCalls(selected.git)).toEqual([[
      "worktree", "add", "-b", selected.intent.branch, selected.intent.worktreePath, selected.intent.baseSha,
    ]]);
    expectNoForbiddenGit(selected.git);
  });

  it("refuses branch, registered-worktree, and filesystem path collisions", () => {
    const branchCollision = fixture();
    branchCollision.git.branchExists = true;
    expect(() => prepare(branchCollision)).toThrow(/branch.*already exists/);
    expect(mutatingCalls(branchCollision.git)).toEqual([]);

    const pathCollision = fixture();
    mkdirSync(join(pathCollision.candidateRoot, "run-001-v1-implement-a"));
    expect(() => prepare(pathCollision)).toThrow(/path.*already exists/);
    expect(mutatingCalls(pathCollision.git)).toEqual([]);

    const registered = fixture();
    registered.git.worktrees.push({
      path: join(registered.candidateRoot, "different"),
      head: baseSha,
      branch: "codex/build/run-001/v1/implement-a",
    });
    expect(() => prepare(registered)).toThrow(/branch.*registered|worktree.*collision/);
    expect(mutatingCalls(registered.git)).toEqual([]);
  });

  it("rejects roots outside the repository and symlinked containment components", () => {
    const outside = fixture();
    const outsideRoot = mkdtempSync(join(tmpdir(), "build-worktree-outside-"));
    tempDirs.push(outsideRoot);
    expect(() => prepareWorktreeIntent({
      repositoryRoot: outside.repositoryRoot,
      candidateRoot: outsideRoot,
      runId: "run-001",
      nodeId: "implement-a",
      planVersion: 1,
    }, outside.git)).toThrow(/inside.*repository|contain/);

    const linked = fixture();
    const linkedTarget = mkdtempSync(join(tmpdir(), "build-worktree-linked-"));
    tempDirs.push(linkedTarget);
    const link = join(linked.repositoryRoot, ".ai-orchestrator", "linked-worktrees");
    symlinkSync(linkedTarget, link, "dir");
    expect(() => prepareWorktreeIntent({
      repositoryRoot: linked.repositoryRoot,
      candidateRoot: link,
      runId: "run-001",
      nodeId: "implement-a",
      planVersion: 1,
    }, linked.git)).toThrow(/symlink|inside.*repository|contain/);

    const commonLink = fixture();
    const linkedCommon = join(commonLink.repositoryRoot, "common-link");
    symlinkSync(commonLink.commonDir, linkedCommon, "dir");
    commonLink.git = new FakeGit(commonLink.repositoryRoot, linkedCommon);
    expect(() => prepare(commonLink)).toThrow(/common.*symlink|symlink/);
  });

  it("reconciles an exact worktree created before ownership persistence without adding it again", () => {
    const selected = prepare();
    selected.git.worktrees.push({
      path: selected.intent.worktreePath,
      head: selected.intent.baseSha,
      branch: selected.intent.branch,
    });
    mkdirSync(selected.intent.worktreePath, { recursive: true });
    selected.git.branchExists = true;

    const recovered = reconcileWorktreeIntent(selected.intent, selected.git);
    expect(recovered).toMatchObject({
      intentId: selected.intent.intentId,
      branch: selected.intent.branch,
      worktreePath: selected.intent.worktreePath,
      baseSha,
      reconciled: true,
      cleanupStatus: "active",
    });
    expect(materializeWorktree(selected.intent, selected.git, {
      allowCreate: true,
      trustRepositoryCheckout: true,
    })).toEqual(recovered);
    expect(mutatingCalls(selected.git)).toEqual([]);
    expectNoForbiddenGit(selected.git);
  });

  it.each([
    ["wrong branch", (entry: ListedWorktree) => { entry.branch = "codex/build/other/node"; }],
    ["wrong base", (entry: ListedWorktree) => { entry.head = "b".repeat(40); }],
    ["branch at another path", (entry: ListedWorktree, selected: WorktreeExecutionIntent) => { entry.path = `${selected.worktreePath}-other`; }],
  ])("fails closed on stale ownership: %s", (_label, mutate) => {
    const selected = prepare();
    const entry: ListedWorktree = {
      path: selected.intent.worktreePath,
      head: selected.intent.baseSha,
      branch: selected.intent.branch,
    };
    mutate(entry, selected.intent);
    selected.git.worktrees.push(entry);
    selected.git.branchExists = true;
    expect(() => reconcileWorktreeIntent(selected.intent, selected.git)).toThrow(/stale|ownership|collision|different/);
    expect(mutatingCalls(selected.git)).toEqual([]);
  });

  it("verifies persisted ownership before inspecting only declared unstaged and untracked writes", () => {
    const selected = materialized();
    selected.git.unstaged = ["src/a.ts"];
    selected.git.untracked = ["src/generated/a.ts"];

    expect(() => assertOwnedWorktree(selected.record, selected.git)).not.toThrow();
    expect(inspectOwnedWorktreeChanges(selected.record, ["src/a.ts", "src/generated"], selected.git)).toEqual({
      changedPaths: ["src/a.ts", "src/generated/a.ts"],
      stagedPaths: [],
    });

    selected.git.untracked = ["src/hidden.ts"];
    expect(() => inspectOwnedWorktreeChanges(selected.record, ["src/a.ts"], selected.git)).toThrow(/undeclared write.*src\/hidden.ts/);
    selected.git.untracked = [];
    selected.git.staged = ["src/a.ts"];
    expect(() => inspectOwnedWorktreeChanges(selected.record, ["src/a.ts"], selected.git)).toThrow(/staged.*not allowed/);
    expectNoForbiddenGit(selected.git);
  });

  it("detects ignored writes and disables diff, textconv, and fsmonitor-driven inspection", () => {
    const selected = materialized();
    selected.git.ignored = ["ignored/generated.txt"];
    expect(() => inspectOwnedWorktreeChanges(selected.record, ["src"], selected.git)).toThrow(
      /undeclared write.*ignored\/generated.txt/,
    );

    expect(selected.git.calls.map(({ args }) => args)).toContainEqual([
      "-c", "core.fsmonitor=false", "diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z",
    ]);
    expect(selected.git.calls.map(({ args }) => args)).toContainEqual([
      "-c", "core.fsmonitor=false", "diff", "--cached", "--no-ext-diff", "--no-textconv", "--name-only", "-z",
    ]);
    expect(selected.git.calls.map(({ args }) => args)).toContainEqual([
      "-c", "core.fsmonitor=false", "ls-files", "--others", "--ignored", "--exclude-standard", "-z",
    ]);
    expectNoForbiddenGit(selected.git);
  });

  it("realpaths Git-reported worktree paths before ownership comparison", () => {
    const selected = materialized();
    const leaf = selected.record.worktreePath.split("/").at(-1)!;
    selected.git.worktrees[0]!.path = `${selected.record.worktreePath}/../${leaf}`;
    expect(() => assertOwnedWorktree(selected.record, selected.git)).not.toThrow();
    expectNoForbiddenGit(selected.git);
  });

  it("rejects forged ownership and malformed Git-reported paths without cleanup or publication", () => {
    const selected = materialized();
    const forged = { ...selected.record, baseSha: "c".repeat(40) };
    expect(() => assertOwnedWorktree(forged, selected.git)).toThrow(/ownership.*identity|intent/);

    selected.git.unstaged = ["../outside"];
    expect(() => inspectOwnedWorktreeChanges(selected.record, ["src/a.ts"], selected.git)).toThrow(/canonical.*path|unsafe.*path/);
    expectNoForbiddenGit(selected.git);
  });
});
