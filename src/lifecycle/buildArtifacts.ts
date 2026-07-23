import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  compileBuildPlan,
  renderBuildPlanMarkdown,
  type CompiledBuildPlan,
} from "../core/buildPlan.js";
import {
  assertBuildDispatchCheckpoint,
  serializeBuildEffectReceipt,
  type BuildDispatchCheckpoint,
  type BuildEffectIdentity,
  type BuildEffectPurpose,
  type BuildWorkspaceIdentity,
} from "../core/buildExecution.js";
import type { ArtifactReference } from "../core/scheduler.js";
import {
  assertRunPathsSafe,
  ownsRunLease,
  type RunPaths,
} from "./artifacts.js";

export interface ImmutableBuildPlanReference {
  planVersion: number;
  planHash: string;
  graphPath: string;
  markdownPath: string;
  manifestPath: string;
}

export interface BuildDispatchLedgerRead {
  head: string | null;
  eventCount: number;
  checkpoints: readonly Readonly<BuildDispatchCheckpoint>[];
}

export interface BuildEffectReceiptReference {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface BuildDispatchSealReference extends ArtifactReference {
  outputArtifacts: readonly Readonly<ArtifactReference>[];
}

export interface BuildValidatedOutputsReceipt {
  schemaVersion: 1;
  kind: "validated-build-outputs";
  artifactRefs: readonly Readonly<ArtifactReference>[];
}

export interface BuildArtifactMutationOptions {
  owner: string;
  failAt?(point: "after-reservation" | "after-graph" | "after-markdown"): void;
}

export interface BuildLedgerAppendOptions extends BuildArtifactMutationOptions {
  expectedHead: string | null;
}

interface BuildDispatchLedgerEntry {
  schemaVersion: 1;
  sequence: number;
  priorHash: string | null;
  checkpoint: BuildDispatchCheckpoint;
  entryHash: string;
}

const SHA256 = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const MAX_PLAN_BYTES = 512 * 1024;
const MAX_MARKDOWN_BYTES = 512 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_LEDGER_EVENT_BYTES = 64 * 1024;
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;
const MAX_LEDGER_EVENTS = 4_096;
const MAX_RECEIPT_BYTES = 4 * 1024 * 1024;

export function buildPlanVersionForSubmission(paths: RunPaths): number {
  assertRunPathsSafe(paths);
  const versions = reservedBuildPlanVersions(paths);
  if (versions.length === 0) return 1;
  const latest = versions.at(-1)!;
  if (!existsSync(buildPlanManifestPath(paths, latest))) return latest;
  readImmutableBuildPlan(paths, latest);
  return latest + 1;
}

export function latestBuildPlanVersion(paths: RunPaths): number | undefined {
  const versions = reservedBuildPlanVersions(paths);
  if (versions.length === 0) return undefined;
  const latest = versions.at(-1)!;
  if (!existsSync(buildPlanManifestPath(paths, latest))) {
    throw new Error(`Latest BUILD plan version ${latest} is incomplete; recover its durable reservation before continuing`);
  }
  readImmutableBuildPlan(paths, latest);
  return latest;
}

export function recoverIncompleteBuildPlan(
  paths: RunPaths,
  options: BuildArtifactMutationOptions,
): ImmutableBuildPlanReference | undefined {
  assertMutationAuthority(paths, options.owner);
  const versions = reservedBuildPlanVersions(paths);
  if (versions.length === 0) return undefined;
  const latest = versions.at(-1)!;
  if (existsSync(buildPlanManifestPath(paths, latest))) return undefined;
  const reserved = readBuildPlanReservation(paths, latest);
  return writeBuildPlanDerivedArtifacts(paths, reserved.compiled, reserved.markdown, reserved.reservationSha256, options);
}

export function writeImmutableBuildPlan(
  paths: RunPaths,
  compiled: Readonly<CompiledBuildPlan>,
  options: BuildArtifactMutationOptions,
): ImmutableBuildPlanReference {
  assertMutationAuthority(paths, options.owner);
  const reservedVersions = reservedBuildPlanVersions(paths);
  if (!reservedVersions.includes(compiled.plan.planVersion) &&
      compiled.plan.planVersion !== buildPlanVersionForSubmission(paths)) {
    throw new Error(`BUILD plan version ${compiled.plan.planVersion} is not the next durable submission version`);
  }
  const graphBytes = `${compiled.canonicalJson}\n`;
  const markdownBytes = renderBuildPlanMarkdown(compiled);
  if (Buffer.byteLength(graphBytes) > MAX_PLAN_BYTES || Buffer.byteLength(markdownBytes) > MAX_MARKDOWN_BYTES) {
    throw new Error("Immutable BUILD plan artifacts exceed their size limits");
  }
  const reservation = {
    schemaVersion: 1,
    planVersion: compiled.plan.planVersion,
    planHash: compiled.hash,
    canonicalJson: compiled.canonicalJson,
    markdown: markdownBytes,
  };
  const reservationBytes = `${stableJson(reservation)}\n`;
  const reservationPath = buildPlanReservationPath(paths, compiled.plan.planVersion);
  if (Buffer.byteLength(reservationBytes) > MAX_PLAN_BYTES + MAX_MARKDOWN_BYTES + MAX_MANIFEST_BYTES) {
    throw new Error("BUILD plan reservation exceeds its size limit");
  }
  assertMutationAuthority(paths, options.owner);
  writeImmutableExact(
    paths.root,
    reservationPath,
    reservationBytes,
    MAX_PLAN_BYTES + MAX_MARKDOWN_BYTES + MAX_MANIFEST_BYTES,
    "BUILD plan reservation",
  );
  options.failAt?.("after-reservation");
  return writeBuildPlanDerivedArtifacts(paths, compiled, markdownBytes, sha256(reservationBytes), options);
}

export function readImmutableBuildPlan(paths: RunPaths, planVersion: number): CompiledBuildPlan {
  assertRunPathsSafe(paths);
  assertPositiveInteger(planVersion, "BUILD plan version");
  const versionRoot = buildPlanVersionRoot(paths, planVersion);
  const graphPath = join(versionRoot, "plan.graph.json");
  const markdownPath = join(versionRoot, "plan.md");
  const manifestPath = join(versionRoot, "manifest.json");
  const reservation = readBuildPlanReservation(paths, planVersion);
  const graphBytes = readBounded(paths.root, graphPath, MAX_PLAN_BYTES, "BUILD plan graph");
  const markdownBytes = readBounded(paths.root, markdownPath, MAX_MARKDOWN_BYTES, "BUILD plan Markdown");
  const manifestBytes = readBounded(paths.root, manifestPath, MAX_MANIFEST_BYTES, "BUILD plan manifest");
  if (!graphBytes.endsWith("\n") || !markdownBytes.endsWith("\n") || !manifestBytes.endsWith("\n")) {
    throw new Error("Immutable BUILD plan artifacts are partial");
  }
  let value: unknown;
  let manifestValue: unknown;
  try {
    value = JSON.parse(graphBytes);
    manifestValue = JSON.parse(manifestBytes);
  } catch {
    throw new Error("Immutable BUILD plan artifacts contain corrupt JSON");
  }
  const compiled = compileBuildPlan(value);
  if (`${compiled.canonicalJson}\n` !== graphBytes || renderBuildPlanMarkdown(compiled) !== markdownBytes) {
    throw new Error("Immutable BUILD plan artifacts are not canonical");
  }
  const manifest = requireRecord(manifestValue, "BUILD plan manifest");
  assertOnlyKeys(manifest, ["schemaVersion", "planVersion", "planHash", "reservationSha256", "graphSha256", "markdownSha256"], "BUILD plan manifest");
  if (manifest.schemaVersion !== 1 || manifest.planVersion !== planVersion || manifest.planHash !== compiled.hash ||
      manifest.reservationSha256 !== reservation.reservationSha256 ||
      manifest.graphSha256 !== sha256(graphBytes) || manifest.markdownSha256 !== sha256(markdownBytes) ||
      `${stableJson(manifest)}\n` !== manifestBytes || reservation.compiled.hash !== compiled.hash ||
      reservation.markdown !== markdownBytes) {
    throw new Error("Immutable BUILD plan manifest identity is invalid");
  }
  return compiled;
}

export function writeBuildEffectReceipt(
  paths: RunPaths,
  effectValue: Readonly<BuildEffectIdentity>,
  receiptValue: unknown,
  options: BuildArtifactMutationOptions,
): BuildEffectReceiptReference {
  assertMutationAuthority(paths, options.owner);
  const effect = normalizeEffectIdentity(effectValue);
  assertJsonData(receiptValue, "BUILD effect receipt", 0);
  const bytes = serializeBuildEffectReceipt(effect, receiptValue);
  if (Buffer.byteLength(bytes) > MAX_RECEIPT_BYTES) throw new Error("BUILD effect receipt exceeds its size limit");
  const directory = buildNodeDirectory(paths, effect.planVersion, effect.nodeId);
  mkdirContained(paths.root, join(directory, "receipts"));
  const relativePath = `nodes/${effect.planVersion}/${effect.nodeId}/receipts/${effect.purpose}-${effect.ordinal}-${effect.idempotencyKey}.json`;
  const path = join(paths.root, ...relativePath.split("/"));
  writeImmutableExact(paths.root, path, bytes, MAX_RECEIPT_BYTES, "BUILD effect receipt");
  return Object.freeze({ path: relativePath, sha256: sha256(bytes), sizeBytes: Buffer.byteLength(bytes) });
}

/** Read and verify the immutable receipt selected by a terminal ledger checkpoint. */
export function readVerifiedBuildEffectReceipt(
  paths: RunPaths,
  checkpoint: Readonly<BuildDispatchCheckpoint>,
): Readonly<{ receipt: unknown; sha256: string }> {
  return Object.freeze(readBuildEffectReceipt(paths, checkpoint));
}

/** Write one coordinator-owned node artifact under the immutable attempt namespace. */
export function writeBuildNodeArtifact(
  paths: RunPaths,
  input: Readonly<{
    planVersion: number;
    nodeId: string;
    attempt: number;
    contract: string;
    bytes: string;
  }>,
  options: BuildArtifactMutationOptions,
): ArtifactReference {
  assertMutationAuthority(paths, options.owner);
  assertPositiveInteger(input.planVersion, "BUILD node artifact plan version");
  assertPositiveInteger(input.attempt, "BUILD node artifact attempt");
  assertToken(input.nodeId, "BUILD node artifact node id");
  assertToken(input.contract, "BUILD node artifact contract");
  const sizeBytes = Buffer.byteLength(input.bytes, "utf8");
  if (sizeBytes > 64 * 1024 * 1024) throw new Error("BUILD node artifact exceeds its size limit");
  const relativePath = `nodes/${input.planVersion}/${input.nodeId}/attempt-${input.attempt}/${input.contract}.json`;
  const path = join(paths.root, ...relativePath.split("/"));
  mkdirContained(paths.root, dirname(path));
  writeImmutableExact(paths.root, path, input.bytes, 64 * 1024 * 1024, "BUILD node artifact");
  return Object.freeze({
    planVersion: input.planVersion,
    nodeId: input.nodeId,
    contract: input.contract,
    path: relativePath,
    sha256: sha256(input.bytes),
    sizeBytes,
  });
}

export function appendBuildDispatchCheckpoint(
  paths: RunPaths,
  checkpointValue: unknown,
  options: BuildLedgerAppendOptions,
): BuildDispatchLedgerRead {
  assertMutationAuthority(paths, options.owner);
  if (options.expectedHead !== null && !SHA256.test(options.expectedHead)) throw new Error("BUILD ledger expected head is invalid");
  const checkpoint = assertBuildDispatchCheckpoint(checkpointValue);
  const ledgerPath = buildLedgerPath(paths, checkpoint.planVersion, checkpoint.nodeId);
  const current = readBuildDispatchLedger(paths, checkpoint.planVersion, checkpoint.nodeId);
  const entries = readLedgerEntries(paths, ledgerPath);
  const exact = entries.find((entry) => stableJson(entry.checkpoint) === stableJson(checkpoint));
  if (exact) return current;
  const sameEffect = entries.filter((entry) => entry.checkpoint.idempotencyKey === checkpoint.idempotencyKey);
  const settled = sameEffect.find((entry) =>
    entry.checkpoint.status === "succeeded" || entry.checkpoint.status === "failed");
  if (settled) throw new Error(`BUILD dispatch effect ${checkpoint.idempotencyKey} is already settled with conflicting evidence`);
  if (current.head !== options.expectedHead) {
    throw new Error(`BUILD dispatch ledger head conflict: expected ${String(options.expectedHead)}, found ${String(current.head)}`);
  }
  if (checkpoint.status === "intent-recorded") {
    if (sameEffect.length > 0) throw new Error("BUILD dispatch effect intent conflicts with an existing intent");
    const unresolved = entries.at(-1)?.checkpoint;
    if (unresolved?.status === "intent-recorded" || unresolved?.status === "unknown") {
      throw new Error("BUILD dispatch ledger cannot start a new effect while another intent is unresolved");
    }
  } else {
    if (sameEffect.length === 0 || sameEffect[0]!.checkpoint.status !== "intent-recorded" ||
        sameEffect.some((entry) => entry.checkpoint.status !== "intent-recorded" && entry.checkpoint.status !== "unknown")) {
      throw new Error("BUILD dispatch result requires exactly one durable matching intent");
    }
    if (checkpoint.status === "unknown" && sameEffect.some((entry) => entry.checkpoint.status === "unknown")) {
      throw new Error("BUILD dispatch effect already has an unknown reconciliation checkpoint");
    }
  }
  if (entries.length >= MAX_LEDGER_EVENTS) throw new Error("BUILD dispatch ledger event limit exceeded");
  const withoutHash = {
    schemaVersion: 1 as const,
    sequence: entries.length + 1,
    priorHash: current.head,
    checkpoint,
  };
  const entry: BuildDispatchLedgerEntry = { ...withoutHash, entryHash: sha256(stableJson(withoutHash)) };
  const line = `${stableJson(entry)}\n`;
  if (Buffer.byteLength(line) > MAX_LEDGER_EVENT_BYTES) throw new Error("BUILD dispatch ledger event exceeds its size limit");
  const directory = dirname(ledgerPath);
  mkdirContained(paths.root, directory);
  assertMutationAuthority(paths, options.owner);
  const existingSize = existsSync(ledgerPath)
    ? Buffer.byteLength(readBounded(paths.root, ledgerPath, MAX_LEDGER_BYTES, "BUILD dispatch ledger"))
    : 0;
  if (existingSize + Buffer.byteLength(line) > MAX_LEDGER_BYTES) throw new Error("BUILD dispatch ledger byte limit exceeded");
  appendAndSync(paths.root, ledgerPath, line);
  return readBuildDispatchLedger(paths, checkpoint.planVersion, checkpoint.nodeId);
}

export function readBuildDispatchLedger(
  paths: RunPaths,
  planVersion: number,
  nodeId: string,
): BuildDispatchLedgerRead {
  assertRunPathsSafe(paths);
  assertPositiveInteger(planVersion, "BUILD dispatch plan version");
  assertToken(nodeId, "BUILD dispatch node id");
  const entries = readLedgerEntries(paths, buildLedgerPath(paths, planVersion, nodeId));
  const latest = new Map<string, BuildDispatchCheckpoint>();
  for (const entry of entries) latest.set(entry.checkpoint.idempotencyKey, entry.checkpoint);
  const checkpoints = [...latest.values()].sort((left, right) => left.ordinal - right.ordinal || compare(left.idempotencyKey, right.idempotencyKey));
  return Object.freeze({
    head: entries.at(-1)?.entryHash ?? null,
    eventCount: entries.length,
    checkpoints: Object.freeze(checkpoints),
  });
}

export function sealBuildDispatchLedger(
  paths: RunPaths,
  input: Readonly<{
    runId: string;
    planVersion: number;
    planHash: string;
    nodeId: string;
    visit: number;
    attempt: number;
    expectedHead: string;
  }>,
  options: BuildArtifactMutationOptions,
): BuildDispatchSealReference {
  assertMutationAuthority(paths, options.owner);
  assertToken(input.runId, "BUILD dispatch seal run id");
  assertPositiveInteger(input.planVersion, "BUILD dispatch seal plan version");
  assertPositiveInteger(input.visit, "BUILD dispatch seal visit");
  assertPositiveInteger(input.attempt, "BUILD dispatch seal attempt");
  assertToken(input.nodeId, "BUILD dispatch seal node id");
  if (!SHA256.test(input.planHash) || !SHA256.test(input.expectedHead)) throw new Error("BUILD dispatch seal identity is invalid");
  const compiled = readImmutableBuildPlan(paths, input.planVersion);
  if (compiled.hash !== input.planHash) throw new Error("BUILD dispatch seal plan hash does not match the immutable plan");
  const node = compiled.plan.nodes.find(({ id }) => id === input.nodeId);
  if (!node) throw new Error("BUILD dispatch seal node is absent from the immutable plan");
  if (input.attempt > node.retryLimit + 1) throw new Error("BUILD dispatch seal attempt exceeds the immutable retry budget");
  const ledger = readBuildDispatchLedger(paths, input.planVersion, input.nodeId);
  if (ledger.head !== input.expectedHead || ledger.eventCount === 0) throw new Error("BUILD dispatch seal head does not match the durable ledger");
  if (ledger.checkpoints.some((checkpoint) => checkpoint.runId !== input.runId || checkpoint.planHash !== input.planHash)) {
    throw new Error("BUILD dispatch ledger contains evidence from another run or plan");
  }
  if (ledger.checkpoints.some((checkpoint) =>
    (checkpoint.visit !== input.visit || checkpoint.attempt !== input.attempt) &&
    (checkpoint.status === "intent-recorded" || checkpoint.status === "unknown"))) {
    throw new Error("BUILD dispatch ledger contains unresolved evidence from a superseded attempt");
  }
  const active = ledger.checkpoints.filter((checkpoint) =>
    checkpoint.visit === input.visit && checkpoint.attempt === input.attempt);
  const expectedPurposes = requiredEffectPurposes(node.handler, node.workspace);
  if (active.length !== expectedPurposes.length ||
      !sameStrings(active.map(({ purpose }) => purpose), expectedPurposes) ||
      active.some(({ status }) => status !== "succeeded")) {
    throw new Error("BUILD dispatch ledger does not contain the exact succeeded effect set for the active attempt");
  }
  const receipts = new Map(active.map((checkpoint) => [
    checkpoint.purpose,
    readBuildEffectReceipt(paths, checkpoint),
  ]));
  validateBuildWorkspaceReceipts(paths, compiled, node, active, receipts);
  const completionReceipt = receipts.get(node.handler === "integrate" ? "human-integration" : "validator");
  if (!completionReceipt) throw new Error("BUILD dispatch ledger is missing its completion-validation receipt");
  const artifactRefs = node.handler === "integrate"
    ? validateBuildIntegrationReceipt(paths, completionReceipt.receipt, input.planVersion, input.nodeId, node.outputContracts)
    : validateBuildValidationReceipt(paths, completionReceipt.receipt, input.planVersion, input.nodeId, node.outputContracts);
  const seal = {
    schemaVersion: 1,
    runId: input.runId,
    planVersion: input.planVersion,
    planHash: input.planHash,
    nodeId: input.nodeId,
    visit: input.visit,
    attempt: input.attempt,
    ledgerHead: ledger.head,
    eventCount: ledger.eventCount,
    effectReceiptSha256: Object.fromEntries(
      [...receipts.entries()].map(([purpose, receipt]) => [purpose, receipt.sha256]),
    ),
    outputArtifacts: artifactRefs,
  };
  const bytes = `${stableJson(seal)}\n`;
  const relativePath = `nodes/${input.planVersion}/${input.nodeId}/build-dispatch-seal.json`;
  const path = join(paths.root, ...relativePath.split("/"));
  writeImmutableExact(paths.root, path, bytes, MAX_MANIFEST_BYTES, "BUILD dispatch seal");
  return Object.freeze({
    planVersion: input.planVersion,
    nodeId: input.nodeId,
    contract: "build-dispatch-ledger",
    path: relativePath,
    sha256: sha256(bytes),
    sizeBytes: Buffer.byteLength(bytes),
    outputArtifacts: artifactRefs,
  });
}

function validateBuildWorkspaceReceipts(
  paths: RunPaths,
  compiled: Readonly<CompiledBuildPlan>,
  node: Readonly<CompiledBuildPlan["plan"]["nodes"][number]>,
  active: readonly Readonly<BuildDispatchCheckpoint>[],
  receipts: ReadonlyMap<BuildEffectPurpose, Readonly<{ receipt: unknown; sha256: string }>>,
): void {
  if (node.workspace === "shared") {
    if (active.some(({ workspace }) => workspace.kind !== "shared")) {
      throw new Error("BUILD shared node seal contains isolated workspace authority");
    }
    return;
  }
  const expectedOwnerNodeId = node.handler === "validate" ? node.targetWorktreeNodeId : node.id;
  if (!expectedOwnerNodeId) throw new Error("BUILD isolated node seal is missing its target worktree owner");
  const ownedCheckpoints = active.filter(({ purpose }) => purpose !== "worktree");
  const owned = ownedCheckpoints[0]?.workspace;
  if (!owned || owned.kind !== "owned-worktree" ||
      ownedCheckpoints.some(({ workspace }) => stableJson(workspace) !== stableJson(owned)) ||
      owned.runId !== active[0]?.runId || owned.planVersion !== compiled.plan.planVersion ||
      owned.planHash !== compiled.hash || owned.ownerNodeId !== expectedOwnerNodeId) {
    throw new Error("BUILD isolated node effects do not share exact owned-worktree authority");
  }

  let worktreeCheckpoint: Readonly<BuildDispatchCheckpoint> | undefined;
  let worktreeReceipt: Readonly<{ receipt: unknown; sha256: string }> | undefined;
  if (node.handler === "implement") {
    worktreeCheckpoint = active.find(({ purpose }) => purpose === "worktree");
    worktreeReceipt = receipts.get("worktree");
  } else {
    const targetLedger = readBuildDispatchLedger(paths, compiled.plan.planVersion, expectedOwnerNodeId);
    worktreeCheckpoint = targetLedger.checkpoints.find((checkpoint) =>
      checkpoint.purpose === "worktree" && checkpoint.status === "succeeded" &&
      checkpoint.resultRef === owned.ownershipReceiptHash);
    if (worktreeCheckpoint) worktreeReceipt = readBuildEffectReceipt(paths, worktreeCheckpoint);
  }
  if (!worktreeCheckpoint || worktreeCheckpoint.status !== "succeeded" || !worktreeReceipt ||
      worktreeCheckpoint.resultRef !== owned.ownershipReceiptHash ||
      worktreeReceipt.sha256 !== owned.ownershipReceiptHash || worktreeCheckpoint.workspace.kind !== "planned-worktree") {
    throw new Error("BUILD owned-worktree authority is not backed by its exact durable worktree receipt");
  }
  validateWorktreeOwnershipReceipt(worktreeReceipt.receipt, worktreeCheckpoint.workspace, owned);
}

function validateWorktreeOwnershipReceipt(
  value: unknown,
  planned: Extract<BuildWorkspaceIdentity, { kind: "planned-worktree" }>,
  owned: Extract<BuildWorkspaceIdentity, { kind: "owned-worktree" }>,
): void {
  const record = requireRecord(value, "BUILD worktree ownership receipt");
  assertOnlyKeys(record, [
    "schemaVersion", "intentId", "repositoryRoot", "commonDir", "candidateRoot", "worktreePath", "baseSha", "branch",
    "runId", "nodeId", "planVersion", "planHash", "reconciled", "cleanupStatus",
  ], "BUILD worktree ownership receipt");
  const paths = [record.repositoryRoot, record.commonDir, record.candidateRoot, record.worktreePath];
  if (record.schemaVersion !== 1 || typeof record.intentId !== "string" || !SHA256.test(record.intentId) ||
      typeof record.runId !== "string" || typeof record.nodeId !== "string" ||
      !Number.isSafeInteger(record.planVersion) || (record.planVersion as number) <= 0 ||
      typeof record.planHash !== "string" || !SHA256.test(record.planHash) ||
      typeof record.baseSha !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.baseSha) ||
      typeof record.branch !== "string" || typeof record.reconciled !== "boolean" || record.cleanupStatus !== "active" ||
      paths.some((path) => typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path ||
        Buffer.byteLength(path, "utf8") > 4_096 || /[\u0000-\u001f\u007f]/.test(path))) {
    throw new Error("BUILD worktree ownership receipt identity is invalid");
  }
  const repositoryRoot = record.repositoryRoot as string;
  const candidateRoot = record.candidateRoot as string;
  const worktreePath = record.worktreePath as string;
  const candidateRelative = relative(repositoryRoot, candidateRoot);
  const worktreeRelative = relative(candidateRoot, worktreePath);
  if (!candidateRelative || candidateRelative.startsWith("..") || isAbsolute(candidateRelative) ||
      !worktreeRelative || worktreeRelative.startsWith("..") || isAbsolute(worktreeRelative) ||
      worktreePath !== resolve(candidateRoot, `${record.runId}-v${record.planVersion}-${record.nodeId}`) ||
      record.branch !== `codex/build/${record.runId}/v${record.planVersion}/${record.nodeId}`) {
    throw new Error("BUILD worktree ownership receipt path or branch authority is invalid");
  }
  const intentIdentity = {
    schemaVersion: 1,
    repositoryRoot,
    commonDir: record.commonDir,
    candidateRoot,
    worktreePath,
    baseSha: record.baseSha,
    branch: record.branch,
    runId: record.runId,
    nodeId: record.nodeId,
    planVersion: record.planVersion,
    planHash: record.planHash,
  };
  if (record.intentId !== sha256(stableJson(intentIdentity)) ||
      !sameWorktreeAuthority(record, planned) || !sameWorktreeAuthority(record, owned)) {
    throw new Error("BUILD worktree ownership receipt does not match its effect workspace authority");
  }
}

