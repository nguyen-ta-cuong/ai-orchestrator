import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CompiledBuildPlan } from "../core/buildPlan.js";
import {
  createGraphExecutionState,
  graphDefinitionDigest,
  schedulerMetadataFingerprint,
  type ExecutionLimits,
  type ArtifactReference,
  type GraphEvent,
  type GraphExecutionState,
} from "../core/scheduler.js";
import type { RunPaths } from "./artifacts.js";
import { assertRunPathsSafe, ownsRunLease } from "./artifacts.js";
import {
  readBuildDispatchSeal,
  readBuildNodeArtifact,
  type BuildDispatchSealReference,
} from "./buildArtifacts.js";
import {
  acquireGraphCheckpointLease,
  checkpointGraphEvent,
  createGraphCheckpointPaths,
  graphSnapshotDigest,
  ownsGraphCheckpointLease,
  readGraphEvents,
  readGraphSnapshot,
  readImmutableGraphCheckpoint,
  releaseGraphCheckpointLease,
  replayGraphEvents,
  writeGraphSnapshot,
  writeImmutableGraphCheckpoint,
  writeNodeArtifact,
  type CheckpointFailurePoint,
  type GraphCheckpointLease,
  type GraphCheckpointPaths,
} from "../runtime/graphCheckpoint.js";

export interface BuildGraphExecutionOptions {
  owner: Readonly<GraphCheckpointLease>;
  graphOwner: Readonly<GraphCheckpointLease>;
  now: string;
  pid: number;
  limits: Readonly<ExecutionLimits>;
}

export interface BuildGraphCheckpointOptions {
  owner: Readonly<GraphCheckpointLease>;
  graphOwner: Readonly<GraphCheckpointLease>;
  tempId: string;
  failAt?(point: CheckpointFailurePoint): void;
}

export function buildGraphExecutionPaths(paths: RunPaths, planVersion = 1): GraphCheckpointPaths {
  assertRunPathsSafe(paths);
  assertPlanVersion(planVersion);
  return createGraphCheckpointPaths(join(paths.root, "build", "execution", "plan-versions", String(planVersion)));
}

export function acquireBuildGraphExecutionLease(
  paths: RunPaths,
  owner: Readonly<GraphCheckpointLease>,
  options: Readonly<{
    now: string;
    pid: number;
    planVersion?: number;
    isProcessAlive?(pid: number): boolean;
  }>,
): GraphCheckpointLease {
  assertLifecycleAuthority(paths, owner);
  if (options.pid !== owner.pid) {
    throw new Error("BUILD graph lease pid must match the active lifecycle lease generation");
  }
  const checkpointPaths = buildGraphExecutionPaths(paths, options.planVersion);
  const identity = buildGraphLeaseIdentity(checkpointPaths, owner);
  return acquireGraphCheckpointLease(checkpointPaths, identity.owner, {
    now: options.now,
    pid: options.pid,
    nonce: identity.nonce,
    ...(options.isProcessAlive === undefined ? {} : { isProcessAlive: options.isProcessAlive }),
  });
}

/**
 * Create or recover the immutable BUILD graph under both the outer lifecycle
 * generation and the separately acquired nested graph generation.
 */
export function initializeBuildGraphExecution(
  paths: RunPaths,
  compiled: Readonly<CompiledBuildPlan>,
  options: Readonly<BuildGraphExecutionOptions>,
): GraphExecutionState {
  assertBuildAuthority(paths, options, compiled.plan.planVersion);
  const checkpointPaths = buildGraphExecutionPaths(paths, compiled.plan.planVersion);
  let initial: GraphExecutionState;
  if (existsSync(checkpointPaths.graph)) {
    const immutable = readImmutableGraphCheckpoint(checkpointPaths);
    if (immutable.graphDigest !== graphDefinitionDigest(compiled.graph) ||
        immutable.metadataFingerprint !== schedulerMetadataFingerprint(compiled.schedulerMetadata) ||
        immutable.runId !== planRunId(paths) ||
        immutable.genesisState.planVersion !== compiled.plan.planVersion) {
      throw new Error("BUILD execution checkpoint does not match the immutable BUILD plan");
    }
    initial = immutable.genesisState;
  } else {
    if (existsSync(checkpointPaths.state) || readGraphEvents(checkpointPaths).length > 0) {
      throw new Error("BUILD execution state exists without its immutable graph genesis");
    }
    initial = createGraphExecutionState(compiled.graph, {
        runId: planRunId(paths),
        now: options.now,
        planVersion: compiled.plan.planVersion,
        metadata: compiled.schedulerMetadata,
        limits: options.limits,
    });
    writeImmutableGraphCheckpoint(
      checkpointPaths,
      compiled.graph,
      compiled.schedulerMetadata,
      initial,
      { owner: options.graphOwner },
    );
  }
  if (!existsSync(checkpointPaths.state)) {
    if (readGraphEvents(checkpointPaths).length > 0) {
      throw new Error("BUILD execution event log exists without its initial snapshot");
    }
    writeGraphSnapshot(checkpointPaths, compiled.graph, initial, {
      owner: options.graphOwner,
      tempId: `initial-${options.pid}`,
    });
    return initial;
  }
  return recoverBuildGraphExecution(paths, compiled, {
    owner: options.owner,
    graphOwner: options.graphOwner,
    tempId: `recover-${options.pid}`,
  });
}

