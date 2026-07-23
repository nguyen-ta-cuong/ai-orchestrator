import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CompiledBuildPlan } from "../core/buildPlan.js";
import {
  createGraphExecutionState,
  graphDefinitionDigest,
  schedulerMetadataFingerprint,
  type ExecutionLimits,
  type GraphEvent,
  type GraphExecutionState,
} from "../core/scheduler.js";
import type { RunPaths } from "./artifacts.js";
import { assertRunPathsSafe, ownsRunLease } from "./artifacts.js";
import {
  acquireGraphCheckpointLease,
  checkpointGraphEvent,
  createGraphCheckpointPaths,
  ownsGraphCheckpointLease,
  readGraphEvents,
  readGraphSnapshot,
  readImmutableGraphCheckpoint,
  releaseGraphCheckpointLease,
  replayGraphEvents,
  writeGraphSnapshot,
  writeImmutableGraphCheckpoint,
  type CheckpointFailurePoint,
  type GraphCheckpointPaths,
} from "../runtime/graphCheckpoint.js";

export interface BuildGraphExecutionOptions {
  owner: string;
  now: string;
  pid: number;
  limits: Readonly<ExecutionLimits>;
  isProcessAlive?(pid: number): boolean;
}

export interface BuildGraphCheckpointOptions {
  owner: string;
  tempId: string;
  failAt?(point: CheckpointFailurePoint): void;
}

export function buildGraphExecutionPaths(paths: RunPaths): GraphCheckpointPaths {
  assertRunPathsSafe(paths);
  return createGraphCheckpointPaths(join(paths.root, "build", "execution"));
}

/**
 * Acquire the nested BUILD executor lease and create or recover its immutable
 * graph snapshot. The lifecycle lease remains the outer authority.
 */
export function initializeBuildGraphExecution(
  paths: RunPaths,
  compiled: Readonly<CompiledBuildPlan>,
  options: Readonly<BuildGraphExecutionOptions>,
): GraphExecutionState {
  assertLifecycleAuthority(paths, options.owner);
  const checkpointPaths = buildGraphExecutionPaths(paths);
  const alreadyOwned = ownsGraphCheckpointLease(checkpointPaths, options.owner);
  acquireGraphCheckpointLease(checkpointPaths, options.owner, {
    now: options.now,
    pid: options.pid,
    ...(options.isProcessAlive === undefined ? {} : { isProcessAlive: options.isProcessAlive }),
  });
  try {
    writeImmutableGraphCheckpoint(checkpointPaths, compiled.graph, compiled.schedulerMetadata, { owner: options.owner });
    const immutable = readImmutableGraphCheckpoint(checkpointPaths);
    if (immutable.graphDigest !== graphDefinitionDigest(compiled.graph) ||
        immutable.metadataFingerprint !== schedulerMetadataFingerprint(compiled.schedulerMetadata)) {
      throw new Error("BUILD execution checkpoint does not match the immutable BUILD plan");
    }
    if (!existsSync(checkpointPaths.state)) {
      if (readGraphEvents(checkpointPaths).length > 0) {
        throw new Error("BUILD execution event log exists without its initial snapshot");
      }
      const initial = createGraphExecutionState(compiled.graph, {
        runId: planRunId(paths),
        now: options.now,
        planVersion: compiled.plan.planVersion,
        metadata: compiled.schedulerMetadata,
        limits: options.limits,
      });
      writeGraphSnapshot(checkpointPaths, compiled.graph, initial, {
        owner: options.owner,
        tempId: `initial-${options.pid}`,
      });
      return initial;
    }
    return recoverBuildGraphExecution(paths, compiled, { owner: options.owner, tempId: `recover-${options.pid}` });
  } catch (error) {
    if (!alreadyOwned) releaseGraphCheckpointLease(checkpointPaths, options.owner);
    throw error;
  }
}

export function recoverBuildGraphExecution(
  paths: RunPaths,
  compiled: Readonly<CompiledBuildPlan>,
  options: Readonly<{ owner: string; tempId: string }>,
): GraphExecutionState {
  assertLifecycleAuthority(paths, options.owner);
  const checkpointPaths = buildGraphExecutionPaths(paths);
  const immutable = readImmutableGraphCheckpoint(checkpointPaths);
  if (immutable.graphDigest !== graphDefinitionDigest(compiled.graph) ||
      immutable.metadataFingerprint !== schedulerMetadataFingerprint(compiled.schedulerMetadata)) {
    throw new Error("BUILD execution recovery graph identity does not match the immutable BUILD plan");
  }
  const snapshot = readGraphSnapshot(checkpointPaths, compiled.graph);
  const recovered = replayGraphEvents(compiled.graph, snapshot, readGraphEvents(checkpointPaths));
  if (recovered.lastAppliedEventSequence !== snapshot.lastAppliedEventSequence) {
    writeGraphSnapshot(checkpointPaths, compiled.graph, recovered, {
      owner: options.owner,
      tempId: options.tempId,
      expectedRevision: snapshot.revision,
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
  assertLifecycleAuthority(paths, options.owner);
  return checkpointGraphEvent({
    graph: compiled.graph,
    paths: buildGraphExecutionPaths(paths),
    state,
    event,
    owner: options.owner,
    tempId: options.tempId,
    ...(options.failAt === undefined ? {} : { failAt: options.failAt }),
  });
}

export function releaseBuildGraphExecution(paths: RunPaths, owner: string): boolean {
  assertRunPathsSafe(paths);
  return releaseGraphCheckpointLease(buildGraphExecutionPaths(paths), owner);
}

function assertLifecycleAuthority(paths: RunPaths, owner: string): void {
  assertRunPathsSafe(paths);
  if (!ownsRunLease(paths, owner)) {
    throw new Error(`BUILD graph checkpoint requires current lifecycle lease owner ${owner}`);
  }
}

function planRunId(paths: RunPaths): string {
  const runId = paths.root.split(/[\\/]/).filter(Boolean).at(-1);
  if (!runId) throw new Error("BUILD graph checkpoint cannot derive its lifecycle run id");
  return runId;
}