function sameWorktreeAuthority(
  record: Readonly<Record<string, unknown>>,
  workspace: Exclude<BuildWorkspaceIdentity, { kind: "shared" }>,
): boolean {
  return record.intentId === workspace.intentId && record.runId === workspace.runId &&
    record.planVersion === workspace.planVersion && record.planHash === workspace.planHash &&
    record.nodeId === workspace.ownerNodeId && record.baseSha === workspace.baseSha &&
    record.worktreePath === workspace.worktreePath;
}

function requiredEffectPurposes(
  handler: "inspect" | "design" | "implement" | "validate" | "integrate",
  workspace: "shared" | "isolated-worktree",
): BuildEffectPurpose[] {
  if (handler === "integrate") return ["human-integration"];
  if (handler === "validate") return ["validator"];
  return [
    ...(handler === "implement" && workspace === "isolated-worktree" ? ["worktree" as const] : []),
    "worker",
    "validator",
  ];
}

function readBuildEffectReceipt(
  paths: RunPaths,
  checkpoint: Readonly<BuildDispatchCheckpoint>,
): { receipt: unknown; sha256: string } {
  if (checkpoint.status !== "succeeded" || checkpoint.resultRef === undefined) {
    throw new Error("BUILD effect receipt requires a succeeded checkpoint");
  }
  const relativePath = `nodes/${checkpoint.planVersion}/${checkpoint.nodeId}/receipts/${checkpoint.purpose}-${checkpoint.ordinal}-${checkpoint.idempotencyKey}.json`;
  const path = join(paths.root, ...relativePath.split("/"));
  const bytes = readBounded(paths.root, path, MAX_RECEIPT_BYTES, "BUILD effect receipt");
  if (!bytes.endsWith("\n") || sha256(bytes) !== checkpoint.resultRef) {
    throw new Error("BUILD effect receipt bytes do not match the durable checkpoint");
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new Error("BUILD effect receipt contains corrupt JSON");
  }
  const envelope = requireRecord(value, "BUILD effect receipt");
  assertOnlyKeys(envelope, ["schemaVersion", "requestRef", "idempotencyKey", "purpose", "ordinal", "receipt"], "BUILD effect receipt");
  if (envelope.schemaVersion !== 1 || envelope.requestRef !== checkpoint.requestRef ||
      envelope.idempotencyKey !== checkpoint.idempotencyKey || envelope.purpose !== checkpoint.purpose ||
      envelope.ordinal !== checkpoint.ordinal || `${stableJson(envelope)}\n` !== bytes) {
    throw new Error("BUILD effect receipt identity or canonical bytes are invalid");
  }
  return { receipt: envelope.receipt, sha256: checkpoint.resultRef };
}

