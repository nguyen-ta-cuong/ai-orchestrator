import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import type { BuildWorkspaceIdentity } from "../core/buildExecution.js";
import type { BuildWorkspaceInspection, BuildWorktreeOwnershipProof } from "../core/buildScheduler.js";
import { requireBuildRepositoryPath } from "../core/repositoryPath.js";

export interface GitCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitRunner {
  run(args: readonly string[], options: { cwd: string }): GitCommandResult;
}

export interface PrepareWorktreeOptions {
  repositoryRoot: string;
  candidateRoot: string;
  runId: string;
  nodeId: string;
  planVersion: number;
  planHash: string;
}

export interface WorktreeExecutionIntent {
  schemaVersion: 1;
  intentId: string;
  repositoryRoot: string;
  commonDir: string;
  candidateRoot: string;
  worktreePath: string;
  baseSha: string;
  branch: string;
  runId: string;
  nodeId: string;
  planVersion: number;
  planHash: string;
}

export interface WorktreeOwnershipRecord extends WorktreeExecutionIntent {
  reconciled: boolean;
  cleanupStatus: "active";
}

export interface MaterializeWorktreeOptions {
  allowCreate: boolean;
  trustRepositoryCheckout: boolean;
}

export interface WorktreeChangeInspection {
  changedPaths: readonly string[];
  stagedPaths: readonly string[];
}

export interface WorktreeCleanupIntent {
  schemaVersion: 1;
  cleanupId: string;
  intentId: string;
  runId: string;
  nodeId: string;
  planVersion: number;
  planHash: string;
  repositoryRoot: string;
  worktreePath: string;
  branch: string;
  candidateHead: string;
  preparedAt: string;
}

export interface WorktreeCleanupReceipt {
  schemaVersion: 1;
  cleanupId: string;
  intentId: string;
  runId: string;
  nodeId: string;
  planVersion: number;
  planHash: string;
  worktreePath: string;
  branch: string;
  candidateHead: string;
  status: "released";
  branchPreserved: true;
  reconciledAt: string;
}

interface ListedWorktree {
  path: string;
  head?: string;
  branch?: string;
}

const TOKEN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SHA256 = /^[a-f0-9]{64}$/;
const INTENT_KEYS = [
  "schemaVersion", "intentId", "repositoryRoot", "commonDir", "candidateRoot", "worktreePath", "baseSha", "branch",
  "runId", "nodeId", "planVersion",
  "planHash",
] as const;
const RECORD_KEYS = [...INTENT_KEYS, "reconciled", "cleanupStatus"] as const;
const CLEANUP_INTENT_KEYS = [
  "schemaVersion", "cleanupId", "intentId", "runId", "nodeId", "planVersion", "planHash", "repositoryRoot",
  "worktreePath", "branch", "candidateHead", "preparedAt",
] as const;
const SAFE_STATUS_ARGS = ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "--untracked-files=all"] as const;
const SAFE_UNSTAGED_ARGS = ["-c", "core.fsmonitor=false", "diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z"] as const;
const SAFE_STAGED_ARGS = ["-c", "core.fsmonitor=false", "diff", "--cached", "--no-ext-diff", "--no-textconv", "--name-only", "-z"] as const;
const SAFE_UNTRACKED_ARGS = ["-c", "core.fsmonitor=false", "ls-files", "--others", "--exclude-standard", "-z"] as const;
const SAFE_IGNORED_ARGS = ["-c", "core.fsmonitor=false", "ls-files", "--others", "--ignored", "--exclude-standard", "-z"] as const;
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Execute generated Git argv directly without a shell or string interpolation. */
export function createLocalGitRunner(options: Readonly<{ timeoutMs?: number }> = {}): GitRunner {
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30 * 60 * 1_000) {
    throw new Error("Local Git runner timeout must be an integer from 1ms through 30 minutes");
  }
  return Object.freeze({
    run(args: readonly string[], options: { cwd: string }): GitCommandResult {
      if (!Array.isArray(args) || args.length === 0 || args.length > 128 ||
          args.some((argument) => typeof argument !== "string" || argument.length === 0 || /[\u0000\r\n]/.test(argument)) ||
          args.reduce((bytes, argument) => bytes + Buffer.byteLength(argument, "utf8"), 0) > 64 * 1024) {
        throw new Error("Local Git runner requires a non-empty bounded argv vector");
      }
      const cwd = canonicalExistingDirectory(options.cwd, "local Git working directory");
      const result = spawnSync("git", [...args], {
        cwd,
        encoding: "utf8",
        shell: false,
        windowsHide: true,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        timeout: timeoutMs,
      });
      if (result.error) throw new Error(`Local Git invocation failed: ${result.error.message}`);
      if (result.status === null) throw new Error(`Local Git invocation ended without an exit code${result.signal ? ` (${result.signal})` : ""}`);
      const output = { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
      assertBoundedGitResult(output, "local Git invocation");
      return output;
    },
  });
}

