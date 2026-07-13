import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createIdleLifecycleState, type LifecyclePhase, type LifecycleState } from "../core/lifecycle.js";

export interface RunPaths {
  root: string;
  spec: string;
  plan: string;
  debug: string;
  state: string;
  journal: string;
  routing: string;
  evidence: string;
}

export interface RoutingTraceRecord {
  decisionId: string;
  runId: string;
  stage: string;
  recordedAt: string;
  plan: unknown;
  attempts: readonly { provider: string; model: string; outcome: "selected" | "unavailable" | "unconfigured" }[];
}

export function createRun(cwd: string, artifactsDir: string, task: string, yolo = false): { runId: string; paths: RunPaths } {
  assertArtifactRootSafe(cwd, artifactsDir);
  ensureArtifactsExcludedFromGit(cwd, artifactsDir);
  return withCurrentRunLock(cwd, artifactsDir, () => {
    const currentPath = currentRunPath(cwd, artifactsDir);
    const active = currentRun(cwd, artifactsDir);
    if (active) {
      const activeState = readState(active.paths);
      if (!activeState) {
        throw new Error(`Lifecycle run ${active.runId} has missing or corrupt state; explicit recovery is required`);
      }
      if (isActivePhase(activeState.phase)) {
        throw new Error(`An ai-orchestrator lifecycle run is already active: ${active.runId}`);
      }
      rmSync(currentPath, { force: true });
    } else if (existsSync(currentPath)) {
      throw new Error("Lifecycle current pointer is invalid; explicit recovery is required");
    }

    const runId = createRunId();
    const paths = pathsForRun(cwd, artifactsDir, runId);
    let currentPointerWritten = false;
    try {
      mkdirSync(paths.root, { recursive: true });
      assertRunPathsSafe(paths);
      writeFileSync(paths.spec, "");
      writeFileSync(paths.plan, "");
      writeFileSync(paths.debug, "");
      writeFileSync(paths.journal, `# AI Orchestrator Lifecycle Journal\n\nRun: ${runId}\nTask: ${task}\n\n`);
      writeFileSync(paths.routing, "");
      writeFileSync(paths.evidence, "");
      writeState(paths, createIdleLifecycleState({ runId, phase: "defining", task, yolo }));
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
  assertArtifactRootSafe(cwd, artifactsDir);
  const currentPath = currentRunPath(cwd, artifactsDir);
  assertNoSymlinkComponents(currentPath);
  if (!existsSync(currentPath)) return undefined;
  const runId = readFileSync(currentPath, "utf8").trim();
  if (!isRunId(runId)) return undefined;
  return { runId, paths: pathsForRun(cwd, artifactsDir, runId) };
}

export function readState(paths: RunPaths): LifecycleState | undefined {
  assertRunPathsSafe(paths);
  if (!existsSync(paths.state)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(paths.state, "utf8")) as unknown;
    if (!isLifecycleState(parsed)) return undefined;
    return {
      ...parsed,
      modelSelections: parsed.modelSelections?.map((selection) => ({
        ...selection,
        routing: selection.routing ? {
          ...selection.routing,
          attemptedModels: [...selection.routing.attemptedModels],
          failureCategories: [...selection.routing.failureCategories],
        } : undefined,
      })) ?? [],
    };
  } catch {
    return undefined;
  }
}

export function writeState(paths: RunPaths, state: LifecycleState): void {
  assertRunPathsSafe(paths);
  mkdirSync(paths.root, { recursive: true });
  assertRunPathsSafe(paths);
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
  assertRunPathsSafe(paths);
  mkdirSync(paths.root, { recursive: true });
  assertRunPathsSafe(paths);
  const timestamp = new Date().toISOString();
  writeFileSync(paths.journal, `- ${timestamp} ${line}\n`, { flag: "a" });
}

export function appendRoutingTrace(paths: RunPaths, record: RoutingTraceRecord): void {
  assertRunPathsSafe(paths);
  if (!isRoutingTraceRecord(record)) throw new Error("routing trace record is invalid");
  const line = JSON.stringify(record);
  if (Buffer.byteLength(line, "utf8") > 256 * 1024) throw new Error("routing trace record exceeds 256 KiB");
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.routing, `${line}\n`, { flag: "a" });
}

export function releaseRun(cwd: string, artifactsDir: string, runId: string): boolean {
  assertArtifactRootSafe(cwd, artifactsDir);
  return withCurrentRunLock(cwd, artifactsDir, () => releaseCurrentPointerIfMatches(cwd, artifactsDir, runId));
}

export function pathsForRun(cwd: string, artifactsDir: string, runId: string): RunPaths {
  if (!isRunId(runId)) throw new Error("lifecycle run id is invalid");
  const root = join(realpathSync(cwd), ...normalizeArtifactsDir(artifactsDir).split("/"), runId);
  return {
    root,
    spec: join(root, "spec.md"),
    plan: join(root, "plan.md"),
    debug: join(root, "debug.md"),
    state: join(root, "state.json"),
    journal: join(root, "journal.md"),
    routing: join(root, "routing.jsonl"),
    evidence: join(root, "evidence.jsonl"),
  };
}

function currentRunPath(cwd: string, artifactsDir: string): string {
  return join(realpathSync(cwd), ...normalizeArtifactsDir(artifactsDir).split("/"), "current");
}

function currentRunLockPath(cwd: string, artifactsDir: string): string {
  return join(realpathSync(cwd), ...normalizeArtifactsDir(artifactsDir).split("/"), "current.lock");
}

function releaseCurrentPointerIfMatches(cwd: string, artifactsDir: string, runId: string): boolean {
  const currentPath = currentRunPath(cwd, artifactsDir);
  assertNoSymlinkComponents(currentPath);
  if (!existsSync(currentPath) || readFileSync(currentPath, "utf8").trim() !== runId) {
    return false;
  }
  rmSync(currentPath, { force: true });
  return true;
}

function ensureArtifactsExcludedFromGit(cwd: string, artifactsDir: string): void {
  const gitContext = resolveGitContext(cwd);
  if (!gitContext) return;

  mkdirSync(join(gitContext.excludePath, ".."), { recursive: true });

  const existing = existsSync(gitContext.excludePath) ? readFileSync(gitContext.excludePath, "utf8") : "";
  const existingPatterns = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const additions = gitExcludePatterns(cwd, gitContext.worktreeRoot, artifactsDir).filter((pattern) => !existingPatterns.has(pattern));
  if (additions.length === 0) return;

  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(gitContext.excludePath, `${separator}# ai-orchestrator lifecycle artifacts\n${additions.join("\n")}\n`, { flag: "a" });
}

function gitExcludePatterns(cwd: string, worktreeRoot: string, artifactsDir: string): string[] {
  const normalized = normalizeArtifactsDir(artifactsDir);
  const realCwd = realpathSync(cwd);
  const realWorktreeRoot = realpathSync(worktreeRoot);
  const artifactRoot = join(realCwd, ...normalized.split("/"));
  const relativeArtifactRoot = relative(realWorktreeRoot, artifactRoot);
  if (relativeArtifactRoot.length === 0 || relativeArtifactRoot.startsWith("..") || isAbsolute(relativeArtifactRoot)) {
    return [`/${gitIgnorePath(normalized.split("/"))}/`];
  }
  return [`/${gitIgnorePath(relativeArtifactRoot.split(/[\\/]+/))}/`];
}

function gitIgnorePath(segments: string[]): string {
  return segments.map(escapeGitIgnoreSegment).join("/");
}

function escapeGitIgnoreSegment(segment: string): string {
  return segment.replace(/([\\*?\[\]#! ])/g, "\\$1");
}

function resolveGitContext(cwd: string): { excludePath: string; worktreeRoot: string } | undefined {
  try {
    const gitPath = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const worktreeRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (gitPath.length > 0 && worktreeRoot.length > 0) {
      return {
        excludePath: isAbsolute(gitPath) ? gitPath : join(cwd, gitPath),
        worktreeRoot,
      };
    }
  } catch {
    // Fall back to direct .git resolution for tests and minimal Git installations.
  }

  const gitDir = resolveGitDir(cwd);
  return gitDir ? { excludePath: join(gitDir, "info", "exclude"), worktreeRoot: cwd } : undefined;
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
  assertArtifactRootSafe(cwd, artifactsDir);
  const lockPath = currentRunLockPath(cwd, artifactsDir);
  mkdirSync(join(lockPath, ".."), { recursive: true });
  assertArtifactRootSafe(cwd, artifactsDir);
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

function assertArtifactRootSafe(cwd: string, artifactsDir: string): void {
  const projectRoot = realpathSync(cwd);
  const artifactRoot = resolve(projectRoot, ...normalizeArtifactsDir(artifactsDir).split("/"));
  const contained = relative(projectRoot, artifactRoot);
  if (!contained || contained.startsWith("..") || isAbsolute(contained)) {
    throw new Error("Lifecycle artifact root must remain inside the project");
  }
  assertNoSymlinkComponents(artifactRoot);
}

export function assertRunPathsSafe(paths: RunPaths): void {
  for (const path of Object.values(paths)) assertNoSymlinkComponents(path);
}

function assertNoSymlinkComponents(target: string): void {
  const absolute = resolve(target);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`Lifecycle artifact path must not contain symlinks: ${current}`);
      }
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) return;
      throw error;
    }
  }
}