function validateBuildValidationReceipt(
  paths: RunPaths,
  value: unknown,
  planVersion: number,
  nodeId: string,
  contracts: readonly Readonly<{ id: string }>[],
): readonly Readonly<ArtifactReference>[] {
  const record = requireRecord(value, "BUILD validation receipt");
  assertOnlyKeys(record, ["schemaVersion", "kind", "artifactRefs"], "BUILD validation receipt");
  if (record.schemaVersion !== 1 || record.kind !== "validated-build-outputs" || !Array.isArray(record.artifactRefs)) {
    throw new Error("BUILD validation receipt schema is invalid");
  }
  const refs = record.artifactRefs.map((candidate, index) => {
    const reference = requireRecord(candidate, `BUILD validation artifact ${index}`);
    assertOnlyKeys(reference, ["planVersion", "nodeId", "contract", "path", "sha256", "sizeBytes"], `BUILD validation artifact ${index}`);
    const expectedPrefix = `nodes/${planVersion}/${nodeId}/`;
    if (reference.planVersion !== planVersion || reference.nodeId !== nodeId || typeof reference.contract !== "string" ||
        typeof reference.path !== "string" || !reference.path.startsWith(expectedPrefix) || reference.path.includes("\\") ||
        reference.path.split("/").some((part) => part.length === 0 || part === "." || part === "..") ||
        typeof reference.sha256 !== "string" || !SHA256.test(reference.sha256) ||
        !Number.isSafeInteger(reference.sizeBytes) || (reference.sizeBytes as number) < 0 ||
        (reference.sizeBytes as number) > 64 * 1024 * 1024) {
      throw new Error(`BUILD validation artifact ${index} identity is invalid`);
    }
    const artifactPath = join(paths.root, ...reference.path.split("/"));
    const bytes = readBoundedBytes(paths.root, artifactPath, 64 * 1024 * 1024, `BUILD validation artifact ${index}`);
    if (bytes.byteLength !== reference.sizeBytes || sha256(bytes) !== reference.sha256) {
      throw new Error(`BUILD validation artifact ${index} bytes do not match its identity`);
    }
    return Object.freeze({
      planVersion,
      nodeId,
      contract: reference.contract,
      path: reference.path,
      sha256: reference.sha256,
      sizeBytes: reference.sizeBytes,
    }) as Readonly<ArtifactReference>;
  });
  if (!sameStrings(refs.map(({ contract }) => contract), contracts.map(({ id }) => id))) {
    throw new Error("BUILD validation receipt artifacts do not exactly match the immutable output contracts");
  }
  return Object.freeze([...refs].sort((left, right) => compare(left.contract, right.contract)));
}

