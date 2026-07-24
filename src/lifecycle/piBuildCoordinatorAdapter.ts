import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { BuildNode, BuildOutputContract, CompiledBuildPlan } from "../core/buildPlan.js";
import { requireBuildRepositoryPath } from "../core/repositoryPath.js";
import type { ArtifactReference } from "../core/scheduler.js";
import {
  buildEffectIdentity,
  type BuildDispatchCheckpoint,
  type BuildRunningAction,
  type BuildWorkspaceIdentity,
} from "../core/buildExecution.js";
import type { GraphExecutionState } from "../core/scheduler.js";
import type { GraphCheckpointLease } from "../runtime/graphCheckpoint.js";
import {
  createBuildWorkerRequest,
  dispatchBuildWorker,
  reconcileBuildWorker,
  type BuildWorkerAdapter,
  type BuildWorkerReceipt,
} from "../runtime/buildWorker.js";
import type { RunPaths } from "./artifacts.js";
import {
  readBuildDispatchLedger,
  readVerifiedBuildEffectReceipt,
  writeBuildNodeArtifact,
} from "./buildArtifacts.js";
import type {
  BuildActionExecutionContext,
  BuildActionSettlement,
} from "./buildExecution.js";
import type {
  BuildCoordinatorAdapter,
  BuildWorkerBudgetEstimates,
} from "./buildCoordinator.js";
import {
  createOwnedBuildWorkspaceIdentity,
  createPlannedBuildWorkspaceIdentity,
  inspectOwnedBuildWorkspace,
  inspectSharedBuildWorkspace,
  materializeWorktree,
  prepareWorktreeIntent,
  reconcileWorktreeIntent,
  reconstructWorktreeIntent,
  type GitRunner,
  type WorktreeExecutionIntent,
  type WorktreeOwnershipRecord,
} from "./worktreeExecution.js";

export interface ReviewedCommandResult {
  code: number;
  stdout: string;
  stderr: string;
  killed?: boolean;
}

export interface PiBuildCoordinatorRuntimeOptions {
  compiled: Readonly<CompiledBuildPlan>;
  paths: RunPaths;
  owner: Readonly<GraphCheckpointLease>;
  repositoryRoot: string;
  candidateRoot: string;
  git: GitRunner;
  worker: Readonly<BuildWorkerAdapter>;
  now(): string;
  unattended: boolean;
  budgetForNode(nodeId: string): Readonly<Omit<BuildWorkerBudgetEstimates, "unattended">>;
  runReviewedCommand(
    command: string,
    options: Readonly<{ cwd: string; timeoutMs: number; signal?: AbortSignal }>,
  ): Promise<ReviewedCommandResult>;
  validateStructuredOutput?(input: Readonly<{
    validatorRef: string;
    value: unknown;
    nodeId: string;
    contractId: string;
  }>): boolean;
  validateReviewedCommands(input: Readonly<{
    validatorRef: string;
    commands: readonly string[];
    nodeId: string;
    contractId: string;
  }>): boolean;
  allowWorktreeCreation: boolean;
  trustRepositoryCheckout: boolean;
}

/** Production adapter beneath the durable coordinator. Models never write run
 * artifacts or settle checkpoints; this trusted adapter owns those boundaries. */