/** Reconstruct the full immutable intent from a durable planned authority. */
export function reconstructWorktreeIntent(
  options: Readonly<{ repositoryRoot: string; candidateRoot: string }>,
  authorityValue: Exclude<Readonly<BuildWorkspaceIdentity>, { kind: "shared" }>,
  git: GitRunner,
): WorktreeExecutionIntent {
  const authority = authorityValue;
  const repositoryRoot = canonicalExistingDirectory(options.repositoryRoot, "repository root");
  const candidateRoot = canonicalExistingDirectory(options.candidateRoot, "candidate worktree root");
  assertStrictlyContained(repositoryRoot, candidateRoot, "candidate worktree root must remain inside the repository");
  assertCandidateRootIgnored(git, repositoryRoot, candidateRoot);
  const reportedRoot = readGitPath(git, repositoryRoot, ["rev-parse", "--show-toplevel"], "repository root");
  if (reportedRoot !== repositoryRoot) throw new Error("Git repository root does not match the durable worktree authority");
  const commonDir = readGitPath(
    git,
    repositoryRoot,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    "Git common directory",
  );
  const intent = createIntent({
    repositoryRoot,
    commonDir,
    candidateRoot,
    worktreePath: authority.worktreePath,
    baseSha: authority.baseSha,
    branch: `codex/build/${authority.runId}/v${authority.planVersion}/${authority.ownerNodeId}`,
    runId: authority.runId,
    nodeId: authority.ownerNodeId,
    planVersion: authority.planVersion,
    planHash: authority.planHash,
  });
  if (authority.kind !== "planned-worktree" || authority.intentId !== intent.intentId ||
      authority.worktreePath !== intent.worktreePath) {
    throw new Error("Durable planned worktree authority does not match its reconstructed intent");
  }
  return intent;
}

export function prepareWorktreeIntent(
  options: Readonly<PrepareWorktreeOptions>,
  git: GitRunner,
): WorktreeExecutionIntent {
  const runId = requireToken(options.runId, "BUILD worktree run id");
  const nodeId = requireToken(options.nodeId, "BUILD worktree node id");
  const planVersion = requirePositiveInteger(options.planVersion, "BUILD worktree plan version");
  const planHash = requirePlanHash(options.planHash);
  const repositoryRoot = canonicalExistingDirectory(options.repositoryRoot, "repository root");
  const reportedRoot = readGitPath(git, repositoryRoot, ["rev-parse", "--show-toplevel"], "repository root");
  if (reportedRoot !== repositoryRoot) throw new Error("Git repository root does not match the requested canonical repository");
  assertCleanBase(git, repositoryRoot);
  const commonDir = readGitPath(
    git,
    repositoryRoot,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    "Git common directory",
  );
  const baseSha = readGitSha(git, repositoryRoot, ["rev-parse", "HEAD"], "base HEAD");
  const candidateRoot = canonicalExistingDirectory(options.candidateRoot, "candidate worktree root");
  assertStrictlyContained(repositoryRoot, candidateRoot, "candidate worktree root must remain inside the repository");
  assertCandidateRootIgnored(git, repositoryRoot, candidateRoot);
  const branch = `codex/build/${runId}/v${planVersion}/${nodeId}`;
  const worktreePath = resolve(candidateRoot, `${runId}-v${planVersion}-${nodeId}`);
  assertStrictlyContained(candidateRoot, worktreePath, "candidate worktree path must remain inside its configured root");
  assertNoSymlinkComponents(worktreePath);
  if (existsSync(worktreePath)) throw new Error(`Candidate worktree path already exists: ${worktreePath}`);

  const listed = readWorktrees(git, repositoryRoot);
  assertNoRegisteredCollision(listed, worktreePath, branch);
  if (branchExists(git, repositoryRoot, branch)) throw new Error(`Candidate branch already exists: ${branch}`);
  return createIntent({
    repositoryRoot,
    commonDir,
    candidateRoot,
    worktreePath,
    baseSha,
    branch,
    runId,
    nodeId,
    planVersion,
    planHash,
  });
}

export function materializeWorktree(
  intentValue: Readonly<WorktreeExecutionIntent>,
  git: GitRunner,
  options: Readonly<MaterializeWorktreeOptions>,
): WorktreeOwnershipRecord {
  const intent = validateIntent(intentValue);
  if (options.allowCreate !== true) throw new Error("BUILD worktree creation requires explicit opt-in");
  if (options.trustRepositoryCheckout !== true) {
    throw new Error("BUILD worktree creation requires explicit trust in repository checkout hooks and filters");
  }
  assertCandidateRootIgnored(git, intent.repositoryRoot, intent.candidateRoot);
  const recovered = reconcileWorktreeIntent(intent, git);
  if (recovered) return recovered;

  assertRepositoryIdentity(intent, git);
  assertCleanBase(git, intent.repositoryRoot);
  const currentHead = readGitSha(git, intent.repositoryRoot, ["rev-parse", "HEAD"], "base HEAD");
  if (currentHead !== intent.baseSha) throw new Error("Repository HEAD changed after BUILD worktree intent preparation");
  assertNoSymlinkComponents(intent.worktreePath);
  if (existsSync(intent.worktreePath)) throw new Error(`Candidate worktree path already exists: ${intent.worktreePath}`);
  const listed = readWorktrees(git, intent.repositoryRoot);
  assertNoRegisteredCollision(listed, intent.worktreePath, intent.branch);
  if (branchExists(git, intent.repositoryRoot, intent.branch)) throw new Error(`Candidate branch already exists: ${intent.branch}`);

  const result = git.run(
    ["worktree", "add", "-b", intent.branch, intent.worktreePath, intent.baseSha],
    { cwd: intent.repositoryRoot },
  );
  assertBoundedGitResult(result, "git worktree add");
  if (result.code !== 0) throw new Error(`git worktree add failed with exit code ${result.code}; no cleanup was attempted`);
  const owned = reconcileWorktreeIntent(intent, git);
  if (!owned) throw new Error("git worktree add returned success but ownership could not be reconciled; explicit recovery is required");
  return createOwnershipRecord(intent, false);
}

