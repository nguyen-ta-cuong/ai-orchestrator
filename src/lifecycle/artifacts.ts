import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomBytes } from "node:crypto";
import { createIdleLifecycleState, type LifecyclePhase, type LifecycleState } from "../core/lifecycle.js";

export interface RunPaths {
  root: string;
  spec: string;
  plan: string;
  state: string;
  journal: string;
}

export function createRun(cwd: string, artifactsDir: string, task: string): { runId: string; paths: RunPaths } {
  ensureArtifactsExcludedFromGit(cwd, artifactsDir);
  return withCurrentRunLock(cwd, artifactsDir, () => {
    const currentPath = currentRunPath(cwd, artifactsDir);
    const active = currentRun(cwd, artifactsDir);
    if (active) {
      const activeState = readState(active.paths);
      if (activeState && isActivePhase(activeState.phase)) {
        throw new Error(`An ai-orchestrator lifecycle run is already active: ${active.runId}`);
      }
      rmSync(currentPath, { force: true });
    } else if (existsSync(currentPath)) {
      rmSync(currentPath, { force: true });
    }

    const runId = createRunId();
    const paths = pathsForRun(cwd, artifactsDir, runId);
    let currentPointerWritten = false;
    try {
      mkdirSync(paths.root, { recursive: true });
      writeFileSync(paths.spec, "");
      writeFileSync(paths.plan, "");
      writeFileSync(paths.journal, `# AI Orchestrator Lifecycle Journal\n\nRun: ${runId}\nTask: ${task}\n\n`);
      writeState(paths, createIdleLifecycleState({ runId, phase: "defining", task }));
      writeFileSync(currentPath, `${runId}\n`, { flag: "wx" });
      currentPointerWritten = true;
      return { runId, paths };
    } finally {
      if (!currentPointerWritten) {
        rmSync(paths.root, { recursive: true, force: true });
      }
    }
  });
}

export function currentRun(cwd: string, artifactsDir: string): { runId: string; paths: RunPaths } | undefined {
  const currentPath = currentRunPath(cwd, artifactsDir);
  if (!existsSync(currentPath)) return undefined;
  const runId = readFileSync(currentPath, "utf8").trim();
  if (!isRunId(runId)) return undefined;
  return { runId, paths: pathsForRun(cwd, artifactsDir, runId) };
}