export function createPiBuildCoordinatorAdapter(
  options: Readonly<PiBuildCoordinatorRuntimeOptions>,
): Readonly<BuildCoordinatorAdapter> {
  const intentByOwner = new Map<string, Readonly<WorktreeExecutionIntent>>();
  const usageByNode = new Map<string, BuildWorkerReceipt["usage"]>();
  const success = (receipt: unknown): BuildActionSettlement => ({
    outcome: "succeeded",
    recordedAt: options.now(),
    receipt,
  });
  const failure = (): BuildActionSettlement => ({ outcome: "failed", recordedAt: options.now() });

  function workspaceForNode(
    nodeId: string,
    state: Readonly<GraphExecutionState>,
  ): Readonly<BuildWorkspaceIdentity> | undefined {
    const node = buildNode(options.compiled, nodeId);
    if (node.workspace === "shared") return Object.freeze({ kind: "shared" });
    const ownerNodeId = node.handler === "validate" ? node.targetWorktreeNodeId : node.id;
    if (!ownerNodeId) throw new Error(`BUILD node ${nodeId} is missing its target worktree owner`);
    const ledger = readBuildDispatchLedger(options.paths, state.planVersion, ownerNodeId);
    const worktree = ledger.checkpoints.find((checkpoint) => checkpoint.purpose === "worktree");
    if (worktree?.status === "succeeded") {
      const verified = readVerifiedBuildEffectReceipt(options.paths, worktree);
      return createOwnedBuildWorkspaceIdentity(
        verified.receipt as WorktreeOwnershipRecord,
        verified.sha256,
        options.git,
      );
    }
    if (worktree && worktree.workspace.kind !== "shared") {
      const intent = reconstructWorktreeIntent(
        { repositoryRoot: options.repositoryRoot, candidateRoot: options.candidateRoot },
        worktree.workspace,
        options.git,
      );
      intentByOwner.set(ownerNodeId, intent);
      return createPlannedBuildWorkspaceIdentity(intent);
    }
    if (node.handler === "validate") {
      throw new Error(`BUILD validator ${nodeId} cannot start before target ${ownerNodeId} owns a durable worktree`);
    }
    const intent = prepareWorktreeIntent({
      repositoryRoot: options.repositoryRoot,
      candidateRoot: options.candidateRoot,
      runId: state.runId,
      nodeId: ownerNodeId,
      planVersion: state.planVersion,
      planHash: options.compiled.hash,
    }, options.git);
    intentByOwner.set(ownerNodeId, intent);
    return createPlannedBuildWorkspaceIdentity(intent);
  }

  async function execute(
    action: Readonly<BuildRunningAction>,
    context?: Readonly<BuildActionExecutionContext>,
  ): Promise<BuildActionSettlement> {
    if (action.purpose === "worktree") {
      const intent = intentForAction(action);
      const record = materializeWorktree(intent, options.git, {
        allowCreate: options.allowWorktreeCreation,
        trustRepositoryCheckout: options.trustRepositoryCheckout,
      });
      return success(record);
    }
    if (action.purpose === "worker") {
      const settlement = await runWorker(action, context, false);
      if (!settlement) throw new Error("Fresh BUILD worker invocation cannot reconcile to an unknown result");
      return settlement;
    }
    if (action.purpose === "validator") return validateOutputs(action, context);
    throw new Error(`Production BUILD adapter does not automatically execute ${action.purpose}`);
  }

  async function reconcile(
    action: Readonly<BuildRunningAction>,
    context?: Readonly<BuildActionExecutionContext>,
  ): Promise<BuildActionSettlement | undefined> {
    if (action.purpose === "worktree") {
      const record = reconcileWorktreeIntent(intentForAction(action), options.git);
      return record === undefined ? undefined : success(record);
    }
    if (action.purpose === "worker") return runWorker(action, context, true);
    if (action.purpose === "validator") return validateOutputs(action, context);
    return undefined;
  }

  async function runWorker(
    action: Readonly<BuildRunningAction>,
    context: Readonly<BuildActionExecutionContext> | undefined,
    reconcile: boolean,
  ): Promise<BuildActionSettlement | undefined> {
    const state = requireGraphState(context);
    const reservation = context?.workerBudgetReservation;
    if (!reservation) throw new Error("BUILD worker execution is missing its durable outer budget reservation");
    const invocationAction: BuildRunningAction = action.kind === "reconcile-unknown"
      ? Object.freeze({ ...buildEffectIdentity({
          runId: action.runId,
          planVersion: action.planVersion,
          planHash: action.planHash,
          nodeId: action.nodeId,
          visit: action.visit,
          attempt: action.attempt,
          purpose: action.purpose,
          ordinal: action.ordinal,
          workspace: action.workspace,
        }), kind: "invoke-worker" })
      : action;
    const request = createBuildWorkerRequest(options.compiled, state, invocationAction, { reservation });
    const ledger = readBuildDispatchLedger(options.paths, action.planVersion, action.nodeId);
    const intent = ledger.checkpoints.find((checkpoint) => checkpoint.idempotencyKey === action.idempotencyKey);
    if (!intent) throw new Error("BUILD worker durable inner intent is missing");
    const node = buildNode(options.compiled, action.nodeId);
    const cwd = action.workspace.kind === "owned-worktree" ? action.workspace.worktreePath : options.repositoryRoot;
    const workspaceBeforeSha256 = node.handler === "implement"
      ? buildWorkspaceWriteFingerprint(cwd, node.writeSet, options.git)
      : undefined;
    const receipt = reconcile
      ? await reconcileBuildWorker(request, options.worker, { signal: context?.signal })
      : await dispatchBuildWorker(request, intent, options.worker, { signal: context?.signal });
    if (receipt === undefined) return undefined;
    usageByNode.set(action.nodeId, receipt.usage);
    return success({
      schemaVersion: 1,
      kind: "trusted-build-worker-dispatch",
      workerReceipt: receipt,
      ...(workspaceBeforeSha256 === undefined ? {} : { workspaceBeforeSha256 }),
    });
  }

  async function validateOutputs(
    action: Readonly<BuildRunningAction>,
    context: Readonly<BuildActionExecutionContext> | undefined,
  ): Promise<BuildActionSettlement> {
    const state = requireGraphState(context);
    const node = buildNode(options.compiled, action.nodeId);
    const cwd = action.workspace.kind === "owned-worktree" ? action.workspace.worktreePath : options.repositoryRoot;
    let workerDispatch: TrustedWorkerDispatchReceipt | undefined;
    if (node.handler !== "validate") workerDispatch = readWorkerReceipt(action);
    if (workerDispatch?.workerReceipt.outcome === "failed") return failure();
    const inputArtifacts = collectInputArtifacts(options.compiled, state, node);
    const approvedReviewedContracts = new Set<string>();
    for (const contract of node.outputContracts) {
      if (contract.validation !== "reviewed-command") continue;
      if (!contract.validatorRef || !options.validateReviewedCommands({
        validatorRef: contract.validatorRef,
        commands: node.verificationCommands,
        nodeId: node.id,
        contractId: contract.id,
      })) {
        throw new Error(`BUILD output ${node.id}/${contract.id} has an unrecognized reviewed-command validator`);
      }
      approvedReviewedContracts.add(contract.id);
    }
    const commandResults: ReviewedCommandEvidence[] = [];
    for (const command of node.verificationCommands) {
      const result = await options.runReviewedCommand(command, {
        cwd,
        timeoutMs: node.timeoutMs,
        ...(context?.signal === undefined ? {} : { signal: context.signal }),
      });
      commandResults.push(commandEvidence(command, result));
      if (result.code !== 0 || result.killed) return failure();
    }
    let workspaceInspection: unknown;
    let changedFiles: readonly Readonly<ChangedFileEvidence>[] = Object.freeze([]);
    if (node.handler === "implement") {
      workspaceInspection = action.workspace.kind === "owned-worktree"
        ? inspectOwnedBuildWorkspace(readOwnedRecord(action), node.writeSet, options.git)
        : inspectSharedBuildWorkspace(options.repositoryRoot, node.writeSet, options.git);
      const changedPaths = (workspaceInspection as { changedPaths: readonly string[] }).changedPaths;
      if (changedPaths.length === 0) throw new Error(`BUILD implement node ${node.id} produced no authoritative workspace edits`);
      const workspaceAfterSha256 = buildWorkspaceWriteFingerprint(cwd, node.writeSet, options.git);
      if (!workerDispatch?.workspaceBeforeSha256 || workerDispatch.workspaceBeforeSha256 === workspaceAfterSha256) {
        throw new Error(`BUILD implement node ${node.id} did not change its declared workspace state`);
      }
      changedFiles = inspectChangedFiles(cwd, changedPaths);
    }
    if (node.handler === "validate" && node.workspace === "isolated-worktree" && action.workspace.kind !== "owned-worktree") {
      throw new Error(`BUILD validator ${node.id} lost its target worktree authority`);
    }
    if (node.handler === "validate") {
      if (node.verificationCommands.length === 0 || commandResults.length !== node.verificationCommands.length) {
        throw new Error(`BUILD validator ${node.id} requires exact reviewed-command evidence`);
      }
      const targetWriteSet = validationTargetWriteSet(options.compiled, node);
      workspaceInspection = action.workspace.kind === "owned-worktree"
        ? inspectOwnedBuildWorkspace(readOwnedRecord(action), targetWriteSet, options.git)
        : inspectSharedBuildWorkspace(options.repositoryRoot, targetWriteSet, options.git);
      changedFiles = inspectChangedFiles(cwd, (workspaceInspection as { changedPaths: readonly string[] }).changedPaths);
    }
    const payloads = new Map((workerDispatch?.workerReceipt.outputPayloads ?? []).map((payload) => [payload.contractId, payload.content]));
    const artifacts = node.outputContracts.map((contract) => {
      const evidence = contractEvidence(contract, node, {
        payload: payloads.get(contract.id),
        changedFiles,
        commandResults,
        validateStructuredOutput: options.validateStructuredOutput,
        approvedReviewedContracts,
      });
      const payload = {
        schemaVersion: 1,
        runId: state.runId,
        planVersion: state.planVersion,
        planHash: options.compiled.hash,
        nodeId: node.id,
        attempt: action.attempt,
        contract,
        inputArtifacts,
        evidence,
        ...(workerDispatch === undefined ? {} : { worker: workerReceiptIdentity(workerDispatch.workerReceipt) }),
        ...(workspaceInspection === undefined ? {} : { workspaceInspection }),
        commandResults,
        validatedAt: options.now(),
      };
      return writeBuildNodeArtifact(options.paths, {
        planVersion: action.planVersion,
        nodeId: action.nodeId,
        attempt: action.attempt,
        contract: contract.id,
        bytes: `${stableJson(payload)}\n`,
      }, { owner: options.owner });
    });
    return success({ schemaVersion: 1, kind: "validated-build-outputs", artifactRefs: artifacts });
  }

  function readWorkerReceipt(action: Readonly<BuildRunningAction>): TrustedWorkerDispatchReceipt {
    const ledger = readBuildDispatchLedger(options.paths, action.planVersion, action.nodeId);
    const checkpoint = ledger.checkpoints.find((candidate) => candidate.purpose === "worker" &&
      candidate.visit === action.visit && candidate.attempt === action.attempt && candidate.status === "succeeded");
    if (!checkpoint) throw new Error("BUILD output validation is missing its exact worker receipt");
    const receipt = normalizeTrustedWorkerDispatchReceipt(
      readVerifiedBuildEffectReceipt(options.paths, checkpoint).receipt,
      options.compiled,
      action,
    );
    usageByNode.set(action.nodeId, receipt.workerReceipt.usage);
    return receipt;
  }

  function readLatestDurableWorkerReceipt(nodeId: string): TrustedWorkerDispatchReceipt | undefined {
    const ledger = readBuildDispatchLedger(options.paths, options.compiled.plan.planVersion, nodeId);
    const checkpoint = [...ledger.checkpoints].reverse().find((candidate) =>
      candidate.purpose === "worker" && candidate.status === "succeeded");
    if (!checkpoint) return undefined;
    const action = workerActionFromCheckpoint(checkpoint);
    const receipt = normalizeTrustedWorkerDispatchReceipt(
      readVerifiedBuildEffectReceipt(options.paths, checkpoint).receipt,
      options.compiled,
      action,
    );
    usageByNode.set(nodeId, receipt.workerReceipt.usage);
    return receipt;
  }

  function readOwnedRecord(action: Readonly<BuildRunningAction>): WorktreeOwnershipRecord {
    if (action.workspace.kind !== "owned-worktree") throw new Error("BUILD worktree inspection requires owned authority");
    const workspace = action.workspace;
    const ledger = readBuildDispatchLedger(options.paths, action.planVersion, workspace.ownerNodeId);
    const checkpoint = ledger.checkpoints.find((candidate) => candidate.purpose === "worktree" &&
      candidate.status === "succeeded" && candidate.resultRef === workspace.ownershipReceiptHash);
    if (!checkpoint) throw new Error("BUILD worktree inspection is missing its exact ownership receipt");
    return readVerifiedBuildEffectReceipt(options.paths, checkpoint).receipt as WorktreeOwnershipRecord;
  }

  function intentForAction(action: Readonly<BuildRunningAction>): Readonly<WorktreeExecutionIntent> {
    if (action.workspace.kind !== "planned-worktree") throw new Error("BUILD worktree action requires planned authority");
    const cached = intentByOwner.get(action.workspace.ownerNodeId);
    if (cached?.intentId === action.workspace.intentId) return cached;
    const reconstructed = reconstructWorktreeIntent(
      { repositoryRoot: options.repositoryRoot, candidateRoot: options.candidateRoot },
      action.workspace,
      options.git,
    );
    intentByOwner.set(action.workspace.ownerNodeId, reconstructed);
    return reconstructed;
  }

  return Object.freeze({
    workspaceForNode,
    workerBudgetEstimates(nodeId: string) {
      return Object.freeze({ unattended: options.unattended, ...options.budgetForNode(nodeId) });
    },
    execute,
    reconcile,
    workerUsage(nodeId: string) {
      const usage = usageByNode.get(nodeId) ?? readLatestDurableWorkerReceipt(nodeId)?.workerReceipt.usage;
      const estimate = options.budgetForNode(nodeId);
      return usage === undefined ? {} : {
        estimatedCostUsd: estimate.estimatedCostUsd,
        observedCostUsd: usage.observedUsd,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      };
    },
  });
}

