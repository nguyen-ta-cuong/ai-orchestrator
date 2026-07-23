import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CompiledBuildPlan } from "../core/buildPlan.js";
import {
  assertHumanIntegrationDecision,
  createBuildHumanIntegrationAction,
  createBuildHumanIntegrationResultEvent,
  type BuildHumanIntegrationCandidateEvidence,
  type BuildHumanIntegrationDecision,
  type BuildHumanIntegrationReceipt,
} from "../core/buildExecution.js";
import type { ArtifactReference, GraphExecutionState } from "../core/scheduler.js";
import type { RunPaths } from "./artifacts.js";
import {
  readBuildDispatchLedger,
  readVerifiedBuildEffectReceipt,
  sealBuildDispatchLedger,
  writeBuildNodeArtifact,
} from "./buildArtifacts.js";
import { checkpointBuildGraphEvent } from "./buildGraphExecution.js";
import { executeDurableBuildAction } from "./buildExecution.js";
import {
  createOwnedBuildWorkspaceIdentity,
  inspectOwnedWorktreeChanges,
  type GitRunner,
  type WorktreeOwnershipRecord,
} from "./worktreeExecution.js";

export interface BuildHumanIntegrationCandidateReview {
  nodeId: string;
  worktreePath: string;
  changedPaths: readonly string[];
  validationArtifactSha256: readonly string[];
}

export interface BuildHumanIntegrationReview {
  nodeId: string;
  mainWorkspaceHeadBefore: string;
  candidates: readonly Readonly<BuildHumanIntegrationCandidateReview>[];
  capturedAt: string;
}

export interface CompleteBuildHumanIntegrationInput {
  decision: "integrated" | "declined";
  selectedCandidateNodeIds: readonly string[];
  confirmedByUser: true;
}

export interface CompleteBuildHumanIntegrationResult {
  decision: Readonly<BuildHumanIntegrationDecision>;
  state: Readonly<GraphExecutionState>;
}

interface CandidateSnapshot extends BuildHumanIntegrationCandidateReview, BuildHumanIntegrationCandidateEvidence {
  evidenceSha256: string;
}

interface HumanWaitSnapshot {
  schemaVersion: 1;
  runId: string;
  planVersion: number;
  planHash: string;
  nodeId: string;
  mainWorkspaceHeadBefore: string;
  mainWorkspaceStatusBeforeSha256: string;
  candidates: readonly Readonly<CandidateSnapshot>[];
  capturedAt: string;
}

interface MainWorkspaceInspection {
  head: string;
  statusSha256: string;
  conflictSha256: string;
  hasConflicts: boolean;
  clean: boolean;
}

interface PersistedDecision {
  schemaVersion: 1;
  decision: Readonly<BuildHumanIntegrationDecision>;
  confirmationRef: string;
  candidateEvidence: readonly Readonly<BuildHumanIntegrationCandidateEvidence>[];
  mainWorkspaceInspection: Readonly<BuildHumanIntegrationReceipt["mainWorkspaceInspection"]>;
}

const SNAPSHOT_CONTRACT = "orchestrator-human-wait-snapshot";
const DECISION_CONTRACT = "orchestrator-human-integration-decision";
const MAX_GATE_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_CHANGED_FILE_BYTES = 64 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

/** Capture the exact main/candidate evidence shown at the human gate. Re-entry
 * reads the immutable snapshot instead of silently refreshing what was shown. */