function validateBuildIntegrationReceipt(
  paths: RunPaths,
  value: unknown,
  planVersion: number,
  nodeId: string,
  contracts: readonly Readonly<{ id: string }>[],
): readonly Readonly<ArtifactReference>[] {
  const record = requireRecord(value, "BUILD trusted human-integration receipt");
  assertOnlyKeys(record, [
    "schemaVersion", "kind", "decisionRef", "confirmationRef", "inspectedBy", "candidateEvidence",
    "mainWorkspaceInspection", "artifactRef", "recordedAt",
  ], "BUILD trusted human-integration receipt");
  if (record.schemaVersion !== 1 || record.kind !== "trusted-human-integration" ||
      record.inspectedBy !== "trusted-runtime-git" || typeof record.decisionRef !== "string" || !SHA256.test(record.decisionRef) ||
      typeof record.confirmationRef !== "string" || !SHA256.test(record.confirmationRef) || record.artifactRef === undefined) {
    throw new Error("BUILD trusted human-integration receipt identity is invalid");
  }
  return validateBuildValidationReceipt(paths, {
    schemaVersion: 1,
    kind: "validated-build-outputs",
    artifactRefs: [record.artifactRef],
  }, planVersion, nodeId, contracts);
}

function readLedgerEntries(paths: RunPaths, ledgerPath: string): BuildDispatchLedgerEntry[] {
  if (!existsSync(ledgerPath)) return [];
  const bytes = readBounded(paths.root, ledgerPath, MAX_LEDGER_BYTES, "BUILD dispatch ledger");
  if (!bytes.endsWith("\n")) throw new Error("BUILD dispatch ledger is partial or corrupt");
  const lines = bytes.split("\n").slice(0, -1);
  if (lines.length > MAX_LEDGER_EVENTS) throw new Error("BUILD dispatch ledger event limit exceeded");
  const entries: BuildDispatchLedgerEntry[] = [];
  let priorHash: string | null = null;
  for (const [index, line] of lines.entries()) {
    if (Buffer.byteLength(line) > MAX_LEDGER_EVENT_BYTES) throw new Error("BUILD dispatch ledger event exceeds its size limit");
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`BUILD dispatch ledger event ${index + 1} is corrupt JSON`);
    }
    const record = requireRecord(value, `BUILD dispatch ledger event ${index + 1}`);
    assertOnlyKeys(record, ["schemaVersion", "sequence", "priorHash", "checkpoint", "entryHash"], `BUILD dispatch ledger event ${index + 1}`);
    const checkpoint = assertBuildDispatchCheckpoint(record.checkpoint);
    if (record.schemaVersion !== 1 || record.sequence !== index + 1 || record.priorHash !== priorHash ||
        typeof record.entryHash !== "string" || !SHA256.test(record.entryHash)) {
      throw new Error(`BUILD dispatch ledger event ${index + 1} sequence or chain identity is invalid`);
    }
    const withoutHash = { schemaVersion: 1 as const, sequence: index + 1, priorHash, checkpoint };
    const expectedHash = sha256(stableJson(withoutHash));
    const normalized: BuildDispatchLedgerEntry = { ...withoutHash, entryHash: expectedHash };
    if (record.entryHash !== expectedHash || stableJson(normalized) !== line) {
      throw new Error(`BUILD dispatch ledger event ${index + 1} hash or canonical bytes are invalid`);
    }
    entries.push(normalized);
    priorHash = expectedHash;
  }
  return entries;
}