function workerActionFromCheckpoint(checkpoint: Readonly<BuildDispatchCheckpoint>): BuildRunningAction {
  const identity = buildEffectIdentity({
    runId: checkpoint.runId,
    planVersion: checkpoint.planVersion,
    planHash: checkpoint.planHash,
    nodeId: checkpoint.nodeId,
    visit: checkpoint.visit,
    attempt: checkpoint.attempt,
    purpose: "worker",
    ordinal: checkpoint.ordinal,
    workspace: checkpoint.workspace,
  });
  if (checkpoint.purpose !== "worker" || identity.requestRef !== checkpoint.requestRef ||
      identity.idempotencyKey !== checkpoint.idempotencyKey) {
    throw new Error("BUILD durable worker checkpoint identity is invalid");
  }
  return Object.freeze({ ...identity, kind: "invoke-worker" });
}

function requireGraphState(context: Readonly<BuildActionExecutionContext> | undefined): Readonly<GraphExecutionState> {
  if (!context?.graphState) throw new Error("BUILD production action requires its exact coordinator graph state");
  return context.graphState;
}

function buildNode(compiled: Readonly<CompiledBuildPlan>, nodeId: string) {
  const node = compiled.plan.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`BUILD production adapter cannot find node ${nodeId}`);
  return node;
}