export function prepareBuildHumanIntegrationReview(
  paths: RunPaths,
  compiled: Readonly<CompiledBuildPlan>,
  state: Readonly<GraphExecutionState>,
  options: Readonly<{
    owner: string;
    repositoryRoot: string;
    git: GitRunner;
    now(): string;
  }>,
): Readonly<BuildHumanIntegrationReview> {
  const nodeId = waitingIntegrationNode(compiled, state);
  const action = createBuildHumanIntegrationAction(compiled, state, nodeId);
  const existing = readGateArtifact(paths, state.planVersion, nodeId, action.attempt, SNAPSHOT_CONTRACT);
  const snapshot = existing === undefined
    ? captureSnapshot(paths, compiled, state, nodeId, action.attempt, options)
    : normalizeSnapshot(existing, compiled, state, nodeId);
  const currentCandidates = inspectCandidates(paths, compiled, state, options.git);
  const currentHashes = new Map(currentCandidates.map((candidate) => [candidate.nodeId, candidate.evidenceSha256]));
  for (const candidate of snapshot.candidates) {
    if (currentHashes.get(candidate.nodeId) !== candidate.evidenceSha256) {
      throw new Error(`BUILD candidate ${candidate.nodeId} changed after the human integration gate was captured`);
    }
  }
  return Object.freeze({
    nodeId,
    mainWorkspaceHeadBefore: snapshot.mainWorkspaceHeadBefore,
    candidates: Object.freeze(snapshot.candidates.map(({ evidenceSha256: _evidenceSha256, ...candidate }) =>
      Object.freeze({ ...candidate, changedPaths: Object.freeze([...candidate.changedPaths]), validationArtifactSha256: Object.freeze([...candidate.validationArtifactSha256]) }))),
    capturedAt: snapshot.capturedAt,
  });
}

/** Record an already-performed manual integration (or explicit decline). This
 * function only inspects Git and checkpoints evidence; it never changes Git. */