export function reconcileWorktreeIntent(
  intentValue: Readonly<WorktreeExecutionIntent>,
  git: GitRunner,
): WorktreeOwnershipRecord | undefined {
  const intent = validateIntent(intentValue);
  assertCandidateRootIgnored(git, intent.repositoryRoot, intent.candidateRoot);
  assertRepositoryIdentity(intent, git);
  const listed = readWorktrees(git, intent.repositoryRoot);
  const atPath = listed.filter((entry) => entry.path === intent.worktreePath);
  const onBranch = listed.filter((entry) => entry.branch === intent.branch);
  if (atPath.length > 1 || onBranch.length > 1) throw new Error("Stale BUILD worktree ownership has duplicate Git registrations");
  if (atPath.length === 1) {
    const entry = atPath[0]!;
    if (entry.branch !== intent.branch) throw new Error(`Stale BUILD worktree ownership: path is registered to a different branch`);
    if (entry.head !== intent.baseSha) throw new Error(`Stale BUILD worktree ownership: candidate HEAD differs from the recorded base`);
    if (!existsSync(intent.worktreePath)) throw new Error("Stale BUILD worktree ownership: registered path is missing");
    const actual = canonicalExistingDirectory(intent.worktreePath, "registered candidate worktree");
    if (actual !== intent.worktreePath) throw new Error("Stale BUILD worktree ownership: registered path changed identity");
    return createOwnershipRecord(intent, true);
  }
  if (onBranch.length === 1) throw new Error("Stale BUILD worktree ownership: candidate branch is registered at a different path");
  if (existsSync(intent.worktreePath)) throw new Error("Stale BUILD worktree ownership: candidate path exists without its Git registration");
  if (branchExists(git, intent.repositoryRoot, intent.branch)) {
    throw new Error("Stale BUILD worktree ownership: candidate branch exists without its recorded worktree");
  }
  return undefined;
}

/** Convert an immutable worktree intent into the only planned authority accepted by BUILD dispatch. */
export function createPlannedBuildWorkspaceIdentity(
  intentValue: Readonly<WorktreeExecutionIntent>,
): Readonly<BuildWorkspaceIdentity> {
  const intent = validateIntent(intentValue);
  return Object.freeze({
    kind: "planned-worktree",
    intentId: intent.intentId,
    runId: intent.runId,
    planVersion: intent.planVersion,
    planHash: intent.planHash,
    ownerNodeId: intent.nodeId,
    baseSha: intent.baseSha,
    worktreePath: intent.worktreePath,
  });
}

/** Reconcile Git before minting owned authority bound to the immutable effect receipt. */
export function createOwnedBuildWorkspaceIdentity(
  recordValue: Readonly<WorktreeOwnershipRecord>,
  ownershipReceiptHash: string,
  git: GitRunner,
): Readonly<BuildWorkspaceIdentity> {
  const record = validateOwnershipRecord(recordValue);
  if (typeof ownershipReceiptHash !== "string" || !SHA256.test(ownershipReceiptHash)) {
    throw new Error("BUILD worktree ownership receipt hash is invalid");
  }
  assertOwnedWorktree(record, git);
  return Object.freeze({
    kind: "owned-worktree",
    intentId: record.intentId,
    runId: record.runId,
    planVersion: record.planVersion,
    planHash: record.planHash,
    ownerNodeId: record.nodeId,
    baseSha: record.baseSha,
    worktreePath: record.worktreePath,
    ownershipReceiptHash,
  });
}

export function assertOwnedWorktree(recordValue: Readonly<WorktreeOwnershipRecord>, git: GitRunner): void {
  const record = validateOwnershipRecord(recordValue);
  const reconciled = reconcileWorktreeIntent(toIntent(record), git);
  if (!reconciled) throw new Error("BUILD worktree ownership no longer exists");
}

/** Reconcile Git immediately before minting the bounded proof consumed by pure dispatch policy. */
export function createBuildWorktreeOwnershipProof(
  recordValue: Readonly<WorktreeOwnershipRecord>,
  git: GitRunner,
): Readonly<BuildWorktreeOwnershipProof> {
  const record = validateOwnershipRecord(recordValue);
  assertOwnedWorktree(record, git);
  return Object.freeze({
    schemaVersion: 1,
    intentId: record.intentId,
    runId: record.runId,
    nodeId: record.nodeId,
    planVersion: record.planVersion,
    planHash: record.planHash,
    baseSha: record.baseSha,
    reconciled: true,
    cleanupStatus: record.cleanupStatus,
  });
}