interface ReviewedCommandEvidence {
  command: string;
  commandSha256: string;
  exitCode: number;
  killed: boolean;
  stdoutSha256: string;
  stdoutBytes: number;
  stderrSha256: string;
  stderrBytes: number;
}

interface ChangedFileEvidence {
  path: string;
  status: "present" | "deleted";
  sha256?: string;
  sizeBytes?: number;
}

interface TrustedWorkerDispatchReceipt {
  workerReceipt: Readonly<BuildWorkerReceipt>;
  workspaceBeforeSha256?: string;
}

function commandEvidence(command: string, result: Readonly<ReviewedCommandResult>): ReviewedCommandEvidence {
  if (!Number.isSafeInteger(result.code) || typeof result.stdout !== "string" || typeof result.stderr !== "string" ||
      Buffer.byteLength(result.stdout, "utf8") > 4 * 1024 * 1024 ||
      Buffer.byteLength(result.stderr, "utf8") > 4 * 1024 * 1024) {
    throw new Error("BUILD reviewed command returned invalid or oversized evidence");
  }
  return Object.freeze({
    command,
    commandSha256: sha256(command),
    exitCode: result.code,
    killed: result.killed === true,
    stdoutSha256: sha256(result.stdout),
    stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
    stderrSha256: sha256(result.stderr),
    stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
  });
}