export async function completeBuildHumanIntegration(
  paths: RunPaths,
  compiled: Readonly<CompiledBuildPlan>,
  state: Readonly<GraphExecutionState>,
  input: Readonly<CompleteBuildHumanIntegrationInput>,
  options: Readonly<{
    owner: string;
    repositoryRoot: string;
    git: GitRunner;
    now(): string;
  }>,
): Promise<Readonly<CompleteBuildHumanIntegrationResult>> {
  if (input.confirmedByUser !== true) throw new Error("BUILD human integration decision requires explicit user confirmation");
  const nodeId = waitingIntegrationNode(compiled, state);
  const action = createBuildHumanIntegrationAction(compiled, state, nodeId);
  const snapshotValue = readGateArtifact(paths, state.planVersion, nodeId, action.attempt, SNAPSHOT_CONTRACT);
  if (snapshotValue === undefined) throw new Error("BUILD human integration cannot complete without its captured review snapshot");
  const snapshot = normalizeSnapshot(snapshotValue, compiled, state, nodeId);
  const candidates = inspectCandidates(paths, compiled, state, options.git);
  assertCandidateSnapshotUnchanged(snapshot.candidates, candidates);

  const selectedCandidateNodeIds = [...input.selectedCandidateNodeIds].sort(compare);
  if (new Set(selectedCandidateNodeIds).size !== selectedCandidateNodeIds.length ||
      selectedCandidateNodeIds.some((candidate) => !candidates.some(({ nodeId }) => nodeId === candidate))) {
    throw new Error("BUILD human integration selected an unknown or duplicate candidate");
  }
  const main = inspectMainWorkspace(options.repositoryRoot, options.git);
  if (main.hasConflicts) throw new Error("BUILD main workspace contains unresolved conflicts");
  if (input.decision === "integrated" && !main.clean) {
    throw new Error("BUILD manual integration must be committed with a clean main workspace before confirmation");
  }
  if (input.decision === "declined" &&
      (main.head !== snapshot.mainWorkspaceHeadBefore || main.statusSha256 !== snapshot.mainWorkspaceStatusBeforeSha256)) {
    throw new Error("BUILD declined integration must preserve the captured main workspace exactly");
  }

  const existingDecisionValue = readGateArtifact(paths, state.planVersion, nodeId, action.attempt, DECISION_CONTRACT);
  const persisted = existingDecisionValue === undefined
    ? persistDecision(paths, compiled, state, nodeId, action.attempt, input, snapshot, candidates, main, options)
    : normalizePersistedDecision(existingDecisionValue, compiled, state, nodeId);
  if (persisted.decision.decision !== input.decision ||
      stableJson(persisted.decision.selectedCandidateNodeIds) !== stableJson(selectedCandidateNodeIds) ||
      persisted.decision.mainWorkspaceHeadAfter !== main.head ||
      persisted.mainWorkspaceInspection.headBefore !== snapshot.mainWorkspaceHeadBefore ||
      persisted.mainWorkspaceInspection.statusBeforeSha256 !== snapshot.mainWorkspaceStatusBeforeSha256 ||
      persisted.mainWorkspaceInspection.statusAfterSha256 !== main.statusSha256 ||
      persisted.mainWorkspaceInspection.conflictCheckSha256 !== main.conflictSha256) {
    throw new Error("BUILD human integration changed after its confirmed durable decision");
  }
  const currentCandidateEvidence = candidates.map((candidate) => ({
    nodeId: candidate.nodeId,
    ownershipReceiptHash: candidate.ownershipReceiptHash,
    candidateHead: candidate.candidateHead,
    diffSha256: candidate.diffSha256,
    validationArtifactSha256: [...candidate.validationArtifactSha256],
  }));
  if (stableJson(persisted.candidateEvidence) !== stableJson(currentCandidateEvidence)) {
    throw new Error("BUILD persisted human decision does not match current candidate evidence");
  }

  let artifactRef: Readonly<ArtifactReference> | undefined;
  if (persisted.decision.decision === "integrated") {
    const integrationNode = compiled.plan.nodes.find(({ id }) => id === nodeId)!;
    if (integrationNode.outputContracts.length !== 1) {
      throw new Error("BUILD human integration requires exactly one immutable output contract");
    }
    const contract = integrationNode.outputContracts[0]!;
    const bytes = `${stableJson({
      schemaVersion: 1,
      decision: persisted.decision,
      confirmationRef: persisted.confirmationRef,
      candidateEvidence: persisted.candidateEvidence,
      mainWorkspaceInspection: persisted.mainWorkspaceInspection,
    })}\n`;
    artifactRef = writeBuildNodeArtifact(paths, {
      planVersion: state.planVersion,
      nodeId,
      attempt: action.attempt,
      contract: contract.id,
      bytes,
    }, { owner: options.owner });
  }

  const receipt: Readonly<BuildHumanIntegrationReceipt> = Object.freeze({
    schemaVersion: 1,
    kind: "trusted-human-integration",
    decisionRef: sha256(stableJson(persisted.decision)),
    confirmationRef: persisted.confirmationRef,
    inspectedBy: "trusted-runtime-git",
    candidateEvidence: persisted.candidateEvidence,
    mainWorkspaceInspection: persisted.mainWorkspaceInspection,
    ...(artifactRef === undefined ? {} : { artifactRef }),
    recordedAt: persisted.decision.recordedAt,
  });
  const settlement = { outcome: "succeeded" as const, recordedAt: persisted.decision.recordedAt, receipt };
  const durable = await executeDurableBuildAction(paths, action, {
    execute: async () => settlement,
    reconcile: async () => settlement,
  }, {
    owner: options.owner,
    recordedAt: persisted.decision.recordedAt,
    context: { graphState: state },
  });
  if (persisted.decision.decision === "integrated") {
    const seal = sealBuildDispatchLedger(paths, {
      runId: state.runId,
      planVersion: state.planVersion,
      planHash: compiled.hash,
      nodeId,
      visit: action.visit,
      attempt: action.attempt,
      expectedHead: durable.ledgerHead,
    }, { owner: options.owner });
    if (artifactRef === undefined || seal.outputArtifacts.length !== 1 ||
        stableJson(seal.outputArtifacts[0]) !== stableJson(artifactRef)) {
      throw new Error("BUILD human integration seal does not bind its exact output evidence");
    }
  }
  const event = createBuildHumanIntegrationResultEvent(
    compiled,
    state,
    persisted.decision,
    artifactRef,
    receipt,
    durable.checkpoint,
    `build-human-result-${state.lastAppliedEventSequence + 1}`,
  );
  const next = checkpointBuildGraphEvent(paths, compiled, state, event, {
    owner: options.owner,
    tempId: `human-result-${state.lastAppliedEventSequence + 1}`,
  });
  return Object.freeze({ decision: persisted.decision, state: next });
}

