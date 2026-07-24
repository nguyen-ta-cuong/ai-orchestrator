import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupOwnedWorktree,
  createLocalGitRunner,
  inspectOwnedWorktreeChanges,
  materializeWorktree,
  prepareWorktreeCleanupIntent,
  prepareWorktreeIntent,
} from "../src/lifecycle/worktreeExecution.js";

const temporaryDirectories: string[] = [];
const now = "2026-07-22T00:00:00.000Z";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("local BUILD worktree adapter", () => {
  it("creates and inspects an isolated candidate, then removes it non-force while preserving main and its branch", () => {
    const repositoryRoot = realpathSync(mkdtempSync(join(tmpdir(), "build-worktree-integration-")));
    temporaryDirectories.push(repositoryRoot);
    git(repositoryRoot, "init");
    git(repositoryRoot, "config", "user.name", "Build Test");
    git(repositoryRoot, "config", "user.email", "build-test@example.invalid");
    mkdirSync(join(repositoryRoot, "src"));
    mkdirSync(join(repositoryRoot, ".candidates"));
    writeFileSync(join(repositoryRoot, ".gitignore"), ".candidates/\n");
    writeFileSync(join(repositoryRoot, "src", "a.ts"), "export const value = 1;\n");
    git(repositoryRoot, "add", ".gitignore", "src/a.ts");
    git(repositoryRoot, "commit", "-m", "fixture");
    const mainHead = git(repositoryRoot, "rev-parse", "HEAD");
    const runner = createLocalGitRunner();
    const intent = prepareWorktreeIntent({
      repositoryRoot,
      candidateRoot: join(repositoryRoot, ".candidates"),
      runId: "run-1",
      nodeId: "implement-a",
      planVersion: 1,
      planHash: "a".repeat(64),
    }, runner);
    const ownership = materializeWorktree(intent, runner, {
      allowCreate: true,
      trustRepositoryCheckout: true,
    });
    expect(git(repositoryRoot, "rev-parse", "HEAD")).toBe(mainHead);
    expect(git(repositoryRoot, "status", "--porcelain")).toBe("");

    writeFileSync(join(ownership.worktreePath, "src", "a.ts"), "export const value = 2;\n");
    expect(inspectOwnedWorktreeChanges(ownership, ["src/a.ts"], runner).changedPaths).toEqual(["src/a.ts"]);
    expect(() => prepareWorktreeCleanupIntent(ownership, runner, now)).toThrow(/dirty|refuses/i);
    writeFileSync(join(ownership.worktreePath, "src", "a.ts"), readFileSync(join(repositoryRoot, "src", "a.ts"), "utf8"));

    const cleanup = prepareWorktreeCleanupIntent(ownership, runner, now);
    const receipt = cleanupOwnedWorktree(cleanup, ownership, runner, { confirmed: true, now });
    expect(receipt).toMatchObject({ status: "released", branchPreserved: true });
    expect(git(repositoryRoot, "show-ref", "--verify", `refs/heads/${ownership.branch}`)).toContain(mainHead);
    expect(git(repositoryRoot, "rev-parse", "HEAD")).toBe(mainHead);
    expect(git(repositoryRoot, "status", "--porcelain")).toBe("");
  });
});