function collectInputArtifacts(
  compiled: Readonly<CompiledBuildPlan>,
  state: Readonly<GraphExecutionState>,
  node: Readonly<BuildNode>,
): readonly Readonly<ArtifactReference>[] {
  const incoming = compiled.plan.dependencies.filter(({ to }) => to === node.id);
  const artifacts = node.inputContracts.map((contract) => {
    const sourceIds = incoming.filter(({ contracts }) => contracts.includes(contract)).map(({ from }) => from);
    const matches = sourceIds.flatMap((sourceId) =>
      state.nodeStates[sourceId]?.outputRefs.filter((reference) => reference.contract === contract) ?? []);
    if (matches.length !== 1) throw new Error(`BUILD node ${node.id} input ${contract} lacks exact scheduler-backed provenance`);
    return Object.freeze({ ...matches[0]! });
  });
  return Object.freeze(artifacts.sort((left, right) => left.contract < right.contract ? -1 : left.contract > right.contract ? 1 : 0));
}

function validationTargetWriteSet(
  compiled: Readonly<CompiledBuildPlan>,
  node: Readonly<BuildNode>,
): readonly string[] {
  if (node.targetWorktreeNodeId) {
    const target = buildNode(compiled, node.targetWorktreeNodeId);
    if (target.handler !== "implement") throw new Error(`BUILD validator ${node.id} target is not an implement node`);
    return target.writeSet;
  }
  const sources = compiled.plan.dependencies.filter(({ to }) => to === node.id)
    .map(({ from }) => buildNode(compiled, from))
    .filter(({ handler }) => handler === "implement");
  return Object.freeze([...new Set(sources.flatMap(({ writeSet }) => writeSet))].sort());
}