function captureSnapshot(
  paths: RunPaths,
  compiled: Readonly<CompiledBuildPlan>,
  state: Readonly<GraphExecutionState>,
  nodeId: string,
  attempt: number,
  options: Readonly<{ owner: string; repositoryRoot: string; git: GitRunner; now(): string }>,
): HumanWaitSnapshot {
  const main = inspectMainWorkspace(options.repositoryRoot, options.git);
  const candidates = inspectCandidates(paths, compiled, state, options.git);
  const snapshot: HumanWaitSnapshot = Object.freeze({
    schemaVersion: 1,
    runId: state.runId,
    planVersion: state.planVersion,
    planHash: compiled.hash,
    nodeId,
    mainWorkspaceHeadBefore: main.head,
    mainWorkspaceStatusBeforeSha256: main.statusSha256,
    candidates,
    capturedAt: options.now(),
  });
  writeBuildNodeArtifact(paths, {
    planVersion: state.planVersion,
    nodeId,
    attempt,
    contract: SNAPSHOT_CONTRACT,
    bytes: `${stableJson(snapshot)}\n`,
  }, { owner: options.owner });
  return snapshot;
}

function persistDecision(
  paths: RunPaths,
  compiled: Readonly<CompiledBuildPlan>,
  state: Readonly<GraphExecutionState>,
  nodeId: string,
  attempt: number,
  input: Readonly<CompleteBuildHumanIntegrationInput>,
  snapshot: Readonly<HumanWaitSnapshot>,
  candidates: readonly Readonly<CandidateSnapshot>[],
  main: Readonly<MainWorkspaceInspection>,
  options: Readonly<{ owner: string; now(): string }>,
): PersistedDecision {
  const recordedAt = options.now();
  const selectedCandidateNodeIds = [...input.selectedCandidateNodeIds].sort(compare);
  const decision: Readonly<BuildHumanIntegrationDecision> = Object.freeze({
    schemaVersion: 1,
    runId: state.runId,
    planVersion: state.planVersion,
    planHash: compiled.hash,
    nodeId,
    decision: input.decision,
    selectedCandidateNodeIds: Object.freeze(selectedCandidateNodeIds) as unknown as string[],
    mainWorkspaceHeadBefore: snapshot.mainWorkspaceHeadBefore,
    mainWorkspaceHeadAfter: main.head,
    mainWorkspaceIntegrated: input.decision === "integrated",
    confirmedByUser: true,
    recordedAt,
  });
  const candidateEvidence: readonly Readonly<BuildHumanIntegrationCandidateEvidence>[] = Object.freeze(candidates.map((candidate) =>
    Object.freeze({
      nodeId: candidate.nodeId,
      ownershipReceiptHash: candidate.ownershipReceiptHash,
      candidateHead: candidate.candidateHead,
      diffSha256: candidate.diffSha256,
      validationArtifactSha256: Object.freeze([...candidate.validationArtifactSha256]),
    })));
  const mainWorkspaceInspection = Object.freeze({
    headBefore: snapshot.mainWorkspaceHeadBefore,
    headAfter: main.head,
    statusBeforeSha256: snapshot.mainWorkspaceStatusBeforeSha256,
    statusAfterSha256: main.statusSha256,
    conflictCheckSha256: main.conflictSha256,
  });
  const decisionRef = sha256(stableJson(decision));
  const persisted: PersistedDecision = Object.freeze({
    schemaVersion: 1,
    decision,
    confirmationRef: sha256(stableJson({
      schemaVersion: 1,
      decisionRef,
      confirmation: "explicit-user-confirmation",
    })),
    candidateEvidence,
    mainWorkspaceInspection,
  });
  writeBuildNodeArtifact(paths, {
    planVersion: state.planVersion,
    nodeId,
    attempt,
    contract: DECISION_CONTRACT,
    bytes: `${stableJson(persisted)}\n`,
  }, { owner: options.owner });
  return persisted;
}