function normalizeEffectIdentity(value: Readonly<BuildEffectIdentity>): BuildEffectIdentity {
  const checkpoint = assertBuildDispatchCheckpoint({
    schemaVersion: 1,
    runId: value.runId,
    planVersion: value.planVersion,
    planHash: value.planHash,
    nodeId: value.nodeId,
    visit: value.visit,
    attempt: value.attempt,
    purpose: value.purpose,
    ordinal: value.ordinal,
    workspace: value.workspace,
    idempotencyKey: value.idempotencyKey,
    requestRef: value.requestRef,
    status: "intent-recorded",
    recordedAt: "1970-01-01T00:00:00.000Z",
  });
  const { schemaVersion: _schemaVersion, status: _status, recordedAt: _recordedAt, ...effect } = checkpoint;
  return effect;
}

function buildPlanVersionsRoot(paths: RunPaths): string {
  return join(paths.root, "build", "plan-versions");
}

function buildPlanReservationsRoot(paths: RunPaths): string {
  return join(paths.root, "build", "plan-reservations");
}

function buildPlanReservationPath(paths: RunPaths, planVersion: number): string {
  assertPositiveInteger(planVersion, "BUILD plan reservation version");
  return join(buildPlanReservationsRoot(paths), `${planVersion}.json`);
}