export function inspectOwnedWorktreeChanges(
  recordValue: Readonly<WorktreeOwnershipRecord>,
  declaredWriteSet: readonly string[],
  git: GitRunner,
): WorktreeChangeInspection {
  const record = validateOwnershipRecord(recordValue);
  assertOwnedWorktree(record, git);
  const declared = normalizeDeclaredPaths(declaredWriteSet);
  const unstaged = readGitPaths(git, record.worktreePath, SAFE_UNSTAGED_ARGS, "unstaged worktree changes");
  const staged = readGitPaths(git, record.worktreePath, SAFE_STAGED_ARGS, "staged worktree changes");
  const untracked = readGitPaths(git, record.worktreePath, SAFE_UNTRACKED_ARGS, "untracked worktree changes");
  const ignored = readGitPaths(git, record.worktreePath, SAFE_IGNORED_ARGS, "ignored worktree changes");
  if (staged.length > 0) throw new Error(`staged BUILD worktree changes are not allowed: ${staged.join(", ")}`);
  const changedPaths = uniquePaths([...unstaged, ...untracked, ...ignored]);
  for (const changed of changedPaths) {
    if (!declared.some((allowed) => pathContains(allowed, changed))) {
      throw new Error(`BUILD worktree contains undeclared write ${changed}`);
    }
  }
  return Object.freeze({ changedPaths: Object.freeze(changedPaths), stagedPaths: Object.freeze([]) });
}

/** Inspect a shared BUILD workspace against the same bounded path policy. */
export function inspectSharedBuildWorkspace(
  repositoryRootValue: string,
  declaredWriteSet: readonly string[],
  git: GitRunner,
): WorktreeChangeInspection {
  const repositoryRoot = canonicalExistingDirectory(repositoryRootValue, "shared BUILD repository root");
  const declared = normalizeDeclaredPaths(declaredWriteSet);
  const unstaged = readGitPaths(git, repositoryRoot, SAFE_UNSTAGED_ARGS, "unstaged shared BUILD changes");
  const staged = readGitPaths(git, repositoryRoot, SAFE_STAGED_ARGS, "staged shared BUILD changes");
  const untracked = readGitPaths(git, repositoryRoot, SAFE_UNTRACKED_ARGS, "untracked shared BUILD changes");
  const ignored = readGitPaths(
    git,
    repositoryRoot,
    SAFE_IGNORED_ARGS,
    "ignored shared BUILD changes",
    { omitProtected: true },
  );
  if (staged.length > 0) throw new Error(`staged shared BUILD changes are not allowed: ${staged.join(", ")}`);
  // A shared repository commonly contains pre-existing ignored caches (for
  // example node_modules). They are not attributable to this node. Nested Pi
  // mutation tools enforce the write set at call time, so only ignored paths
  // inside that set are relevant to this postcondition.
  const declaredIgnored = ignored.filter((path) => declared.some((allowed) => pathContains(allowed, path)));
  const changedPaths = uniquePaths([...unstaged, ...untracked, ...declaredIgnored]);
  for (const changed of changedPaths) {
    if (!declared.some((allowed) => pathContains(allowed, changed))) {
      throw new Error(`shared BUILD workspace contains undeclared write ${changed}`);
    }
  }
  return Object.freeze({ changedPaths: Object.freeze(changedPaths), stagedPaths: Object.freeze([]) });
}

/** Inspect candidate changes and reconcile Git again before returning trusted completion evidence. */
export function inspectOwnedBuildWorkspace(
  recordValue: Readonly<WorktreeOwnershipRecord>,
  declaredWriteSet: readonly string[],
  git: GitRunner,
): Readonly<BuildWorkspaceInspection> {
  const changes = inspectOwnedWorktreeChanges(recordValue, declaredWriteSet, git);
  const ownership = createBuildWorktreeOwnershipProof(recordValue, git);
  return Object.freeze({
    schemaVersion: 1,
    ownership,
    changedPaths: changes.changedPaths,
    stagedPaths: changes.stagedPaths,
  });
}

/** Prepare cleanup evidence without changing Git or the filesystem. */
export function prepareWorktreeCleanupIntent(
  recordValue: Readonly<WorktreeOwnershipRecord>,
  git: GitRunner,
  now: string,
): WorktreeCleanupIntent {
  const record = validateOwnershipRecord(recordValue);
  assertIsoTimestamp(now, "BUILD worktree cleanup timestamp");
  assertOwnedWorktree(record, git);
  assertCleanOwnedWorktree(record, git);
  const candidateHead = readGitSha(git, record.worktreePath, ["rev-parse", "HEAD"], "candidate HEAD");
  const fields = {
    schemaVersion: 1 as const,
    intentId: record.intentId,
    runId: record.runId,
    nodeId: record.nodeId,
    planVersion: record.planVersion,
    planHash: record.planHash,
    repositoryRoot: record.repositoryRoot,
    worktreePath: record.worktreePath,
    branch: record.branch,
    candidateHead,
    preparedAt: now,
  };
  return Object.freeze({ ...fields, cleanupId: createHash("sha256").update(stableJson(fields)).digest("hex") });
}

/**
 * Remove only the exact clean owned worktree, without force and without
 * deleting its branch. The caller must durably checkpoint the cleanup intent
 * before invoking this function.
 */