function inspectCandidates(
  paths: RunPaths,
  compiled: Readonly<CompiledBuildPlan>,
  state: Readonly<GraphExecutionState>,
  git: GitRunner,
): readonly Readonly<CandidateSnapshot>[] {
  const candidates = compiled.plan.nodes
    .filter((node) => node.handler === "implement" && node.workspace === "isolated-worktree")
    .sort((left, right) => compare(left.id, right.id))
    .map((node) => {
      const nodeState = state.nodeStates[node.id];
      if (nodeState?.status !== "executed") throw new Error(`BUILD candidate ${node.id} is not durably executed`);
      const ledger = readBuildDispatchLedger(paths, state.planVersion, node.id);
      const worktrees = ledger.checkpoints.filter((checkpoint) => checkpoint.purpose === "worktree" &&
        checkpoint.status === "succeeded" && checkpoint.visit === nodeState.visits && checkpoint.attempt === nodeState.attempts);
      if (worktrees.length !== 1) throw new Error(`BUILD candidate ${node.id} lacks one exact ownership receipt`);
      const ownershipReceipt = readVerifiedBuildEffectReceipt(paths, worktrees[0]!);
      const owned = createOwnedBuildWorkspaceIdentity(
        ownershipReceipt.receipt as WorktreeOwnershipRecord,
        ownershipReceipt.sha256,
        git,
      );
      if (owned.kind !== "owned-worktree") throw new Error(`BUILD candidate ${node.id} did not resolve to owned authority`);
      const changes = inspectOwnedWorktreeChanges(ownershipReceipt.receipt as WorktreeOwnershipRecord, node.writeSet, git);
      if (changes.changedPaths.length === 0) throw new Error(`BUILD candidate ${node.id} has no changes to integrate`);
      const candidateHead = readGitSha(git, owned.worktreePath, ["rev-parse", "HEAD"], `candidate ${node.id} HEAD`);
      const diffSha256 = sha256(stableJson(inspectChangedFiles(owned.worktreePath, changes.changedPaths)));
      const validationArtifactSha256 = compiled.plan.nodes
        .filter((candidate) => candidate.handler === "validate" && candidate.targetWorktreeNodeId === node.id)
        .flatMap((validator) => {
          const validatorState = state.nodeStates[validator.id];
          if (validatorState?.status !== "executed" || validatorState.outputRefs.length === 0) {
            throw new Error(`BUILD candidate ${node.id} lacks completed validator ${validator.id}`);
          }
          return validatorState.outputRefs.map(({ sha256 }) => sha256);
        })
        .sort(compare);
      if (validationArtifactSha256.length === 0 || new Set(validationArtifactSha256).size !== validationArtifactSha256.length) {
        throw new Error(`BUILD candidate ${node.id} has invalid validation provenance`);
      }
      const evidence = {
        nodeId: node.id,
        ownershipReceiptHash: ownershipReceipt.sha256,
        candidateHead,
        diffSha256,
        validationArtifactSha256: Object.freeze(validationArtifactSha256),
      };
      const reviewEvidence = {
        ...evidence,
        worktreePath: owned.worktreePath,
        changedPaths: Object.freeze([...changes.changedPaths]),
      };
      return Object.freeze({
        ...reviewEvidence,
        evidenceSha256: sha256(stableJson(reviewEvidence)),
      });
    });
  if (candidates.length === 0) throw new Error("BUILD human integration has no isolated candidates");
  return Object.freeze(candidates);
}