function buildPlanManifestPath(paths: RunPaths, planVersion: number): string {
  return join(buildPlanVersionRoot(paths, planVersion), "manifest.json");
}

function reservedBuildPlanVersions(paths: RunPaths): number[] {
  const root = buildPlanReservationsRoot(paths);
  if (!existsSync(root)) return [];
  assertNoSymlinkComponents(paths.root, root);
  const versions = readdirSync(root, { withFileTypes: true }).map((entry) => {
    if (entry.isSymbolicLink() || !entry.isFile() || !/^[1-9][0-9]*\.json$/.test(entry.name)) {
      throw new Error(`BUILD plan reservation entry is invalid: ${entry.name}`);
    }
    const version = Number(entry.name.slice(0, -5));
    if (!Number.isSafeInteger(version)) throw new Error("BUILD plan reservation version exceeds the safe integer range");
    return version;
  }).sort((left, right) => left - right);
  if (versions.some((version, index) => version !== index + 1)) {
    throw new Error("BUILD plan reservation versions must be contiguous from version 1");
  }
  return versions;
}

function readBuildPlanReservation(paths: RunPaths, planVersion: number): {
  compiled: CompiledBuildPlan;
  markdown: string;
  reservationSha256: string;
} {
  const path = buildPlanReservationPath(paths, planVersion);
  const bytes = readBounded(
    paths.root,
    path,
    MAX_PLAN_BYTES + MAX_MARKDOWN_BYTES + MAX_MANIFEST_BYTES,
    "BUILD plan reservation",
  );
  if (!bytes.endsWith("\n")) throw new Error("BUILD plan reservation is partial");
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new Error("BUILD plan reservation contains corrupt JSON");
  }
  const record = requireRecord(value, "BUILD plan reservation");
  assertOnlyKeys(record, ["schemaVersion", "planVersion", "planHash", "canonicalJson", "markdown"], "BUILD plan reservation");
  if (record.schemaVersion !== 1 || record.planVersion !== planVersion || typeof record.planHash !== "string" ||
      !SHA256.test(record.planHash) || typeof record.canonicalJson !== "string" || typeof record.markdown !== "string" ||
      `${stableJson(record)}\n` !== bytes) {
    throw new Error("BUILD plan reservation identity or canonical bytes are invalid");
  }
  let graphValue: unknown;
  try {
    graphValue = JSON.parse(record.canonicalJson);
  } catch {
    throw new Error("BUILD plan reservation graph contains corrupt JSON");
  }
  const compiled = compileBuildPlan(graphValue);
  if (compiled.plan.planVersion !== planVersion || compiled.hash !== record.planHash ||
      compiled.canonicalJson !== record.canonicalJson || renderBuildPlanMarkdown(compiled) !== record.markdown) {
    throw new Error("BUILD plan reservation does not match its compiled plan");
  }
  return { compiled, markdown: record.markdown, reservationSha256: sha256(bytes) };
}