export function cleanupOwnedWorktree(
  cleanupValue: Readonly<WorktreeCleanupIntent>,
  recordValue: Readonly<WorktreeOwnershipRecord>,
  git: GitRunner,
  options: Readonly<{ confirmed: boolean; now: string }>,
): WorktreeCleanupReceipt {
  const cleanup = validateCleanupIntent(cleanupValue);
  const record = validateOwnershipRecord(recordValue);
  assertCleanupMatchesOwnership(cleanup, record);
  assertIsoTimestamp(options.now, "BUILD worktree cleanup reconciliation timestamp");
  const recovered = reconcileWorktreeCleanup(cleanup, record, git, options.now);
  if (recovered) return recovered;
  if (options.confirmed !== true) throw new Error("BUILD worktree cleanup requires separate explicit confirmation");
  assertOwnedWorktree(record, git);
  assertCleanOwnedWorktree(record, git);
  const candidateHead = readGitSha(git, record.worktreePath, ["rev-parse", "HEAD"], "candidate HEAD");
  if (candidateHead !== cleanup.candidateHead) throw new Error("BUILD worktree changed after cleanup intent preparation");
  const result = git.run(["worktree", "remove", record.worktreePath], { cwd: record.repositoryRoot });
  assertBoundedGitResult(result, "git worktree remove");
  if (result.code !== 0) {
    throw new Error(`git worktree remove failed with exit code ${result.code}; cleanup outcome is unknown and must be reconciled`);
  }
  const receipt = reconcileWorktreeCleanup(cleanup, record, git, options.now);
  if (!receipt) throw new Error("git worktree remove returned success but the owned worktree remains registered");
  return receipt;
}

/** Reconcile a crash after non-force worktree removal without repeating it. */
export function reconcileWorktreeCleanup(
  cleanupValue: Readonly<WorktreeCleanupIntent>,
  recordValue: Readonly<WorktreeOwnershipRecord>,
  git: GitRunner,
  now: string,
): WorktreeCleanupReceipt | undefined {
  const cleanup = validateCleanupIntent(cleanupValue);
  const record = validateOwnershipRecord(recordValue);
  assertCleanupMatchesOwnership(cleanup, record);
  assertIsoTimestamp(now, "BUILD worktree cleanup reconciliation timestamp");
  assertRepositoryIdentity(record, git);
  const listed = readWorktrees(git, record.repositoryRoot);
  const atPath = listed.filter((entry) => entry.path === record.worktreePath);
  const onBranch = listed.filter((entry) => entry.branch === record.branch);
  if (atPath.length > 1 || onBranch.length > 1) throw new Error("BUILD worktree cleanup found duplicate Git registrations");
  if (atPath.length === 1) {
    const entry = atPath[0]!;
    if (entry.branch !== record.branch) throw new Error("BUILD worktree cleanup path is owned by a different branch");
    if (entry.head !== cleanup.candidateHead) throw new Error("BUILD worktree cleanup candidate HEAD changed after confirmation");
    if (!existsSync(record.worktreePath)) throw new Error("BUILD worktree cleanup registration exists but its path is missing");
    return undefined;
  }
  if (onBranch.length === 1) throw new Error("BUILD worktree cleanup candidate was moved to a different path");
  if (existsSync(record.worktreePath)) throw new Error("BUILD worktree cleanup path remains without its Git registration");
  if (!branchExists(git, record.repositoryRoot, record.branch)) {
    throw new Error("BUILD worktree cleanup branch was deleted or cannot be proven to remain");
  }
  return Object.freeze({
    schemaVersion: 1,
    cleanupId: cleanup.cleanupId,
    intentId: cleanup.intentId,
    runId: cleanup.runId,
    nodeId: cleanup.nodeId,
    planVersion: cleanup.planVersion,
    planHash: cleanup.planHash,
    worktreePath: cleanup.worktreePath,
    branch: cleanup.branch,
    candidateHead: cleanup.candidateHead,
    status: "released",
    branchPreserved: true,
    reconciledAt: now,
  });
}

function createIntent(
  fields: Omit<WorktreeExecutionIntent, "schemaVersion" | "intentId">,
): WorktreeExecutionIntent {
  const identity = { schemaVersion: 1 as const, ...fields };
  const intentId = hashIdentity(identity);
  return Object.freeze({ schemaVersion: 1, intentId, ...fields });
}

function createOwnershipRecord(intent: Readonly<WorktreeExecutionIntent>, reconciled: boolean): WorktreeOwnershipRecord {
  return Object.freeze({ ...intent, reconciled, cleanupStatus: "active" });
}