function inspectChangedFiles(rootValue: string, paths: readonly string[]): readonly unknown[] {
  if (!isAbsolute(rootValue)) throw new Error("BUILD candidate root must be absolute");
  const root = resolve(rootValue);
  const values = paths.map((path) => {
    const target = resolve(root, path);
    const contained = relative(root, target);
    if (!contained || contained === ".." || contained.startsWith(`..${sep}`) || isAbsolute(contained)) {
      throw new Error(`BUILD candidate path escaped its worktree: ${path}`);
    }
    if (!existsSync(target)) return Object.freeze({ path, status: "deleted" });
    const metadata = lstatSync(target);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`BUILD candidate path is not a regular file: ${path}`);
    if (metadata.size > MAX_CHANGED_FILE_BYTES) throw new Error(`BUILD candidate file is too large to inspect: ${path}`);
    const bytes = readFileSync(target);
    return Object.freeze({ path, status: "present", sha256: sha256(bytes), sizeBytes: bytes.byteLength });
  });
  return Object.freeze(values.sort((left, right) => compare((left as { path: string }).path, (right as { path: string }).path)));
}

function inspectMainWorkspace(repositoryRoot: string, git: GitRunner): MainWorkspaceInspection {
  const head = readGitSha(git, repositoryRoot, ["rev-parse", "HEAD"], "main workspace HEAD");
  const status = runGit(git, repositoryRoot,
    ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    "main workspace status");
  const conflicts = runGit(git, repositoryRoot,
    ["-c", "core.fsmonitor=false", "ls-files", "-u", "-z"],
    "main workspace conflict inspection");
  return Object.freeze({
    head,
    statusSha256: sha256(status),
    conflictSha256: sha256(conflicts),
    hasConflicts: conflicts.length > 0,
    clean: status.length === 0,
  });
}

function assertCandidateSnapshotUnchanged(
  expected: readonly Readonly<CandidateSnapshot>[],
  actual: readonly Readonly<CandidateSnapshot>[],
): void {
  const expectedHashes = expected.map(({ nodeId, evidenceSha256 }) => `${nodeId}:${evidenceSha256}`);
  const actualHashes = actual.map(({ nodeId, evidenceSha256 }) => `${nodeId}:${evidenceSha256}`);
  if (stableJson(expectedHashes) !== stableJson(actualHashes)) {
    throw new Error("BUILD candidate evidence changed after human review; capture a new plan/version instead of trusting stale evidence");
  }
}

function normalizeSnapshot(
  value: unknown,
  compiled: Readonly<CompiledBuildPlan>,
  state: Readonly<GraphExecutionState>,
  nodeId: string,
): HumanWaitSnapshot {
  const record = requireRecord(value, "BUILD human-wait snapshot");
  assertOnlyKeys(record, [
    "schemaVersion", "runId", "planVersion", "planHash", "nodeId", "mainWorkspaceHeadBefore",
    "mainWorkspaceStatusBeforeSha256", "candidates", "capturedAt",
  ], "BUILD human-wait snapshot");
  if (record.schemaVersion !== 1 || record.runId !== state.runId || record.planVersion !== state.planVersion ||
      record.planHash !== compiled.hash || record.nodeId !== nodeId || typeof record.mainWorkspaceHeadBefore !== "string" ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.mainWorkspaceHeadBefore) ||
      typeof record.mainWorkspaceStatusBeforeSha256 !== "string" || !SHA256.test(record.mainWorkspaceStatusBeforeSha256) ||
      typeof record.capturedAt !== "string" || new Date(record.capturedAt).toISOString() !== record.capturedAt ||
      !Array.isArray(record.candidates)) {
    throw new Error("BUILD human-wait snapshot identity is invalid");
  }
  const candidates = record.candidates.map((value, index) => normalizeCandidateSnapshot(value, `BUILD snapshot candidate ${index}`));
  const expectedIds = compiled.plan.nodes.filter((node) => node.handler === "implement" && node.workspace === "isolated-worktree")
    .map(({ id }) => id).sort(compare);
  if (stableJson(candidates.map(({ nodeId: id }) => id)) !== stableJson(expectedIds)) {
    throw new Error("BUILD human-wait snapshot candidates do not match the immutable plan");
  }
  return Object.freeze({
    schemaVersion: 1,
    runId: record.runId as string,
    planVersion: record.planVersion as number,
    planHash: record.planHash as string,
    nodeId,
    mainWorkspaceHeadBefore: record.mainWorkspaceHeadBefore,
    mainWorkspaceStatusBeforeSha256: record.mainWorkspaceStatusBeforeSha256,
    candidates: Object.freeze(candidates),
    capturedAt: record.capturedAt,
  });
}