export function readState(paths: RunPaths): LifecycleState | undefined {
  if (!existsSync(paths.state)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(paths.state, "utf8")) as unknown;
    return isLifecycleState(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function writeState(paths: RunPaths, state: LifecycleState): void {
  mkdirSync(paths.root, { recursive: true });
  const tempPath = `${paths.state}.${process.pid}.${Date.now()}.tmp`;
  let completed = false;
  try {
    writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tempPath, paths.state);
    completed = true;
  } finally {
    if (!completed) {
      rmSync(tempPath, { force: true });
    }
  }
}

export function appendJournal(paths: RunPaths, line: string): void {
  mkdirSync(paths.root, { recursive: true });
  const timestamp = new Date().toISOString();
  writeFileSync(paths.journal, `- ${timestamp} ${line}\n`, { flag: "a" });
}

export function releaseRun(cwd: string, artifactsDir: string, runId: string): boolean {
  return withCurrentRunLock(cwd, artifactsDir, () => releaseCurrentPointerIfMatches(cwd, artifactsDir, runId));
}

export function pathsForRun(cwd: string, artifactsDir: string, runId: string): RunPaths {
  const root = join(cwd, ...normalizeArtifactsDir(artifactsDir).split("/"), runId);
  return {
    root,
    spec: join(root, "spec.md"),
    plan: join(root, "plan.md"),
    state: join(root, "state.json"),
    journal: join(root, "journal.md"),
  };
}

function currentRunPath(cwd: string, artifactsDir: string): string {
  return join(cwd, ...currentParentSegments(artifactsDir), "current");
}

function currentRunLockPath(cwd: string, artifactsDir: string): string {
  return join(cwd, ...currentParentSegments(artifactsDir), "current.lock");
}

function releaseCurrentPointerIfMatches(cwd: string, artifactsDir: string, runId: string): boolean {
  const currentPath = currentRunPath(cwd, artifactsDir);
  if (!existsSync(currentPath) || readFileSync(currentPath, "utf8").trim() !== runId) {
    return false;
  }
  rmSync(currentPath, { force: true });
  return true;
}

function currentParentSegments(artifactsDir: string): string[] {
  const segments = normalizeArtifactsDir(artifactsDir).split("/");
  return segments.slice(0, -1);
}

function ensureArtifactsExcludedFromGit(cwd: string, artifactsDir: string): void {
  const gitDir = resolveGitDir(cwd);
  if (!gitDir) return;

  const infoDir = join(gitDir, "info");
  const excludePath = join(infoDir, "exclude");
  mkdirSync(infoDir, { recursive: true });

  const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  const existingPatterns = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const additions = gitExcludePatterns(artifactsDir).filter((pattern) => !existingPatterns.has(pattern));
  if (additions.length === 0) return;

  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(excludePath, `${separator}# ai-orchestrator lifecycle artifacts\n${additions.join("\n")}\n`, { flag: "a" });
}

function gitExcludePatterns(artifactsDir: string): string[] {
  const normalized = normalizeArtifactsDir(artifactsDir);
  const parent = normalized.split("/").slice(0, -1).join("/");
  return [`/${normalized}/`, `/${parent}/current`, `/${parent}/current.lock/`];
}

function resolveGitDir(cwd: string): string | undefined {
  const dotGitPath = join(cwd, ".git");
  if (!existsSync(dotGitPath)) return undefined;

  try {
    const dotGitStat = statSync(dotGitPath);
    if (dotGitStat.isDirectory()) return dotGitPath;
    if (!dotGitStat.isFile()) return undefined;

    const match = /^gitdir:\s*(.+)$/i.exec(readFileSync(dotGitPath, "utf8").trim());
    if (!match) return undefined;

    const gitDir = isAbsolute(match[1]) ? match[1] : join(cwd, match[1]);
    return statSync(gitDir).isDirectory() ? gitDir : undefined;
  } catch {
    return undefined;
  }
}

function withCurrentRunLock<T>(cwd: string, artifactsDir: string, operation: () => T): T {
  const lockPath = currentRunLockPath(cwd, artifactsDir);
  mkdirSync(join(lockPath, ".."), { recursive: true });
  let locked = false;
  try {
    mkdirSync(lockPath);
    locked = true;
    return operation();
  } catch (error) {
    if (isNodeErrorWithCode(error, "EEXIST")) {
      throw new Error("An ai-orchestrator lifecycle run is already active or starting");
    }
    throw error;
  } finally {
    if (locked) {
      rmSync(lockPath, { recursive: true, force: true });
    }
  }
}

function normalizeArtifactsDir(artifactsDir: string): string {
  if (artifactsDir.trim().length === 0 || isAbsolute(artifactsDir) || artifactsDir.startsWith("/") || artifactsDir.startsWith("\\") || /^[A-Za-z]:/.test(artifactsDir)) {
    throw new Error("artifactsDir must be a relative path inside the project");
  }

  const stack: string[] = [];
  for (const part of artifactsDir.split(/[\\/]+/)) {
    if (part.length === 0 || part === ".") continue;
    if (part === "..") {
      if (stack.length === 0) {
        throw new Error("artifactsDir must be a relative path inside the project");
      }
      stack.pop();
      continue;
    }
    stack.push(part);
  }

  if (stack.length < 2) {
    throw new Error("artifactsDir must contain a dedicated parent directory and child directory inside the project");
  }

  const basename = stack[stack.length - 1];
  if (basename === "current" || basename === "current.lock") {
    throw new Error("artifactsDir basename is reserved for lifecycle run coordination");
  }
  return stack.join("/");
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function createRunId(): string {
  const now = new Date();
  const date = [
    now.getFullYear().toString().padStart(4, "0"),
    (now.getMonth() + 1).toString().padStart(2, "0"),
    now.getDate().toString().padStart(2, "0"),
  ].join("");
  const time = [
    now.getHours().toString().padStart(2, "0"),
    now.getMinutes().toString().padStart(2, "0"),
  ].join("");
  return `${date}-${time}-${randomBytes(4).toString("hex").slice(0, 6)}`;
}

function isRunId(value: string): boolean {
  return /^\d{8}-\d{4}-[a-f0-9]{6}$/.test(value);
}

const LIFECYCLE_PHASES = new Set<LifecyclePhase>([
  "idle",
  "defining",
  "awaiting_spec_approval",
  "planning",
  "awaiting_plan_approval",
  "building",
  "verifying",
  "reviewing",
  "shipping",
  "awaiting_ship_approval",
  "finalizing",
  "done",
  "failed",
]);

function isActivePhase(phase: LifecycleState["phase"]): boolean {
  return phase !== "idle" && phase !== "done" && phase !== "failed";
}

function isLifecycleState(value: unknown): value is LifecycleState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LifecycleState>;
  return (
    candidate.version === 1 &&
    typeof candidate.runId === "string" &&
    isRunId(candidate.runId) &&
    typeof candidate.phase === "string" &&
    LIFECYCLE_PHASES.has(candidate.phase as LifecyclePhase) &&
    typeof candidate.task === "string" &&
    typeof candidate.buildIterations === "number" &&
    typeof candidate.consecutiveRejections === "number" &&
    Array.isArray(candidate.verdicts) &&
    candidate.verdicts.every(isLifecycleVerdict) &&
    typeof candidate.yolo === "boolean"
  );
}

function isLifecycleVerdict(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { stage?: unknown; verdict?: unknown; reasons?: unknown; requiredFixes?: unknown };
  return (
    (candidate.stage === "verify" || candidate.stage === "review" || candidate.stage === "ship") &&
    (candidate.verdict === "approve" || candidate.verdict === "reject") &&
    typeof candidate.reasons === "string" &&
    (candidate.requiredFixes === undefined || typeof candidate.requiredFixes === "string")
  );
}