export function recoverBuildGraphExecution(
  paths: RunPaths,
  compiled: Readonly<CompiledBuildPlan>,
  options: Readonly<{
    owner: Readonly<GraphCheckpointLease>;
    graphOwner: Readonly<GraphCheckpointLease>;
    tempId: string;
  }>,
): GraphExecutionState {
  assertBuildAuthority(paths, options, compiled.plan.planVersion);
  const checkpointPaths = buildGraphExecutionPaths(paths, compiled.plan.planVersion);
  const immutable = readImmutableGraphCheckpoint(checkpointPaths);
  if (immutable.graphDigest !== graphDefinitionDigest(compiled.graph) ||
      immutable.metadataFingerprint !== schedulerMetadataFingerprint(compiled.schedulerMetadata)) {
    throw new Error("BUILD execution recovery graph identity does not match the immutable BUILD plan");
  }
  const snapshot = readGraphSnapshot(checkpointPaths, compiled.graph);
  const recovered = replayGraphEvents(
    compiled.graph,
    snapshot,
    readGraphEvents(checkpointPaths),
    immutable.genesisState,
  );
  if (recovered.lastAppliedEventSequence !== snapshot.lastAppliedEventSequence) {
    writeGraphSnapshot(checkpointPaths, compiled.graph, recovered, {
      owner: options.graphOwner,
      tempId: options.tempId,
      expectedRevision: snapshot.revision,
      expectedSnapshotHash: graphSnapshotDigest(snapshot),
    });
  }
  return recovered;
}

export function checkpointBuildGraphEvent(
  paths: RunPaths,
  compiled: Readonly<CompiledBuildPlan>,
  state: Readonly<GraphExecutionState>,
  event: Readonly<GraphEvent>,
  options: Readonly<BuildGraphCheckpointOptions>,
): GraphExecutionState {
  assertBuildAuthority(paths, options, compiled.plan.planVersion);
  return checkpointGraphEvent({
    graph: compiled.graph,
    paths: buildGraphExecutionPaths(paths, compiled.plan.planVersion),
    state,
    event,
    owner: options.graphOwner,
    tempId: options.tempId,
    ...(options.failAt === undefined ? {} : { failAt: options.failAt }),
  });
}

export function releaseBuildGraphExecution(
  paths: RunPaths,
  owner: Readonly<GraphCheckpointLease>,
  planVersion = 1,
): boolean {
  assertRunPathsSafe(paths);
  return releaseGraphCheckpointLease(buildGraphExecutionPaths(paths, planVersion), owner);
}

export function mirrorBuildNodeArtifactToGraph(
  paths: RunPaths,
  reference: Readonly<ArtifactReference>,
  options: Readonly<{
    owner: Readonly<GraphCheckpointLease>;
    graphOwner: Readonly<GraphCheckpointLease>;
  }>,
): ArtifactReference {
  assertBuildAuthority(paths, options, reference.planVersion);
  return writeNodeArtifact(buildGraphExecutionPaths(paths, reference.planVersion), {
    owner: options.graphOwner,
    planVersion: reference.planVersion,
    nodeId: reference.nodeId,
    contract: reference.contract,
    bytes: readBuildNodeArtifact(paths, reference),
  });
}

export function mirrorBuildDispatchSealToGraph(
  paths: RunPaths,
  reference: Readonly<BuildDispatchSealReference>,
  options: Readonly<{
    owner: Readonly<GraphCheckpointLease>;
    graphOwner: Readonly<GraphCheckpointLease>;
  }>,
): ArtifactReference {
  assertBuildAuthority(paths, options, reference.planVersion);
  return writeNodeArtifact(buildGraphExecutionPaths(paths, reference.planVersion), {
    owner: options.graphOwner,
    planVersion: reference.planVersion,
    nodeId: reference.nodeId,
    contract: reference.contract,
    bytes: readBuildDispatchSeal(paths, reference),
  });
}

function assertLifecycleAuthority(paths: RunPaths, owner: Readonly<GraphCheckpointLease>): void {
  assertRunPathsSafe(paths);
  if (!ownsRunLease(paths, owner)) {
    throw new Error(`BUILD graph checkpoint requires current lifecycle lease owner ${owner.owner}`);
  }
}

function assertBuildAuthority(
  paths: RunPaths,
  options: Readonly<{
    owner: Readonly<GraphCheckpointLease>;
    graphOwner: Readonly<GraphCheckpointLease>;
  }>,
  planVersion: number,
): void {
  assertLifecycleAuthority(paths, options.owner);
  const executionPaths = buildGraphExecutionPaths(paths, planVersion);
  const identity = buildGraphLeaseIdentity(executionPaths, options.owner);
  if (options.graphOwner.owner !== identity.owner || options.graphOwner.nonce !== identity.nonce ||
      options.graphOwner.pid !== options.owner.pid) {
    throw new Error("BUILD graph checkpoint nested lease does not belong to the active lifecycle generation");
  }
  if (!ownsGraphCheckpointLease(executionPaths, options.graphOwner)) {
    throw new Error(`BUILD graph checkpoint requires nested lease generation ${options.graphOwner.owner}`);
  }
}

function buildGraphLeaseIdentity(
  paths: Readonly<GraphCheckpointPaths>,
  owner: Readonly<GraphCheckpointLease>,
): Readonly<{ owner: string; nonce: string }> {
  const digest = createHash("sha256")
    .update(`${owner.owner}\0${owner.nonce}\0${String(owner.dev)}\0${String(owner.ino)}\0${paths.root}`)
    .digest("hex");
  return Object.freeze({
    owner: `build-${digest}`,
    nonce: createHash("sha256").update(`build-lease\0${digest}`).digest("hex"),
  });
}

function planRunId(paths: RunPaths): string {
  const runId = paths.root.split(/[\\/]/).filter(Boolean).at(-1);
  if (!runId) throw new Error("BUILD graph checkpoint cannot derive its lifecycle run id");
  return runId;
}

function assertPlanVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("BUILD graph plan version must be a positive safe integer");
  }
}