function validateIntent(value: Readonly<WorktreeExecutionIntent>): WorktreeExecutionIntent {
  const source = requireRecord(value, "BUILD worktree intent");
  assertOnlyKeys(source, INTENT_KEYS, "BUILD worktree intent");
  if (source.schemaVersion !== 1) throw new Error("Unsupported BUILD worktree intent schema version");
  const runId = requireToken(source.runId, "BUILD worktree run id");
  const nodeId = requireToken(source.nodeId, "BUILD worktree node id");
  const planVersion = requirePositiveInteger(source.planVersion, "BUILD worktree plan version");
  const planHash = requirePlanHash(source.planHash);
  const repositoryRoot = canonicalExistingDirectory(source.repositoryRoot, "repository root");
  const commonDir = canonicalExistingDirectory(source.commonDir, "Git common directory");
  const candidateRoot = canonicalExistingDirectory(source.candidateRoot, "candidate worktree root");
  assertStrictlyContained(repositoryRoot, candidateRoot, "candidate worktree root must remain inside the repository");
  const worktreePath = canonicalTargetPath(source.worktreePath, "candidate worktree path");
  assertStrictlyContained(candidateRoot, worktreePath, "candidate worktree path must remain inside its configured root");
  const expectedPath = resolve(candidateRoot, `${runId}-v${planVersion}-${nodeId}`);
  if (worktreePath !== expectedPath) throw new Error("BUILD worktree intent path does not match its run, plan, and node identity");
  const branch = requireBranch(source.branch);
  const expectedBranch = `codex/build/${runId}/v${planVersion}/${nodeId}`;
  if (branch !== expectedBranch) throw new Error("BUILD worktree intent branch does not match its run, plan, and node identity");
  const baseSha = requireSha(source.baseSha, "BUILD worktree base SHA");
  if (typeof source.intentId !== "string" || !/^[a-f0-9]{64}$/.test(source.intentId)) {
    throw new Error("BUILD worktree intent identity is invalid");
  }
  const normalized = createIntent({
    repositoryRoot,
    commonDir,
    candidateRoot,
    worktreePath,
    baseSha,
    branch,
    runId,
    nodeId,
    planVersion,
    planHash,
  });
  if (normalized.intentId !== source.intentId) throw new Error("BUILD worktree intent identity does not match its contents");
  return normalized;
}

function validateOwnershipRecord(value: Readonly<WorktreeOwnershipRecord>): WorktreeOwnershipRecord {
  const source = requireRecord(value, "BUILD worktree ownership record");
  assertOnlyKeys(source, RECORD_KEYS, "BUILD worktree ownership record");
  if (typeof source.reconciled !== "boolean") throw new Error("BUILD worktree ownership reconciliation flag is invalid");
  if (source.cleanupStatus !== "active") throw new Error("BUILD worktree cleanup status is not active");
  const intent = validateIntent(toIntent(source));
  return createOwnershipRecord(intent, source.reconciled);
}

function validateCleanupIntent(value: Readonly<WorktreeCleanupIntent>): WorktreeCleanupIntent {
  const source = requireRecord(value, "BUILD worktree cleanup intent");
  assertOnlyKeys(source, CLEANUP_INTENT_KEYS, "BUILD worktree cleanup intent");
  if (source.schemaVersion !== 1 || typeof source.cleanupId !== "string" || !/^[a-f0-9]{64}$/.test(source.cleanupId) ||
      typeof source.intentId !== "string" || !/^[a-f0-9]{64}$/.test(source.intentId)) {
    throw new Error("BUILD worktree cleanup intent identity is invalid");
  }
  const normalized = {
    schemaVersion: 1 as const,
    intentId: source.intentId,
    runId: requireToken(source.runId, "BUILD worktree cleanup run id"),
    nodeId: requireToken(source.nodeId, "BUILD worktree cleanup node id"),
    planVersion: requirePositiveInteger(source.planVersion, "BUILD worktree cleanup plan version"),
    planHash: requirePlanHash(source.planHash),
    repositoryRoot: canonicalExistingDirectory(source.repositoryRoot, "BUILD worktree cleanup repository"),
    worktreePath: canonicalTargetPath(source.worktreePath, "BUILD worktree cleanup path"),
    branch: requireBranch(source.branch),
    candidateHead: requireSha(source.candidateHead, "BUILD worktree cleanup candidate HEAD"),
    preparedAt: requireIsoTimestamp(source.preparedAt, "BUILD worktree cleanup preparation timestamp"),
  };
  const cleanupId = createHash("sha256").update(stableJson(normalized)).digest("hex");
  if (cleanupId !== source.cleanupId) throw new Error("BUILD worktree cleanup intent hash does not match its contents");
  return Object.freeze({ ...normalized, cleanupId });
}

function assertCleanupMatchesOwnership(
  cleanup: Readonly<WorktreeCleanupIntent>,
  record: Readonly<WorktreeOwnershipRecord>,
): void {
  if (cleanup.intentId !== record.intentId || cleanup.runId !== record.runId || cleanup.nodeId !== record.nodeId ||
      cleanup.planVersion !== record.planVersion || cleanup.planHash !== record.planHash ||
      cleanup.repositoryRoot !== record.repositoryRoot || cleanup.worktreePath !== record.worktreePath || cleanup.branch !== record.branch) {
    throw new Error("BUILD worktree cleanup intent does not match exact active ownership");
  }
}

function assertCleanOwnedWorktree(record: Readonly<WorktreeOwnershipRecord>, git: GitRunner): void {
  const dirty = [
    ...readGitPaths(git, record.worktreePath, SAFE_UNSTAGED_ARGS, "cleanup unstaged worktree changes"),
    ...readGitPaths(git, record.worktreePath, SAFE_STAGED_ARGS, "cleanup staged worktree changes"),
    ...readGitPaths(git, record.worktreePath, SAFE_UNTRACKED_ARGS, "cleanup untracked worktree changes"),
    ...readGitPaths(git, record.worktreePath, SAFE_IGNORED_ARGS, "cleanup ignored worktree changes"),
  ];
  if (dirty.length > 0) throw new Error(`BUILD worktree cleanup refuses dirty or unknown paths: ${uniquePaths(dirty).join(", ")}`);
}