function inspectChangedFiles(cwdValue: string, paths: readonly string[]): readonly Readonly<ChangedFileEvidence>[] {
  if (!isAbsolute(cwdValue)) throw new Error("BUILD workspace inspection root must be absolute");
  const cwd = resolve(cwdValue);
  if (paths.length > 4_096) throw new Error("BUILD workspace change set exceeds its evidence limit");
  const evidence = paths.map((path) => {
    const target = resolve(cwd, path);
    const contained = relative(cwd, target);
    if (!contained || contained === ".." || contained.startsWith(`..${sep}`) || isAbsolute(contained)) {
      throw new Error(`BUILD changed path escaped its workspace: ${path}`);
    }
    if (!existsSync(target)) return Object.freeze({ path, status: "deleted" as const });
    const metadata = lstatSync(target);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`BUILD changed path is not a regular file: ${path}`);
    if (metadata.size > 64 * 1024 * 1024) throw new Error(`BUILD changed file exceeds its evidence limit: ${path}`);
    const bytes = readFileSync(target);
    return Object.freeze({ path, status: "present" as const, sha256: sha256(bytes), sizeBytes: bytes.byteLength });
  });
  return Object.freeze(evidence.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

export function buildWorkspaceWriteFingerprint(cwd: string, writeSet: readonly string[], git: GitRunner): string {
  if (writeSet.length === 0) throw new Error("BUILD workspace fingerprint requires a declared write set");
  const pathspec = ["--", ...writeSet];
  const staged = runGitEvidence(git, cwd,
    ["-c", "core.fsmonitor=false", "diff", "--cached", "--name-only", "-z", ...pathspec],
    "pre/post-worker staged changes");
  if (staged.stdout.length > 0) throw new Error("BUILD worker workspace contains staged changes");
  const tracked = runGitEvidence(git, cwd,
    ["-c", "core.fsmonitor=false", "diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", ...pathspec],
    "pre/post-worker tracked diff");
  const untracked = parseGitPathList(runGitEvidence(git, cwd,
    ["-c", "core.fsmonitor=false", "ls-files", "--others", "--exclude-standard", "-z", ...pathspec],
    "pre/post-worker untracked files").stdout, "BUILD workspace untracked file");
  const ignored = parseGitPathList(runGitEvidence(git, cwd,
    ["-c", "core.fsmonitor=false", "ls-files", "--others", "--ignored", "--exclude-standard", "-z", ...pathspec],
    "pre/post-worker ignored files").stdout, "BUILD workspace ignored file");
  const extraFiles = inspectChangedFiles(cwd, [...new Set([...untracked, ...ignored])]);
  return sha256(stableJson({
    trackedDiffSha256: sha256(tracked.stdout),
    trackedDiffBytes: Buffer.byteLength(tracked.stdout, "utf8"),
    extraFiles,
  }));
}

function runGitEvidence(
  git: GitRunner,
  cwd: string,
  args: readonly string[],
  label: string,
): Readonly<{ stdout: string; stderr: string }> {
  const result = git.run(args, { cwd });
  if (!result || !Number.isSafeInteger(result.code) || typeof result.stdout !== "string" || typeof result.stderr !== "string" ||
      Buffer.byteLength(result.stdout, "utf8") > 4 * 1024 * 1024 ||
      Buffer.byteLength(result.stderr, "utf8") > 4 * 1024 * 1024) {
    throw new Error(`BUILD ${label} returned invalid or oversized Git evidence`);
  }
  if (result.code !== 0) throw new Error(`BUILD ${label} failed with exit code ${result.code}`);
  return Object.freeze({ stdout: result.stdout, stderr: result.stderr });
}

function parseGitPathList(value: string, label: string): string[] {
  if (value.length === 0) return [];
  if (!value.endsWith("\0")) throw new Error(`${label} list is not NUL terminated`);
  return value.slice(0, -1).split("\0").map((path, index) => requireBuildRepositoryPath(path, `${label} ${index}`));
}

function contractEvidence(
  contract: Readonly<BuildOutputContract>,
  node: Readonly<BuildNode>,
  input: Readonly<{
    payload: string | undefined;
    changedFiles: readonly Readonly<ChangedFileEvidence>[];
    commandResults: readonly Readonly<ReviewedCommandEvidence>[];
    validateStructuredOutput: PiBuildCoordinatorRuntimeOptions["validateStructuredOutput"];
    approvedReviewedContracts: ReadonlySet<string>;
  }>,
): unknown {
  if (contract.validation === "human-review") {
    throw new Error(`BUILD output ${node.id}/${contract.id} requires the explicit human integration path`);
  }
  if (contract.validation === "reviewed-command") {
    if (!contract.validatorRef || input.commandResults.length === 0 ||
        input.commandResults.some(({ exitCode, killed }) => exitCode !== 0 || killed) ||
        !input.approvedReviewedContracts.has(contract.id)) {
      throw new Error(`BUILD output ${node.id}/${contract.id} lacks passing reviewed-command evidence`);
    }
    return Object.freeze({
      kind: "reviewed-command",
      validatorRef: contract.validatorRef,
      commands: input.commandResults,
      evidenceSha256: sha256(stableJson(input.commandResults)),
    });
  }
  if (contract.kind === "file-set") {
    if (input.changedFiles.length === 0) throw new Error(`BUILD file-set output ${node.id}/${contract.id} is empty`);
    return Object.freeze({
      kind: "file-set",
      files: input.changedFiles,
      fileSetSha256: sha256(stableJson(input.changedFiles)),
    });
  }
  if (input.payload === undefined || input.payload.trim().length === 0) {
    throw new Error(`BUILD output ${node.id}/${contract.id} is missing non-empty worker content`);
  }
  if (contract.validation === "structured") {
    let value: unknown;
    try {
      value = JSON.parse(input.payload);
    } catch {
      throw new Error(`BUILD structured output ${node.id}/${contract.id} is not valid JSON`);
    }
    if (!contract.validatorRef || !input.validateStructuredOutput?.({
      validatorRef: contract.validatorRef,
      value,
      nodeId: node.id,
      contractId: contract.id,
    })) {
      throw new Error(`BUILD structured output ${node.id}/${contract.id} failed its closed validator`);
    }
    return Object.freeze({ kind: "structured", validatorRef: contract.validatorRef, value });
  }
  return Object.freeze({
    kind: contract.validation,
    content: input.payload,
    contentSha256: sha256(input.payload),
    sizeBytes: Buffer.byteLength(input.payload, "utf8"),
  });
}

function workerReceiptIdentity(receipt: Readonly<BuildWorkerReceipt>): unknown {
  return Object.freeze({
    requestRef: receipt.requestRef,
    worker: receipt.worker,
    usage: receipt.usage,
    completedAt: receipt.completedAt,
    summarySha256: sha256(receipt.summary),
  });
}

function normalizeTrustedWorkerDispatchReceipt(
  value: unknown,
  compiled: Readonly<CompiledBuildPlan>,
  action: Readonly<BuildRunningAction>,
): TrustedWorkerDispatchReceipt {
  const record = requirePlainRecord(value, "BUILD trusted worker dispatch receipt");
  const allowed = ["schemaVersion", "kind", "workerReceipt", "workspaceBeforeSha256"];
  if (Reflect.ownKeys(record).some((key) => typeof key !== "string" || !allowed.includes(key)) ||
      record.schemaVersion !== 1 || record.kind !== "trusted-build-worker-dispatch") {
    throw new Error("BUILD trusted worker dispatch receipt fields are invalid");
  }
  const node = buildNode(compiled, action.nodeId);
  if (node.handler === "implement") {
    if (typeof record.workspaceBeforeSha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.workspaceBeforeSha256)) {
      throw new Error("BUILD implement dispatch receipt lacks a trusted pre-worker workspace fingerprint");
    }
  } else if (record.workspaceBeforeSha256 !== undefined) {
    throw new Error("BUILD read-only dispatch receipt cannot claim a workspace mutation fingerprint");
  }
  return Object.freeze({
    workerReceipt: normalizeDurableWorkerReceipt(record.workerReceipt, compiled, action),
    ...(record.workspaceBeforeSha256 === undefined ? {} : { workspaceBeforeSha256: record.workspaceBeforeSha256 }),
  });
}