function writeBuildPlanDerivedArtifacts(
  paths: RunPaths,
  compiled: Readonly<CompiledBuildPlan>,
  markdownBytes: string,
  reservationSha256: string,
  options: BuildArtifactMutationOptions,
): ImmutableBuildPlanReference {
  const versionRoot = buildPlanVersionRoot(paths, compiled.plan.planVersion);
  mkdirContained(paths.root, versionRoot);
  const graphPath = join(versionRoot, "plan.graph.json");
  const markdownPath = join(versionRoot, "plan.md");
  const manifestPath = join(versionRoot, "manifest.json");
  const graphBytes = `${compiled.canonicalJson}\n`;
  const manifest = {
    schemaVersion: 1,
    planVersion: compiled.plan.planVersion,
    planHash: compiled.hash,
    reservationSha256,
    graphSha256: sha256(graphBytes),
    markdownSha256: sha256(markdownBytes),
  };
  const manifestBytes = `${stableJson(manifest)}\n`;
  assertMutationAuthority(paths, options.owner);
  writeImmutableExact(paths.root, graphPath, graphBytes, MAX_PLAN_BYTES, "BUILD plan graph");
  options.failAt?.("after-graph");
  writeImmutableExact(paths.root, markdownPath, markdownBytes, MAX_MARKDOWN_BYTES, "BUILD plan Markdown");
  options.failAt?.("after-markdown");
  writeImmutableExact(paths.root, manifestPath, manifestBytes, MAX_MANIFEST_BYTES, "BUILD plan manifest");
  readImmutableBuildPlan(paths, compiled.plan.planVersion);
  return Object.freeze({
    planVersion: compiled.plan.planVersion,
    planHash: compiled.hash,
    graphPath,
    markdownPath,
    manifestPath,
  });
}