function toIntent(value: object): WorktreeExecutionIntent {
  const source = value as Record<string, unknown>;
  return Object.fromEntries(INTENT_KEYS.map((key) => [key, source[key]])) as unknown as WorktreeExecutionIntent;
}

function assertRepositoryIdentity(intent: Readonly<WorktreeExecutionIntent>, git: GitRunner): void {
  const reportedRoot = readGitPath(git, intent.repositoryRoot, ["rev-parse", "--show-toplevel"], "repository root");
  if (reportedRoot !== intent.repositoryRoot) throw new Error("Git repository root changed after BUILD worktree intent preparation");
  const commonDir = readGitPath(
    git,
    intent.repositoryRoot,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    "Git common directory",
  );
  if (commonDir !== intent.commonDir) throw new Error("Git common directory changed after BUILD worktree intent preparation");
}

function assertCleanBase(git: GitRunner, repositoryRoot: string): void {
  const result = runGit(git, repositoryRoot, SAFE_STATUS_ARGS, "git status");
  if (result.stdout.length > 0) throw new Error("BUILD worktree creation requires a clean working tree with no staged, unstaged, or untracked paths");
}

function assertCandidateRootIgnored(git: GitRunner, repositoryRoot: string, candidateRoot: string): void {
  const relativeRoot = relative(repositoryRoot, candidateRoot);
  if (relativeRoot.length === 0 || relativeRoot.startsWith("..") || isAbsolute(relativeRoot) ||
      /[\u0000\r\n]/.test(relativeRoot)) {
    throw new Error("BUILD candidate worktree root is not safely contained in the repository");
  }
  const result = git.run(["check-ignore", "--quiet", "--no-index", "--", relativeRoot], { cwd: repositoryRoot });
  assertBoundedGitResult(result, "git check-ignore");
  if (result.code === 0) return;
  if (result.code === 1) {
    throw new Error("BUILD candidate worktree root must already be ignored so creation cannot dirty the main worktree");
  }
  throw new Error(`git check-ignore failed with exit code ${result.code}`);
}

function readGitPath(git: GitRunner, cwd: string, args: readonly string[], label: string): string {
  const result = runGit(git, cwd, args, label);
  const path = result.stdout.trim();
  if (!isAbsolute(path) || /[\u0000-\u001f\u007f]/.test(path)) throw new Error(`${label} returned a non-canonical path`);
  return canonicalExistingDirectory(path, label);
}

function readGitSha(git: GitRunner, cwd: string, args: readonly string[], label: string): string {
  return requireSha(runGit(git, cwd, args, label).stdout.trim(), label);
}

function readWorktrees(git: GitRunner, cwd: string): ListedWorktree[] {
  const result = runGit(git, cwd, ["worktree", "list", "--porcelain"], "git worktree list");
  return parseWorktreeList(result.stdout);
}

function branchExists(git: GitRunner, cwd: string, branch: string): boolean {
  const result = git.run(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd });
  assertBoundedGitResult(result, "git show-ref");
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new Error(`git show-ref failed with exit code ${result.code}`);
}

function assertNoRegisteredCollision(entries: readonly ListedWorktree[], path: string, branch: string): void {
  if (entries.some((entry) => entry.path === path)) throw new Error(`Candidate worktree collision at registered path ${path}`);
  if (entries.some((entry) => entry.branch === branch)) throw new Error(`Candidate branch is already registered to a worktree: ${branch}`);
}

function parseWorktreeList(output: string): ListedWorktree[] {
  if (output.length === 0) return [];
  const records = output.split(/\n\n+/).map((record) => record.trim()).filter(Boolean);
  return records.map((record, index) => {
    let path: string | undefined;
    let head: string | undefined;
    let branch: string | undefined;
    for (const line of record.split("\n")) {
      if (line.startsWith("worktree ")) path = canonicalTargetPath(line.slice("worktree ".length), `Git worktree ${index} path`);
      else if (line.startsWith("HEAD ")) head = requireSha(line.slice("HEAD ".length), `Git worktree ${index} HEAD`);
      else if (line.startsWith("branch refs/heads/")) branch = requireBranch(line.slice("branch refs/heads/".length));
      else if (line === "detached" || line === "bare" || line === "locked" || line.startsWith("locked ") || line === "prunable" || line.startsWith("prunable ")) {
        // These flags do not alter the canonical identity fields used below.
      } else {
        throw new Error(`Git worktree list contains unsupported record data at entry ${index}`);
      }
    }
    if (!path) throw new Error(`Git worktree list entry ${index} is missing a path`);
    return { path, ...(head ? { head } : {}), ...(branch ? { branch } : {}) };
  });
}

function readGitPaths(
  git: GitRunner,
  cwd: string,
  args: readonly string[],
  label: string,
  options: Readonly<{ omitProtected?: boolean }> = {},
): string[] {
  const output = runGit(git, cwd, args, label).stdout;
  if (output.length === 0) return [];
  if (!output.endsWith("\u0000")) throw new Error(`${label} did not return NUL-delimited paths`);
  const values = output.slice(0, -1).split("\u0000");
  if (values.some((value) => value.length === 0)) throw new Error(`${label} returned an empty path`);
  return uniquePaths(values.flatMap((value) => {
    try {
      return [requireBuildRepositoryPath(value, `${label} path`)];
    } catch (error) {
      if (options.omitProtected && error instanceof Error && /protected path/.test(error.message)) return [];
      throw error;
    }
  }));
}