function normalizeArtifactsDir(artifactsDir: string): string {
  if (artifactsDir.trim().length === 0 || isAbsolute(artifactsDir) || artifactsDir.startsWith("/") || artifactsDir.startsWith("\\") || /^[A-Za-z]:/.test(artifactsDir)) {
    throw new Error("artifactsDir must be a relative path inside the project");
  }
  if (/[\u0000-\u001f\u007f]/.test(artifactsDir)) {
    throw new Error("artifactsDir must not contain control characters");
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
  "debugging",
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
    (candidate.modelSelections === undefined ||
      (Array.isArray(candidate.modelSelections) && candidate.modelSelections.every(isLifecycleModelSelection))) &&
    (candidate.debugPath === undefined || typeof candidate.debugPath === "string") &&
    (candidate.debugDiagnosisVerdictIndex === undefined ||
      (Number.isInteger(candidate.debugDiagnosisVerdictIndex) && candidate.debugDiagnosisVerdictIndex >= 0)) &&
    (candidate.baselinePaths === undefined ||
      (Array.isArray(candidate.baselinePaths) && candidate.baselinePaths.every((path) => typeof path === "string"))) &&
    (candidate.baselineStagedPaths === undefined ||
      (Array.isArray(candidate.baselineStagedPaths) && candidate.baselineStagedPaths.every((path) => typeof path === "string"))) &&
    (candidate.modelRestored === undefined || typeof candidate.modelRestored === "boolean") &&
    isLifecycleOriginalModel(candidate.originalModel) &&
    isLifecycleFinalization(candidate.finalization) &&
    typeof candidate.yolo === "boolean"
  );
}