function normalizeCandidateSnapshot(value: unknown, label: string): CandidateSnapshot {
  const record = requireRecord(value, label);
  assertOnlyKeys(record, [
    "nodeId", "ownershipReceiptHash", "candidateHead", "diffSha256", "validationArtifactSha256",
    "worktreePath", "changedPaths", "evidenceSha256",
  ], label);
  if (typeof record.nodeId !== "string" || typeof record.ownershipReceiptHash !== "string" || !SHA256.test(record.ownershipReceiptHash) ||
      typeof record.candidateHead !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.candidateHead) ||
      typeof record.diffSha256 !== "string" || !SHA256.test(record.diffSha256) ||
      typeof record.worktreePath !== "string" || !isAbsolute(record.worktreePath) ||
      typeof record.evidenceSha256 !== "string" || !SHA256.test(record.evidenceSha256) ||
      !Array.isArray(record.validationArtifactSha256) || !Array.isArray(record.changedPaths) ||
      record.validationArtifactSha256.some((hash) => typeof hash !== "string" || !SHA256.test(hash)) ||
      record.changedPaths.some((path) => typeof path !== "string")) {
    throw new Error(`${label} identity is invalid`);
  }
  const evidence = {
    nodeId: record.nodeId,
    ownershipReceiptHash: record.ownershipReceiptHash,
    candidateHead: record.candidateHead,
    diffSha256: record.diffSha256,
    validationArtifactSha256: [...record.validationArtifactSha256].sort(compare),
  };
  const reviewEvidence = {
    ...evidence,
    worktreePath: record.worktreePath,
    changedPaths: [...(record.changedPaths as string[])],
  };
  if (record.evidenceSha256 !== sha256(stableJson(reviewEvidence))) throw new Error(`${label} evidence hash is invalid`);
  return Object.freeze({
    ...evidence,
    validationArtifactSha256: Object.freeze(evidence.validationArtifactSha256),
    worktreePath: record.worktreePath,
    changedPaths: Object.freeze([...(record.changedPaths as string[])]),
    evidenceSha256: record.evidenceSha256,
  });
}

function normalizePersistedDecision(
  value: unknown,
  compiled: Readonly<CompiledBuildPlan>,
  state: Readonly<GraphExecutionState>,
  nodeId: string,
): PersistedDecision {
  const record = requireRecord(value, "BUILD persisted human decision");
  assertOnlyKeys(record, ["schemaVersion", "decision", "confirmationRef", "candidateEvidence", "mainWorkspaceInspection"], "BUILD persisted human decision");
  if (record.schemaVersion !== 1 || typeof record.confirmationRef !== "string" || !SHA256.test(record.confirmationRef) ||
      !Array.isArray(record.candidateEvidence)) throw new Error("BUILD persisted human decision identity is invalid");
  const decision = assertHumanIntegrationDecision(compiled, state, record.decision);
  if (decision.nodeId !== nodeId) throw new Error("BUILD persisted human decision does not match the active graph");
  const expectedConfirmation = sha256(stableJson({
    schemaVersion: 1,
    decisionRef: sha256(stableJson(decision)),
    confirmation: "explicit-user-confirmation",
  }));
  if (record.confirmationRef !== expectedConfirmation) throw new Error("BUILD persisted human confirmation hash is invalid");
  return Object.freeze({
    schemaVersion: 1,
    decision: Object.freeze(decision),
    confirmationRef: record.confirmationRef,
    candidateEvidence: Object.freeze(record.candidateEvidence as BuildHumanIntegrationCandidateEvidence[]),
    mainWorkspaceInspection: Object.freeze(record.mainWorkspaceInspection as BuildHumanIntegrationReceipt["mainWorkspaceInspection"]),
  });
}