function normalizeDurableWorkerReceipt(
  value: unknown,
  compiled: Readonly<CompiledBuildPlan>,
  action: Readonly<BuildRunningAction>,
): BuildWorkerReceipt {
  const record = requirePlainRecord(value, "BUILD durable worker receipt");
  const allowed = [
    "schemaVersion", "requestRef", "outcome", "worker", "claimedOutputPaths", "outputPayloads", "summary", "usage", "completedAt",
  ];
  if (Reflect.ownKeys(record).some((key) => typeof key !== "string" || !allowed.includes(key)) ||
      record.schemaVersion !== 1 || (record.outcome !== "succeeded" && record.outcome !== "failed") ||
      typeof record.requestRef !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.requestRef) || typeof record.summary !== "string" ||
      Buffer.byteLength(record.summary, "utf8") > 64 * 1024 || typeof record.completedAt !== "string" ||
      !Number.isFinite(Date.parse(record.completedAt)) || new Date(record.completedAt).toISOString() !== record.completedAt) {
    throw new Error("BUILD durable worker receipt identity or outcome is invalid");
  }
  const node = buildNode(compiled, action.nodeId);
  const expectedPaths = node.outputContracts.map(({ id }) =>
    `nodes/${action.planVersion}/${action.nodeId}/attempt-${action.attempt}/${id}.json`).sort();
  const paths = requireStringArray(record.claimedOutputPaths, "BUILD durable worker claimed paths").sort();
  if (record.outcome === "succeeded" ? !sameStrings(paths, expectedPaths) : paths.length > 0) {
    throw new Error("BUILD durable worker claimed paths do not match its outcome and immutable contracts");
  }
  const payloadValues = requirePlainArray(record.outputPayloads, "BUILD durable worker output payloads");
  const outputPayloads = payloadValues.map((candidate, index) => {
    const payload = requirePlainRecord(candidate, `BUILD durable worker output payload ${index}`);
    if (Reflect.ownKeys(payload).some((key) => typeof key !== "string" || !["contractId", "content"].includes(key)) ||
        typeof payload.contractId !== "string" || typeof payload.content !== "string" ||
        Buffer.byteLength(payload.content, "utf8") > 1024 * 1024) {
      throw new Error(`BUILD durable worker output payload ${index} is invalid`);
    }
    return Object.freeze({ contractId: payload.contractId, content: payload.content });
  });
  const expectedPayloadIds = node.outputContracts.filter(({ kind }) => kind !== "file-set").map(({ id }) => id).sort();
  const payloadIds = outputPayloads.map(({ contractId }) => contractId).sort();
  if (new Set(payloadIds).size !== payloadIds.length ||
      (record.outcome === "succeeded" ? !sameStrings(payloadIds, expectedPayloadIds) : payloadIds.length > 0)) {
    throw new Error("BUILD durable worker payloads do not match its outcome and immutable contracts");
  }
  const worker = requirePlainRecord(record.worker, "BUILD durable worker identity");
  const usage = requirePlainRecord(record.usage, "BUILD durable worker usage");
  if (typeof worker.provider !== "string" || typeof worker.model !== "string" ||
      (worker.family !== undefined && typeof worker.family !== "string")) {
    throw new Error("BUILD durable worker identity is invalid");
  }
  for (const key of ["inputTokens", "outputTokens", "observedUsd"] as const) {
    const amount = usage[key];
    if (amount !== "unknown" && (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 ||
        (key !== "observedUsd" && !Number.isSafeInteger(amount)))) {
      throw new Error(`BUILD durable worker usage ${key} is invalid`);
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    requestRef: record.requestRef,
    outcome: record.outcome,
    worker: Object.freeze({ provider: worker.provider, model: worker.model, ...(worker.family ? { family: worker.family } : {}) }),
    claimedOutputPaths: Object.freeze(paths),
    outputPayloads: Object.freeze(outputPayloads),
    summary: record.summary,
    usage: Object.freeze({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, observedUsd: usage.observedUsd }),
    completedAt: record.completedAt,
  } as BuildWorkerReceipt);
}

function requirePlainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some((descriptor) => !("value" in descriptor))) {
    throw new Error(`${label} must be a plain data-property object`);
  }
  return value as Record<string, unknown>;
}

function requirePlainArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 64) {
    throw new Error(`${label} must be a bounded plain array`);
  }
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  return requirePlainArray(value, label).map((item) => {
    if (typeof item !== "string") throw new Error(`${label} must contain strings`);
    return item;
  });
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("BUILD canonical JSON cannot encode undefined values");
  return encoded;
}