function buildPlanVersionRoot(paths: RunPaths, planVersion: number): string {
  assertPositiveInteger(planVersion, "BUILD plan version");
  return join(buildPlanVersionsRoot(paths), String(planVersion));
}

function buildNodeDirectory(paths: RunPaths, planVersion: number, nodeId: string): string {
  assertPositiveInteger(planVersion, "BUILD node plan version");
  assertToken(nodeId, "BUILD node id");
  return join(paths.nodes, String(planVersion), nodeId);
}

function buildLedgerPath(paths: RunPaths, planVersion: number, nodeId: string): string {
  return join(buildNodeDirectory(paths, planVersion, nodeId), "build-dispatch.jsonl");
}

function assertMutationAuthority(paths: RunPaths, owner: string): void {
  assertRunPathsSafe(paths);
  assertToken(owner, "BUILD artifact lease owner");
  if (!ownsRunLease(paths, owner)) throw new Error(`BUILD artifact mutation requires current lifecycle lease owner ${owner}`);
}

function mkdirContained(root: string, directory: string): void {
  assertContained(root, directory);
  assertNoSymlinkComponents(root, directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(root, directory);
}

function writeImmutableExact(root: string, path: string, bytes: string, maximum: number, label: string): void {
  assertContained(root, path);
  assertNoSymlinkComponents(root, path);
  if (Buffer.byteLength(bytes) > maximum) throw new Error(`${label} exceeds its size limit`);
  mkdirContained(root, dirname(path));
  if (existsSync(path)) {
    if (readBounded(root, path, maximum, label) === bytes) return;
    throw new Error(`${label} collides with an existing immutable version`);
  }
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(dirname(path));
}

function appendAndSync(root: string, path: string, bytes: string): void {
  assertContained(root, path);
  assertNoSymlinkComponents(root, path);
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollowFlag(), 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(dirname(path));
}

function readBounded(root: string, path: string, maximum: number, label: string): string {
  return readBoundedBytes(root, path, maximum, label).toString("utf8");
}

function readBoundedBytes(root: string, path: string, maximum: number, label: string): Buffer {
  assertContained(root, path);
  assertNoSymlinkComponents(root, path);
  const descriptor = openSync(path, constants.O_RDONLY | noFollowFlag());
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maximum) throw new Error(`${label} is not a bounded regular file`);
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function assertContained(root: string, target: string): void {
  const contained = relative(resolve(root), resolve(target));
  if (contained.startsWith("..") || isAbsolute(contained)) throw new Error("BUILD artifact path escapes its run root");
}

function assertNoSymlinkComponents(root: string, target: string): void {
  assertContained(root, target);
  let current = resolve(root);
  if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error("BUILD artifact root must not be a symlink");
  const contained = relative(current, resolve(target));
  for (const part of contained.split(/[\\/]+/).filter(Boolean)) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`BUILD artifact path must not contain symlinks: ${current}`);
    }
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function assertJsonData(value: unknown, label: string, depth: number): void {
  if (depth > 32) throw new Error(`${label} exceeds the nesting limit`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 4_096) throw new Error(`${label} contains an invalid array`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor)) throw new Error(`${label} contains an accessor or sparse array`);
      assertJsonData(descriptor.value, label, depth + 1);
    }
    return;
  }
  const record = requireRecord(value, label);
  if (Reflect.ownKeys(record).length > 4_096) throw new Error(`${label} contains too many fields`);
  for (const child of Object.values(record)) assertJsonData(child, label, depth + 1);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.values(Object.getOwnPropertyDescriptors(value));
  if ((prototype !== Object.prototype && prototype !== null) || descriptors.some((descriptor) => !("value" in descriptor))) {
    throw new Error(`${label} must be a plain object containing data properties`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extras = Reflect.ownKeys(record).filter((key) => typeof key !== "string" || !allowed.includes(key));
  if (extras.length > 0) throw new Error(`${label} contains unsupported fields`);
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive integer`);
}

function assertToken(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !TOKEN.test(value)) throw new Error(`${label} is invalid`);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = [...left].sort(compare);
  const normalizedRight = [...right].sort(compare);
  return normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compare(left, right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