function readGateArtifact(
  paths: RunPaths,
  planVersion: number,
  nodeId: string,
  attempt: number,
  contract: string,
): unknown | undefined {
  const path = join(paths.root, "nodes", String(planVersion), nodeId, `attempt-${attempt}`, `${contract}.json`);
  if (!existsSync(path)) return undefined;
  assertNoSymlinkComponents(paths.root, path);
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_GATE_ARTIFACT_BYTES) {
    throw new Error(`BUILD ${contract} artifact is not a bounded regular file`);
  }
  const bytes = readFileSync(path, "utf8");
  if (!bytes.endsWith("\n")) throw new Error(`BUILD ${contract} artifact is partial or corrupt`);
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new Error(`BUILD ${contract} artifact contains corrupt JSON`);
  }
  if (`${stableJson(value)}\n` !== bytes) throw new Error(`BUILD ${contract} artifact is not canonical`);
  return value;
}

function assertNoSymlinkComponents(rootValue: string, pathValue: string): void {
  const root = resolve(rootValue);
  const target = resolve(pathValue);
  const contained = relative(root, target);
  if (!contained || contained === ".." || contained.startsWith(`..${sep}`) || isAbsolute(contained)) {
    throw new Error("BUILD human-gate artifact escaped its run root");
  }
  let current = root;
  for (const part of contained.split(sep)) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error("BUILD human-gate artifact path contains a symbolic link");
    }
  }
}

function waitingIntegrationNode(compiled: Readonly<CompiledBuildPlan>, state: Readonly<GraphExecutionState>): string {
  if (state.planVersion !== compiled.plan.planVersion) throw new Error("BUILD human integration plan version is stale");
  const nodes = compiled.plan.nodes.filter((node) => node.handler === "integrate" && state.nodeStates[node.id]?.status === "waiting_human");
  if (nodes.length !== 1) throw new Error("BUILD requires exactly one waiting human integration node");
  return nodes[0]!.id;
}

function readGitSha(git: GitRunner, cwd: string, args: readonly string[], label: string): string {
  const output = runGit(git, cwd, args, label).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(output)) throw new Error(`BUILD ${label} is not a Git object id`);
  return output;
}

function runGit(git: GitRunner, cwd: string, args: readonly string[], label: string): string {
  const result = git.run(args, { cwd });
  if (!result || !Number.isSafeInteger(result.code) || typeof result.stdout !== "string" || typeof result.stderr !== "string" ||
      Buffer.byteLength(result.stdout) > 4 * 1024 * 1024 || Buffer.byteLength(result.stderr) > 4 * 1024 * 1024) {
    throw new Error(`BUILD ${label} returned an invalid or oversized Git result`);
  }
  if (result.code !== 0) throw new Error(`BUILD ${label} failed with exit code ${result.code}`);
  return result.stdout;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some((descriptor) => !("value" in descriptor)) ||
      Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error(`${label} must be a plain data object`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowed.includes(key))) {
    throw new Error(`${label} contains unsupported fields`);
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compare(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("BUILD human integration evidence is not JSON data");
  return encoded;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