function isLifecycleOriginalModel(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.provider === "string" && candidate.provider.length > 0 &&
    typeof candidate.id === "string" && candidate.id.length > 0 && isThinkingLevel(candidate.thinking);
}

function isLifecycleFinalization(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (candidate.commitSha === undefined || typeof candidate.commitSha === "string") &&
    (candidate.prUrl === undefined || typeof candidate.prUrl === "string");
}

function isThinkingLevel(value: unknown): boolean {
  return value === "off" || value === "minimal" || value === "low" || value === "medium" ||
    value === "high" || value === "xhigh" || value === "max";
}

function isLifecycleModelSelection(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.stage === "define" || candidate.stage === "plan" || candidate.stage === "verify" ||
      candidate.stage === "review" || candidate.stage === "debug" || candidate.stage === "ship" ||
      candidate.stage === "build") &&
    typeof candidate.provider === "string" && candidate.provider.length > 0 &&
    typeof candidate.model === "string" && candidate.model.length > 0 &&
    (candidate.family === undefined || typeof candidate.family === "string") &&
    isThinkingLevel(candidate.thinking) &&
    typeof candidate.reason === "string" &&
    typeof candidate.selectedAt === "string" && isRoutingSummary(candidate.routing)
  );
}

function isRoutingSummary(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.decisionId === "string" && candidate.decisionId.length > 0 &&
    (candidate.engine === "legacy" || candidate.engine === "capability-shadow" || candidate.engine === "capability") &&
    typeof candidate.policyVersion === "string" &&
    (candidate.profileVersion === undefined || typeof candidate.profileVersion === "string") &&
    typeof candidate.taskFeaturesHash === "string" &&
    Number.isInteger(candidate.selectedRank) && (candidate.selectedRank as number) > 0 &&
    (candidate.score === undefined || typeof candidate.score === "number") &&
    (candidate.separation === "not-applicable" || candidate.separation === "different-model" || candidate.separation === "different-family") &&
    Number.isInteger(candidate.fallbackCount) && (candidate.fallbackCount as number) >= 0 &&
    Array.isArray(candidate.attemptedModels) && candidate.attemptedModels.every((item) => typeof item === "string") &&
    Array.isArray(candidate.failureCategories) && candidate.failureCategories.every((item) => typeof item === "string");
}

function isRoutingTraceRecord(value: unknown): value is RoutingTraceRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.decisionId === "string" && candidate.decisionId.length > 0 &&
    typeof candidate.runId === "string" && candidate.runId.length > 0 &&
    typeof candidate.stage === "string" && candidate.stage.length > 0 &&
    typeof candidate.recordedAt === "string" && candidate.plan !== undefined && Array.isArray(candidate.attempts) &&
    candidate.attempts.every((attempt) => {
      if (!attempt || typeof attempt !== "object") return false;
      const item = attempt as Record<string, unknown>;
      return typeof item.provider === "string" && typeof item.model === "string" &&
        (item.outcome === "selected" || item.outcome === "unavailable" || item.outcome === "unconfigured");
    });
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