function runGit(git: GitRunner, cwd: string, args: readonly string[], label: string): GitCommandResult {
  const result = git.run(args, { cwd });
  assertBoundedGitResult(result, label);
  if (result.code !== 0) throw new Error(`${label} failed with exit code ${result.code}`);
  return result;
}

function assertBoundedGitResult(result: GitCommandResult, label: string): void {
  if (!result || !Number.isSafeInteger(result.code) || typeof result.stdout !== "string" || typeof result.stderr !== "string") {
    throw new Error(`${label} returned an invalid result`);
  }
  if (Buffer.byteLength(result.stdout, "utf8") > MAX_GIT_OUTPUT_BYTES || Buffer.byteLength(result.stderr, "utf8") > MAX_GIT_OUTPUT_BYTES) {
    throw new Error(`${label} output exceeded the bounded inspection limit`);
  }
}

function canonicalExistingDirectory(value: unknown, label: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be an absolute canonical directory`);
  }
  const absolute = resolve(value);
  assertNoSymlinkComponents(absolute);
  let canonical: string;
  try {
    canonical = realpathSync(absolute);
  } catch {
    throw new Error(`${label} does not exist`);
  }
  if (!statSync(canonical).isDirectory()) throw new Error(`${label} must be a directory`);
  return canonical;
}

function canonicalTargetPath(value: unknown, label: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be an absolute canonical path`);
  }
  const absolute = resolve(value);
  assertNoSymlinkComponents(absolute);
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

function assertNoSymlinkComponents(target: string): void {
  const absolute = resolve(target);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`BUILD worktree path must not contain symlinks: ${current}`);
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) return;
      throw error;
    }
  }
}

function assertStrictlyContained(root: string, target: string, message: string): void {
  const contained = relative(root, target);
  if (contained.length === 0 || contained.startsWith("..") || isAbsolute(contained)) throw new Error(message);
}

function normalizeDeclaredPaths(paths: readonly string[]): string[] {
  if (!Array.isArray(paths) || Object.getPrototypeOf(paths) !== Array.prototype) {
    throw new Error("Declared BUILD write set must be a plain array");
  }
  const descriptors = Object.getOwnPropertyDescriptors(paths);
  for (let index = 0; index < paths.length; index += 1) {
    if (!descriptors[String(index)] || !("value" in descriptors[String(index)]!)) {
      throw new Error("Declared BUILD write set must be a dense data-property array");
    }
  }
  const unexpected = Reflect.ownKeys(descriptors).filter((key) => typeof key !== "string" ||
    (key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= paths.length)));
  if (unexpected.length > 0) throw new Error("Declared BUILD write set contains unsupported array properties");
  return uniquePaths(paths.map((path) => requireBuildRepositoryPath(path, "declared BUILD write path")));
}

function uniquePaths(paths: readonly string[]): string[] {
  const byFoldedPath = new Map<string, string>();
  for (const path of paths) byFoldedPath.set(path.toLowerCase(), path);
  return [...byFoldedPath.values()].sort(comparePaths);
}

function pathContains(parent: string, child: string): boolean {
  const normalizedParent = parent.toLowerCase();
  const normalizedChild = child.toLowerCase();
  return normalizedParent === normalizedChild || normalizedChild.startsWith(`${normalizedParent}/`);
}

function comparePaths(left: string, right: string): number {
  return compareCodeUnits(left.toLowerCase(), right.toLowerCase()) || compareCodeUnits(left, right);
}

function requireToken(value: unknown, label: string): string {
  if (typeof value !== "string" || !TOKEN.test(value) || value.includes("..")) throw new Error(`${label} must be a bounded canonical token`);
  return value;
}

function requireBranch(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 255 || /[\u0000-\u0020\u007f~^:?*\[\\]/.test(value) ||
      value.includes("..") || value.includes("@{") || value.endsWith(".") || value.endsWith("/") || value.startsWith("/")) {
    throw new Error("BUILD worktree branch is invalid");
  }
  return value;
}

function requireSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA.test(value)) throw new Error(`${label} must be a full Git object SHA`);
  return value;
}

function requirePlanHash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("BUILD worktree plan hash must be a full SHA-256 digest");
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive integer`);
  return value as number;
}

function requireIsoTimestamp(value: unknown, label: string): string {
  assertIsoTimestamp(value, label);
  return value;
}

function assertIsoTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.values(Object.getOwnPropertyDescriptors(value));
  if ((prototype !== Object.prototype && prototype !== null) ||
      descriptors.some((descriptor) => !("value" in descriptor)) || Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error(`${label} must be a plain object containing data properties`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extras = Reflect.ownKeys(value).filter((key) => typeof key !== "string" || !allowed.includes(key));
  if (extras.length > 0) throw new Error(`${label} contains unsupported fields`);
}

function hashIdentity(value: Omit<WorktreeExecutionIntent, "intentId">): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
