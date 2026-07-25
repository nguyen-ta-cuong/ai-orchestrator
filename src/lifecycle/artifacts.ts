import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createIdleLifecycleState, type LifecyclePhase, type LifecycleState } from "../core/lifecycle.js";
import { compileGraph } from "../core/graph.js";
import {
  DEFAULT_EXECUTION_LIMITS,
  applySchedulerEvent,
  assertScheduleValid,
  createGraphExecutionState,
  migrateLegacyNodePlanVersions,
  type ArtifactReference,
  type ExecutionLimits,
  type GraphEvent,
} from "../core/scheduler.js";
import { lifecycleWorkflowGraph } from "../core/workflowGraphs.js";
import {
  appendGraphEvent,
  acquireGraphCheckpointLease,
  ownsGraphCheckpointLease,
  readGraphEvents,
  readImmutableGraphCheckpoint,
  readNodeArtifact,
  replayGraphEvents,
  releaseGraphCheckpointLease,
  writeImmutableGraphCheckpoint,
  writeNodeArtifact,
  type CheckpointFailurePoint,
  type GraphCheckpointLease,
  type GraphCheckpointPaths,
  MAX_GRAPH_EVENT_LOG_BYTES,
} from "../runtime/graphCheckpoint.js";
import {
  assertLifecycleRecoveryMonotonic,
  authenticateLifecycleRecoveryEnvelope,
  validateLifecycleRecoveryEnvelope,
} from "./recoveryExecution.js";

export interface RunPaths extends GraphCheckpointPaths {
  spec: string;
  plan: string;
  debug: string;
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

export interface CreateRunOptions {
  executionLimits?: Readonly<ExecutionLimits>;
  /** Deterministic allocator hook for adversarial collision tests. */
  runIdFactory?(): string;
}

export interface LifecycleMigrationOptions {
  migrationLimits?: Readonly<ExecutionLimits>;
}

export interface LifecycleWriteOptions extends LifecycleMigrationOptions {
  owner?: Readonly<GraphCheckpointLease>;
}

export interface LifecycleAppendOptions {
  owner: Readonly<GraphCheckpointLease>;
  /** Failure-injection hook used to exercise a path swap immediately before open. */
  beforeOpen?(): void;
  /** Failure-injection hook used to exercise lease/path changes immediately before write. */
  beforeWrite?(): void;
}

export interface ReleaseRunOptions {
  beforeCurrentPointerRemove?(): void;
  beforeRegistryRemove?(): void;
}

export interface LifecycleNodeResultRecord {
  schemaVersion: 1;
  kind: "lifecycle-node-result";
  runId: string;
  nodeId: string;
  contract: string;
  nextState: LifecycleState;
  payload: Record<string, unknown>;
  contentSource: "spec" | "plan" | "debug" | "payload";
  contentRef: ArtifactReference;
}

const MAX_LIFECYCLE_STATE_BYTES = 16 * 1024 * 1024;
const MAX_LIFECYCLE_SEMANTIC_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_LIFECYCLE_JOURNAL_BYTES = 16 * 1024 * 1024;
const MAX_LIFECYCLE_ROUTING_TRACE_BYTES = 32 * 1024 * 1024;
const MAX_LIFECYCLE_APPEND_RECORD_BYTES = 256 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const LEASE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

interface CurrentRunLeaseRecord {
  owner: string;
  nonce: string;
  pid: number;
  createdAt: string;
  dev: number;
  ino: number;
}

interface BoundedFileIdentity {
  bytes: Buffer;
  dev: number;
  ino: number;
}

interface BoundedFileObservation {
  identity: BoundedFileIdentity;
  close(): void;
}

interface ActiveRunRegistry {
  runId: string;
  artifactsDir: string;
  runCwd: string;
  identity: BoundedFileIdentity;
}

export function createRun(
  cwd: string,
  artifactsDir: string,
  task: string,
  yolo = false,
  options: CreateRunOptions = {},
): { runId: string; paths: RunPaths } {
  assertArtifactRootSafe(cwd, artifactsDir);
  ensureArtifactsExcludedFromGit(cwd, artifactsDir);
  return withCurrentRunLock(cwd, artifactsDir, () => {
    const currentPath = currentRunPath(cwd, artifactsDir);
    const registryPath = repositoryActiveRunPath(cwd);
    const active = currentRun(cwd, artifactsDir);
    if (active) {
      const activeState = readState(active.paths, { migrationLimits: options.executionLimits });
      if (!activeState) {
        throw new Error(`Lifecycle run ${active.runId} has missing or corrupt state; explicit recovery is required`);
      }
      if (isActivePhase(activeState.phase)) {
        throw new Error(`An ai-orchestrator lifecycle run is already active: ${active.runId}`);
      }
      if (!releaseCurrentPointerIfMatches(cwd, artifactsDir, active.runId)) {
        throw new Error("Lifecycle current ownership changed during terminal replacement; explicit recovery is required");
      }
    } else if (existsSync(currentPath) || existsSync(registryPath)) {
      throw new Error("Lifecycle current pointer is invalid; explicit recovery is required");
    }

    const artifactsRoot = join(realpathSync(cwd), ...normalizeArtifactsDir(artifactsDir).split("/"));
    mkdirSync(artifactsRoot, { recursive: true });
    assertNoSymlinkComponents(artifactsRoot);
    let runId = "";
    let paths: RunPaths | undefined;
    let runRootCreated = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = options.runIdFactory?.() ?? createRunId();
      if (!isRunId(candidate)) throw new Error("Lifecycle run-id allocator returned an invalid id");
      const candidatePaths = pathsForRun(cwd, artifactsDir, candidate);
      try {
        mkdirSync(candidatePaths.root);
        runId = candidate;
        paths = candidatePaths;
        runRootCreated = true;
        break;
      } catch (error) {
        if (!isNodeErrorWithCode(error, "EEXIST")) throw error;
      }
    }
    if (!paths || !runRootCreated) throw new Error("Could not allocate an exclusive lifecycle run root after repeated id collisions");
    let currentPointerWritten = false;
    let registryWritten = false;
    try {
      assertRunPathsSafe(paths);
      writeFileSync(paths.spec, "");
      writeFileSync(paths.plan, "");
      writeFileSync(paths.debug, "");
      writeFileSync(paths.journal, `# AI Orchestrator Lifecycle Journal\n\nRun: ${runId}\nTask: ${task}\n\n`);
      writeFileSync(paths.routing, "");
      writeFileSync(paths.evidence, "");
      const initial = createIdleLifecycleState({ runId, phase: "idle", task, yolo });
      initializeLifecycleState(paths, initial, {
        migrationLimits: options.executionLimits,
      });
      writeFileSync(paths.events, "");
      mkdirSync(paths.nodes, { recursive: true });
      const bootstrapOwner = `bootstrap-${process.pid}-${randomBytes(6).toString("hex")}`;
      const bootstrapLease = acquireRunLease(paths, bootstrapOwner);
      try {
        ensureLifecycleGraphCheckpoint(paths, bootstrapLease);
        let bootstrap = readStateInternal(paths, {}, false);
        if (!bootstrap?.graphExecution) throw new Error("Lifecycle bootstrap snapshot is missing");
        bootstrap = checkpointLifecycleGraphEvent(paths, bootstrap, lifecycleStatusEvent(bootstrap, {
          nodeId: "idle",
          priorStatus: "ready",
          nextStatus: "running",
          attempt: 1,
        }), { owner: bootstrapLease, tempId: "bootstrap-start" });
        const started = cloneLifecycleEnvelope(bootstrap);
        started.phase = "defining";
        bootstrap = checkpointLifecycleGraphEvent(paths, bootstrap, lifecycleStatusEvent(bootstrap, {
          nodeId: "idle",
          priorStatus: "running",
          nextStatus: "blocked",
          attempt: 1,
          chosenEdge: {
            from: "idle",
            to: "defining",
            event: "start",
            guard: "start-new-run",
            boundedBy: "run-transition-budget",
          },
        }), { owner: bootstrapLease, tempId: "bootstrap-defining", nextState: started });
        if (bootstrap.phase !== "defining") throw new Error("Lifecycle bootstrap did not enter DEFINE");
      } finally {
        releaseRunLease(paths, bootstrapLease);
      }
      mkdirSync(join(registryPath, ".."), { recursive: true });
      assertNoSymlinkComponents(registryPath);
      writeFileSync(registryPath, `${JSON.stringify({ runId, artifactsDir: normalizeArtifactsDir(artifactsDir), runCwd: realpathSync(cwd) })}\n`, { flag: "wx" });
      registryWritten = true;
      writeFileSync(currentPath, `${runId}\n`, { flag: "wx" });
      currentPointerWritten = true;
      return { runId, paths };
    } finally {
      if (!currentPointerWritten) {
        if (registryWritten) {
          const registry = readActiveRunRegistry(cwd);
          if (registry?.runId === runId) {
            removeBoundedFileIfUnchanged(registryPath, registry.identity, 64 * 1024, "registry-cleanup");
          }
        }
        if (runRootCreated) rmSync(paths.root, { recursive: true, force: true });
      }
    }
  });
}

export function currentRun(cwd: string, artifactsDir: string): { runId: string; paths: RunPaths } | undefined {
  assertArtifactRootSafe(cwd, artifactsDir);
  const registry = readActiveRunRegistry(cwd);
  if (!registry && existsSync(repositoryActiveRunPath(cwd))) {
    throw new Error("Lifecycle repository active-run registry is corrupt; explicit recovery is required");
  }
  if (registry) {
    assertArtifactRootSafe(registry.runCwd, registry.artifactsDir);
    const paths = pathsForRun(registry.runCwd, registry.artifactsDir, registry.runId);
    const pointerPath = currentRunPath(registry.runCwd, registry.artifactsDir);
    const pointer = readCurrentRunPointer(pointerPath);
    if (!pointer && !existsSync(pointerPath)) {
      const state = readState(paths);
      if (!state || state.runId !== registry.runId) {
        throw new Error("Lifecycle repository active-run registry refers to invalid run authority; explicit recovery is required");
      }
      return { runId: registry.runId, paths };
    }
    if (!pointer || pointer.runId !== registry.runId) {
      throw new Error("Lifecycle repository active-run registry and current pointer disagree; explicit recovery is required");
    }
    return { runId: registry.runId, paths };
  }
  const currentPath = currentRunPath(cwd, artifactsDir);
  const pointer = readCurrentRunPointer(currentPath);
  return pointer ? { runId: pointer.runId, paths: pathsForRun(cwd, artifactsDir, pointer.runId) } : undefined;
}

export function readState(paths: RunPaths, options: LifecycleMigrationOptions = {}): LifecycleState | undefined {
  return readStateInternal(paths, options, true);
}

/** Reads one mutable semantic lifecycle artifact through a bounded, no-follow descriptor. */
export function readLifecycleArtifactBounded(paths: RunPaths, path: string): Buffer | undefined {
  assertRunPathsSafe(paths);
  const target = resolve(path);
  if (![paths.spec, paths.plan, paths.debug].some((candidate) => resolve(candidate) === target)) {
    throw new Error("Lifecycle semantic artifact path is not an exact run artifact");
  }
  try {
    return readFileBounded(target, MAX_LIFECYCLE_SEMANTIC_OUTPUT_BYTES, "lifecycle semantic artifact");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function readStateInternal(
  paths: RunPaths,
  options: LifecycleMigrationOptions,
  replayEvents: boolean,
): LifecycleState | undefined {
  assertRunPathsSafe(paths);
  if (!existsSync(paths.state)) return undefined;
  let bytes: Buffer;
  try {
    bytes = readFileBounded(paths.state, MAX_LIFECYCLE_STATE_BYTES, "lifecycle state");
  } catch (error) {
    throw new Error(`Lifecycle state cannot be read safely: ${errorMessage(error)}; explicit recovery is required`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Lifecycle state is corrupt JSON; explicit recovery is required: ${errorMessage(error)}`);
  }
  if (!isLifecycleStateEnvelope(parsed)) throw new Error("Lifecycle state envelope is invalid; explicit recovery is required");
  assertEnvelopeIdentityValid(parsed);
  const graph = graphForRun(paths);
  const frozenMigrationLimits = parsed.version === 1 && existsSync(paths.graph)
    ? readImmutableGraphCheckpoint(paths).genesisState.effectiveLimits
    : options.migrationLimits;
  const migratedSnapshot = migrateLifecycleState(parsed, frozenMigrationLimits, graph);
  // A scheduler-v2 node-namespace migration is intentionally in-memory until
  // the normal lease/CAS writer persists it. Preserve the raw envelope hash as
  // the compare-and-swap token for that first owned write.
  const hasEnvelopeIdentity = parsed.envelopeRevision !== undefined && parsed.previousEnvelopeHash !== undefined && parsed.envelopeHash !== undefined;
  const snapshot = hasEnvelopeIdentity ? migratedSnapshot : withLegacyEnvelopeIdentity(migratedSnapshot);
  if (snapshot.recovery && snapshot.graphExecution) {
    snapshot.recovery = authenticateLifecycleRecoveryEnvelope(paths, graph, snapshot.graphExecution, snapshot.recovery);
  }
  validateLifecycleGraphPrefix(paths, snapshot, graph);
  const migrated = replayEvents ? replayLifecycleEvents(paths, snapshot) : snapshot;
  return cloneLifecycleEnvelope(migrated);
}

export function writeState(paths: RunPaths, state: LifecycleState, options: LifecycleWriteOptions = {}): void {
  assertRunPathsSafe(paths);
  if (!existsSync(paths.state)) {
    throw new Error("Lifecycle state is missing; only createRun may initialize run authority");
  }
  if (!options.owner) {
    throw new Error("Lifecycle state mutation requires the current run lease owner");
  }
  if (!ownsRunLease(paths, options.owner)) {
    throw new Error(`Lifecycle state mutation requires current lease generation ${options.owner.owner}/${options.owner.nonce}`);
  }
  const graph = graphForRun(paths);
  const migrated = migrateLifecycleState(state, options.migrationLimits, graph);
  const persisted = writeLifecycleEnvelopeAtomic(
    paths,
    migrated,
    snapshotTempId(),
    {
      owner: options.owner,
      expectedGraphRevision: migrated.graphExecution!.revision,
    },
    graph,
    options.migrationLimits,
  );
  applyPersistedEnvelopeIdentity(state, persisted);
}

function initializeLifecycleState(
  paths: RunPaths,
  state: LifecycleState,
  options: LifecycleMigrationOptions,
): void {
  assertRunPathsSafe(paths);
  if (existsSync(paths.state) || existsSync(paths.graph) || existsSync(paths.executionLease) ||
      (existsSync(paths.events) && readFileBounded(paths.events, MAX_GRAPH_EVENT_LOG_BYTES, "graph event log").byteLength > 0) ||
      (existsSync(paths.nodes) && readdirSync(paths.nodes).length > 0)) {
    throw new Error("Lifecycle run authority already exists; refusing state initialization");
  }
  const graph = compiledLifecycleGraph();
  const migrated = migrateLifecycleState(state, options.migrationLimits, graph);
  const persisted = writeLifecycleEnvelopeAtomic(paths, migrated, snapshotTempId(), undefined, graph, options.migrationLimits);
  applyPersistedEnvelopeIdentity(state, persisted);
}

function applyPersistedEnvelopeIdentity(target: LifecycleState, persisted: LifecycleState): void {
  target.version = persisted.version;
  target.graphExecution = structuredClone(persisted.graphExecution);
  target.envelopeRevision = persisted.envelopeRevision;
  target.previousEnvelopeHash = persisted.previousEnvelopeHash;
  target.envelopeHash = persisted.envelopeHash;
}

function snapshotTempId(): string {
  return `${process.pid}-${Date.now()}-${randomBytes(12).toString("hex")}`;
}

export function ensureLifecycleGraphCheckpoint(
  paths: RunPaths,
  owner: Readonly<GraphCheckpointLease>,
  options: LifecycleMigrationOptions = {},
): void {
  assertRunPathsSafe(paths);
  if (existsSync(paths.graph)) {
    const existing = readImmutableGraphCheckpoint(paths);
    const state = readStateInternal(paths, options, false);
    if (!state || existing.runId !== state.runId) throw new Error("Immutable lifecycle graph belongs to another run");
    return;
  }
  const graph = compiledLifecycleGraph();
  const state = readStateInternal(paths, options, false);
  if (!state?.graphExecution) throw new Error("Lifecycle graph checkpoint requires persisted scheduler genesis");
  writeImmutableGraphCheckpoint(paths, graph, {}, state.graphExecution, { owner });
}

export function writeLifecycleNodeResult(
  paths: RunPaths,
  input: {
    owner: Readonly<GraphCheckpointLease>;
    graphState: NonNullable<LifecycleState["graphExecution"]>;
    nodeId: string;
    contract: string;
    nextState: LifecycleState;
    payload?: Record<string, unknown>;
  },
): ArtifactReference {
  assertRunPathsSafe(paths);
  if (input.graphState.runId !== input.nextState.runId) throw new Error("Lifecycle node result cannot change run identity");
  if (input.graphState.nodeStates[input.nodeId] === undefined) throw new Error(`Lifecycle node result references unknown node ${input.nodeId}`);
  const nextState = cloneLifecycleEnvelope(input.nextState);
  nextState.version = 1;
  delete nextState.graphExecution;
  delete nextState.envelopeRevision;
  delete nextState.previousEnvelopeHash;
  delete nextState.envelopeHash;
  if (!isLifecycleStateEnvelope(nextState)) throw new Error("Lifecycle node result contains an invalid business-state snapshot");
  const content = lifecycleNodeContent(paths, input.nodeId, input.payload ?? {});
  const contentRef = writeNodeArtifact(paths, {
    owner: input.owner,
    planVersion: input.graphState.planVersion,
    nodeId: input.nodeId,
    contract: `${input.contract}-content`,
    bytes: content.bytes,
  });
  const record: LifecycleNodeResultRecord = {
    schemaVersion: 1,
    kind: "lifecycle-node-result",
    runId: nextState.runId,
    nodeId: input.nodeId,
    contract: input.contract,
    nextState,
    payload: structuredClone(input.payload ?? {}),
    contentSource: content.source,
    contentRef,
  };
  return writeNodeArtifact(paths, {
    owner: input.owner,
    planVersion: input.graphState.planVersion,
    nodeId: input.nodeId,
    contract: input.contract,
    bytes: Buffer.from(`${JSON.stringify(record)}\n`, "utf8"),
  });
}

export function readLifecycleNodeResult(
  paths: RunPaths,
  reference: Readonly<ArtifactReference>,
  options: { verifyLiveArtifact?: boolean } = {},
): LifecycleNodeResultRecord {
  const bytes = readNodeArtifact(paths, reference);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Lifecycle node result artifact is corrupt JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Lifecycle node result artifact is invalid");
  const record = parsed as Record<string, unknown>;
  const expectedKeys = [
    "schemaVersion", "kind", "runId", "nodeId", "contract", "nextState", "payload", "contentSource", "contentRef",
  ].sort();
  const actualKeys = Object.keys(record).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("Lifecycle node result artifact contains unexpected or missing fields");
  }
  if (record.schemaVersion !== 1 || record.kind !== "lifecycle-node-result") {
    throw new Error("Lifecycle node result artifact header is invalid");
  }
  if (typeof record.runId !== "string" || !isRunId(record.runId) || record.nodeId !== reference.nodeId || record.contract !== reference.contract) {
    throw new Error("Lifecycle node result artifact identity is invalid");
  }
  if (!isLifecycleStateEnvelope(record.nextState) || record.nextState.version !== 1 || record.nextState.runId !== record.runId) {
    throw new Error("Lifecycle node result business-state snapshot is invalid");
  }
  if (!record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) {
    throw new Error("Lifecycle node result payload is invalid");
  }
  if (record.contentSource !== "spec" && record.contentSource !== "plan" && record.contentSource !== "debug" && record.contentSource !== "payload") {
    throw new Error("Lifecycle node result content source is invalid");
  }
  if (record.contentSource !== lifecycleNodeContentSource(reference.nodeId)) {
    throw new Error("Lifecycle node result content source does not match its node");
  }
  if (!record.contentRef || typeof record.contentRef !== "object" || Array.isArray(record.contentRef)) {
    throw new Error("Lifecycle node result content reference is invalid");
  }
  const contentRef = record.contentRef as ArtifactReference;
  if (contentRef.planVersion !== reference.planVersion || contentRef.nodeId !== reference.nodeId ||
      contentRef.contract !== `${reference.contract}-content`) {
    throw new Error("Lifecycle node result content reference identity is invalid");
  }
  const immutableBytes = readNodeArtifact(paths, contentRef);
  if (record.contentSource !== "payload" && options.verifyLiveArtifact !== false) {
    const livePath = record.contentSource === "spec" ? paths.spec : record.contentSource === "plan" ? paths.plan : paths.debug;
    const liveBytes = readFileBounded(livePath, MAX_LIFECYCLE_SEMANTIC_OUTPUT_BYTES, `${record.contentSource} artifact`);
    if (!liveBytes.equals(immutableBytes)) {
      throw new Error(`Live ${record.contentSource}.md bytes no longer match immutable lifecycle output; explicit recovery is required`);
    }
  }
  return structuredClone(record) as unknown as LifecycleNodeResultRecord;
}

export function writeLifecyclePlanVersionIntent(
  paths: RunPaths,
  input: {
    owner: Readonly<GraphCheckpointLease>;
    graphState: NonNullable<LifecycleState["graphExecution"]>;
    nodeId: string;
  },
): ArtifactReference {
  const node = input.graphState.nodeStates[input.nodeId];
  if (!node || node.status !== "ready") throw new Error("Lifecycle plan-version reservation requires a ready target node");
  const nextPlanVersion = input.graphState.planVersion + 1;
  return writeNodeArtifact(paths, {
    owner: input.owner,
    planVersion: nextPlanVersion,
    nodeId: input.nodeId,
    contract: "plan-version-intent",
    bytes: Buffer.from(`${canonicalJson({
      schemaVersion: 1,
      kind: "lifecycle-plan-version-intent",
      runId: input.graphState.runId,
      nodeId: input.nodeId,
      visit: node.visits,
      priorPlanVersion: input.graphState.planVersion,
      nextPlanVersion,
    })}\n`, "utf8"),
  });
}

function lifecycleNodeContent(
  paths: RunPaths,
  nodeId: string,
  payload: Record<string, unknown>,
): { source: LifecycleNodeResultRecord["contentSource"]; bytes: Buffer } {
  const source = lifecycleNodeContentSource(nodeId);
  if (source === "payload") return { source, bytes: Buffer.from(canonicalJson(payload), "utf8") };
  const path = source === "spec" ? paths.spec : source === "plan" ? paths.plan : paths.debug;
  const bytes = readFileBounded(path, MAX_LIFECYCLE_SEMANTIC_OUTPUT_BYTES, `${source} artifact`);
  if (bytes.byteLength === 0) throw new Error(`Lifecycle ${source} output is empty`);
  return { source, bytes };
}

function lifecycleNodeContentSource(nodeId: string): LifecycleNodeResultRecord["contentSource"] {
  return nodeId === "defining" ? "spec" : nodeId === "planning" ? "plan" : nodeId === "debugging" ? "debug" : "payload";
}

export function reconcileLifecycleCheckpoint(
  paths: RunPaths,
  options: { owner: Readonly<GraphCheckpointLease>; tempId: string; migrationLimits?: Readonly<ExecutionLimits> },
): LifecycleState {
  const snapshot = readStateInternal(paths, { migrationLimits: options.migrationLimits }, false);
  if (!snapshot?.graphExecution) throw new Error("Lifecycle snapshot is missing or corrupt; explicit recovery is required");
  const requiresOwnedMigration = lifecycleEnvelopeNeedsOwnedMigration(paths);
  const recovered = replayLifecycleEvents(paths, snapshot);
  if (recovered.graphExecution!.revision === snapshot.graphExecution.revision && !requiresOwnedMigration) return recovered;
  return writeLifecycleEnvelopeAtomic(paths, recovered, options.tempId, {
    owner: options.owner,
    expectedGraphRevision: snapshot.graphExecution.revision,
  });
}

function lifecycleEnvelopeNeedsOwnedMigration(paths: RunPaths): boolean {
  const parsed = JSON.parse(readFileBounded(paths.state, MAX_LIFECYCLE_STATE_BYTES, "lifecycle state").toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return true;
  const record = parsed as Record<string, unknown>;
  if (record.version !== 2 || !Object.hasOwn(record, "envelopeRevision") ||
      !Object.hasOwn(record, "previousEnvelopeHash") || !Object.hasOwn(record, "envelopeHash")) return true;
  const graph = record.graphExecution;
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) return true;
  const nodes = (graph as Record<string, unknown>).nodeStates;
  if (!nodes || typeof nodes !== "object" || Array.isArray(nodes)) return true;
  return Object.values(nodes as Record<string, unknown>).some((node) =>
    !node || typeof node !== "object" || Array.isArray(node) || !Object.hasOwn(node, "planVersion"));
}

export function checkpointLifecycleGraphEvent(
  paths: RunPaths,
  current: LifecycleState,
  event: Readonly<GraphEvent>,
  options: {
    owner: Readonly<GraphCheckpointLease>;
    tempId: string;
    nextState?: LifecycleState;
    failAt?(point: CheckpointFailurePoint): void;
  },
): LifecycleState {
  assertRunPathsSafe(paths);
  if (!ownsRunLease(paths, options.owner)) {
    throw new Error(`Lifecycle graph checkpoint requires current lease generation ${options.owner.owner}/${options.owner.nonce}`);
  }
  const graph = graphForRun(paths);
  const migratedCurrent = migrateLifecycleState(current, undefined, graph);
  assertLifecycleCheckpointBaseCurrent(paths, migratedCurrent);
  const nextGraph = applySchedulerEvent(graph, migratedCurrent.graphExecution!, event);
  const candidate = cloneLifecycleEnvelope(options.nextState ?? migratedCurrent);
  if (candidate.runId !== migratedCurrent.runId) throw new Error("Lifecycle graph checkpoint cannot change run identity");
  candidate.version = 2;
  candidate.graphExecution = nextGraph;
  assertLifecycleGraphAlignment(candidate, graph);

  appendGraphEvent(paths, event, { owner: options.owner });
  options.failAt?.("after-event-append");
  return writeLifecycleEnvelopeAtomic(paths, candidate, options.tempId, {
    owner: options.owner,
    expectedGraphRevision: migratedCurrent.graphExecution!.revision,
    failAt: options.failAt,
  });
}

function assertLifecycleCheckpointBaseCurrent(paths: RunPaths, current: LifecycleState): void {
  const disk = readStateInternal(paths, {
    migrationLimits: current.graphExecution?.effectiveLimits,
  }, false);
  if (!disk?.graphExecution) throw new Error("Current lifecycle snapshot is missing or corrupt; refusing checkpoint append");
  if (current.envelopeRevision !== disk.envelopeRevision || current.envelopeHash !== disk.envelopeHash) {
    throw new Error("Lifecycle envelope compare-and-swap conflict; state changed since it was read");
  }
  if (current.graphExecution!.revision !== disk.graphExecution.revision) {
    throw new Error(
      `Lifecycle graph revision conflict: durable snapshot is ${disk.graphExecution.revision}, ` +
      `but checkpoint input is ${current.graphExecution!.revision}; reconcile before appending another event`,
    );
  }
}

function compiledLifecycleGraph() {
  return compileGraph(lifecycleWorkflowGraph());
}

function graphForRun(paths: RunPaths) {
  return existsSync(paths.graph) ? readImmutableGraphCheckpoint(paths).graph : compiledLifecycleGraph();
}

function validateLifecycleGraphPrefix(
  paths: RunPaths,
  state: LifecycleState,
  graph: ReturnType<typeof compiledLifecycleGraph>,
): void {
  if (!state.graphExecution) throw new Error("Lifecycle graph state is missing");
  assertScheduleValid(graph, state.graphExecution);
  assertLifecycleGraphAlignment(state, graph);
  if (!existsSync(paths.graph)) {
    if (existsSync(paths.events) && readFileBounded(paths.events, MAX_GRAPH_EVENT_LOG_BYTES, "graph event log").byteLength > 0) {
      throw new Error("Lifecycle event log exists without immutable graph genesis; explicit recovery is required");
    }
    return;
  }
  const immutable = readImmutableGraphCheckpoint(paths);
  const events = readGraphEvents(paths);
  replayGraphEvents(immutable.graph, state.graphExecution, events, immutable.genesisState);
  validateAppliedLifecycleOutputs(paths, state, immutable.graph, events);
}

function validateAppliedLifecycleOutputs(
  paths: RunPaths,
  state: LifecycleState,
  graph: ReturnType<typeof compiledLifecycleGraph>,
  events: readonly Readonly<GraphEvent>[],
): void {
  const applied = events.slice(0, state.graphExecution!.lastAppliedEventSequence);
  const latestLiveArtifact = new Map<Exclude<LifecycleNodeResultRecord["contentSource"], "payload">, ArtifactReference>();
  const validateResult = (
    event: Readonly<GraphEvent>,
    reference: Readonly<ArtifactReference>,
    expectedPhase?: string,
  ): LifecycleNodeResultRecord => {
    const result = readLifecycleNodeResult(paths, reference, { verifyLiveArtifact: false });
    if (result.runId !== state.runId || result.nodeId !== event.nodeId ||
        (expectedPhase !== undefined && result.nextState.phase !== expectedPhase)) {
      throw new Error(`Lifecycle transition event ${event.eventId} does not match its business-state artifact`);
    }
    if (result.contentSource !== "payload") latestLiveArtifact.set(result.contentSource, reference as ArtifactReference);
    return result;
  };
  for (const event of applied) {
    const resultRef = event.sideEffect?.phase === "result" && event.sideEffect.outcome === "succeeded"
      ? event.sideEffect.resultRef
      : undefined;
    if (resultRef) {
      readNodeArtifact(paths, resultRef);
      if (graph.nodesById.get(event.nodeId)!.outputContracts.includes(resultRef.contract)) {
        validateResult(event, resultRef);
      }
    }
    for (const reference of event.artifactRefs) readNodeArtifact(paths, reference);
    if (event.kind !== "node-status" || (event.nextStatus !== "blocked" && event.nextStatus !== "executed")) continue;
    const expectedPhase = event.nextStatus === "blocked" ? event.chosenEdge?.to : event.nodeId;
    for (const reference of event.artifactRefs) {
      validateResult(event, reference, expectedPhase);
    }
  }
  for (const reference of latestLiveArtifact.values()) readLifecycleNodeResult(paths, reference);
}

function assertEnvelopeIdentityValid(state: LifecycleState): void {
  const identity = [state.envelopeRevision, state.previousEnvelopeHash, state.envelopeHash];
  if (identity.every((value) => value === undefined)) return;
  if (!Number.isSafeInteger(state.envelopeRevision) || state.envelopeRevision! < 0 ||
      typeof state.previousEnvelopeHash !== "string" || !SHA256.test(state.previousEnvelopeHash) ||
      typeof state.envelopeHash !== "string" || !SHA256.test(state.envelopeHash)) {
    throw new Error("Lifecycle envelope compare-and-swap identity is invalid; explicit recovery is required");
  }
  if (lifecycleEnvelopeHash(state) !== state.envelopeHash) {
    throw new Error("Lifecycle envelope hash does not match its business state; explicit recovery is required");
  }
}

function withLegacyEnvelopeIdentity(state: LifecycleState): LifecycleState {
  if (state.envelopeRevision !== undefined || state.previousEnvelopeHash !== undefined || state.envelopeHash !== undefined) {
    assertEnvelopeIdentityValid(state);
    return cloneLifecycleEnvelope(state);
  }
  const migrated = cloneLifecycleEnvelope(state);
  migrated.envelopeRevision = migrated.graphExecution?.revision ?? 0;
  migrated.previousEnvelopeHash = lifecycleEnvelopeGenesisHash(migrated.runId);
  migrated.envelopeHash = lifecycleEnvelopeHash(migrated);
  return migrated;
}

function lifecycleEnvelopeGenesisHash(runId: string): string {
  return sha256(`lifecycle-envelope-genesis:${runId}`);
}

function lifecycleEnvelopeHash(state: LifecycleState): string {
  const value = structuredClone(state) as LifecycleState;
  delete value.envelopeHash;
  return sha256(canonicalJson(value));
}

function lifecycleStatusEvent(
  state: LifecycleState,
  input: Pick<GraphEvent, "nodeId" | "priorStatus" | "nextStatus" | "attempt"> &
    Partial<Pick<GraphEvent, "chosenEdge" | "errorCategory">>,
): GraphEvent {
  if (!state.graphExecution) throw new Error("Lifecycle graph state is missing");
  const graphState = state.graphExecution;
  return {
    schemaVersion: 1,
    kind: "node-status",
    sequence: graphState.lastAppliedEventSequence + 1,
    eventId: `lifecycle-${graphState.lastAppliedEventSequence + 1}-${randomBytes(6).toString("hex")}`,
    runId: state.runId,
    graphId: graphState.graphId,
    graphVersion: graphState.graphVersion,
    graphDigest: graphState.graphDigest,
    planVersion: graphState.planVersion,
    nodeId: input.nodeId,
    priorStatus: input.priorStatus,
    nextStatus: input.nextStatus,
    attempt: input.attempt,
    timestamp: new Date().toISOString(),
    artifactRefs: [],
    ...(input.chosenEdge ? { chosenEdge: input.chosenEdge } : {}),
    ...(input.errorCategory ? { errorCategory: input.errorCategory } : {}),
  };
}

function replayLifecycleEvents(paths: RunPaths, snapshot: LifecycleState): LifecycleState {
  if (!snapshot.graphExecution) throw new Error("Lifecycle graph state is missing");
  const immutable = existsSync(paths.graph) ? readImmutableGraphCheckpoint(paths) : undefined;
  const graph = immutable?.graph ?? compiledLifecycleGraph();
  const events = readGraphEvents(paths);
  const firstUnapplied = snapshot.graphExecution.lastAppliedEventSequence;
  const replayedGraph = replayGraphEvents(graph, snapshot.graphExecution, events, immutable?.genesisState ?? snapshot.graphExecution);
  let recovered = cloneLifecycleEnvelope(snapshot);
  const succeededTransitionResult = new Map<string, ArtifactReference>();
  for (const node of Object.values(snapshot.graphExecution.nodeStates)) {
    if (node.sideEffect?.status === "succeeded" && node.sideEffect.resultRef) {
      succeededTransitionResult.set(node.nodeId, node.sideEffect.resultRef);
    }
  }
  for (const event of events.slice(firstUnapplied)) {
    if (event.kind === "side-effect-intent") {
      succeededTransitionResult.delete(event.nodeId);
      continue;
    }
    if (event.kind === "side-effect-result") {
      if (event.sideEffect?.outcome === "succeeded" && event.sideEffect.resultRef) {
        succeededTransitionResult.set(event.nodeId, event.sideEffect.resultRef);
      } else {
        succeededTransitionResult.delete(event.nodeId);
      }
      continue;
    }
    if (event.kind !== "node-status") continue;
    if (event.nextStatus === "running") {
      succeededTransitionResult.delete(event.nodeId);
      continue;
    }
    if (event.nextStatus === "cancelled") {
      // Cancellation is a deterministic business transition (phase -> idle). A
      // previously succeeded receipt may describe a normal transition that was
      // later denied by a guard, so it must never be consumed as cancellation
      // evidence.
      recovered.phase = event.chosenEdge?.to as LifecyclePhase;
      succeededTransitionResult.delete(event.nodeId);
      continue;
    }
    if (event.nextStatus !== "blocked" && event.nextStatus !== "failed") continue;
    const settled = succeededTransitionResult.get(event.nodeId);
    const reference = event.nextStatus === "blocked" ? event.artifactRefs[0] : settled;
    if (!reference || (settled && !sameArtifactReference(settled, reference))) {
      throw new Error(`Lifecycle transition event ${event.eventId} is missing its exact succeeded result artifact`);
    }
    recovered = transitionBusinessState(paths, snapshot.runId, graph, event, reference);
    succeededTransitionResult.delete(event.nodeId);
  }
  recovered.version = 2;
  recovered.graphExecution = replayedGraph;
  recovered.envelopeRevision = snapshot.envelopeRevision;
  recovered.previousEnvelopeHash = snapshot.previousEnvelopeHash;
  recovered.envelopeHash = snapshot.envelopeHash;
  assertLifecycleGraphAlignment(recovered, graph);
  validateAppliedLifecycleOutputs(paths, recovered, graph, events);
  return recovered;
}

function transitionBusinessState(
  paths: RunPaths,
  runId: string,
  graph: ReturnType<typeof compiledLifecycleGraph>,
  event: Readonly<GraphEvent>,
  reference: Readonly<ArtifactReference>,
): LifecycleState {
  if (!graph.nodesById.get(event.nodeId)!.outputContracts.includes(reference.contract)) {
    throw new Error(`Lifecycle transition event ${event.eventId} result contract is not declared by ${event.nodeId}`);
  }
  const result = readLifecycleNodeResult(paths, reference, { verifyLiveArtifact: false });
  if (result.runId !== runId || result.nodeId !== event.nodeId || result.nextState.phase !== event.chosenEdge?.to) {
    throw new Error(`Lifecycle transition event ${event.eventId} does not match its business-state artifact`);
  }
  return cloneLifecycleEnvelope(result.nextState);
}

function sameArtifactReference(left: Readonly<ArtifactReference>, right: Readonly<ArtifactReference>): boolean {
  return left.planVersion === right.planVersion && left.nodeId === right.nodeId && left.contract === right.contract &&
    left.path === right.path && left.sha256 === right.sha256 && left.sizeBytes === right.sizeBytes;
}

function migrateLifecycleState(
  state: LifecycleState,
  migrationLimits?: Readonly<ExecutionLimits>,
  graph = compiledLifecycleGraph(),
): LifecycleState {
  if (state.version === 2) {
    if (!state.graphExecution) throw new Error("Lifecycle version 2 state is missing graphExecution");
    const migrated = cloneLifecycleEnvelope(state);
    migrated.graphExecution = migrateLegacyNodePlanVersions(state.graphExecution);
    assertScheduleValid(graph, migrated.graphExecution);
    assertLifecycleGraphAlignment(migrated, graph);
    return migrated;
  }
  const graphExecution = createGraphExecutionState(graph, {
    runId: state.runId,
    now: runStartedAt(state.runId),
    limits: cloneExecutionLimits(migrationLimits ?? DEFAULT_EXECUTION_LIMITS),
    currentNodeId: state.phase,
  });
  const migrated: LifecycleState = {
    ...cloneLifecycleEnvelope(state),
    version: 2,
    graphExecution,
  };
  assertLifecycleGraphAlignment(migrated, graph);
  return migrated;
}

function cloneExecutionLimits(limits: Readonly<ExecutionLimits>): ExecutionLimits {
  return {
    ...limits,
    backEdgeBudgets: { ...limits.backEdgeBudgets },
  };
}

function cloneLifecycleEnvelope(state: LifecycleState): LifecycleState {
  return {
    ...state,
    verdicts: state.verdicts.map((verdict) => ({ ...verdict })),
    modelSelections: state.modelSelections?.map((selection) => ({
      ...selection,
      routing: selection.routing ? {
        ...selection.routing,
        attemptedModels: [...selection.routing.attemptedModels],
        failureCategories: [...selection.routing.failureCategories],
      } : undefined,
    })) ?? [],
    rejectionFingerprints: [...(state.rejectionFingerprints ?? [])],
    buildEvidenceFingerprints: [...(state.buildEvidenceFingerprints ?? [])],
    pendingCheckerVerdict: state.pendingCheckerVerdict ? { ...state.pendingCheckerVerdict } : undefined,
    baselinePaths: state.baselinePaths ? [...state.baselinePaths] : undefined,
    baselineStagedPaths: state.baselineStagedPaths ? [...state.baselineStagedPaths] : undefined,
    finalization: state.finalization ? { ...state.finalization } : undefined,
    originalModel: state.originalModel ? { ...state.originalModel } : undefined,
    recovery: state.recovery ? structuredClone(state.recovery) : undefined,
    graphExecution: state.graphExecution ? structuredClone(state.graphExecution) : undefined,
    revisionFeedback: state.revisionFeedback ? { ...state.revisionFeedback } : undefined,
    reminder: state.reminder ? { ...state.reminder } : undefined,
  };
}

function assertLifecycleGraphAlignment(state: LifecycleState, graph: ReturnType<typeof compiledLifecycleGraph>): void {
  if (state.version !== 2 || !state.graphExecution) throw new Error("Lifecycle graph state is missing");
  if (state.graphExecution.runId !== state.runId) throw new Error("Lifecycle and graph run identities do not match");
  const phaseNode = state.graphExecution.nodeStates[state.phase];
  if (!phaseNode) throw new Error(`Lifecycle phase ${state.phase} does not exist in its graph`);
  const terminal = graph.nodesById.get(state.phase)!.terminal === true;
  if (terminal) {
    if (phaseNode.status !== "ready" && phaseNode.status !== "running" && phaseNode.status !== "executed") {
      throw new Error(`Lifecycle terminal phase ${state.phase} is not active or complete in graph state`);
    }
    return;
  }
  if (state.phase === "idle" && state.graphExecution.ready.length === 0 &&
      Object.values(state.graphExecution.nodeStates).some((node) => node.status === "cancelled")) {
    return;
  }
  if (phaseNode.status !== "ready" && phaseNode.status !== "running" && phaseNode.status !== "waiting_human") {
    throw new Error(`Lifecycle phase ${state.phase} is not the active graph node`);
  }
}

function runStartedAt(runId: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})-[a-f0-9]{6}$/.exec(runId);
  if (!match) throw new Error("Lifecycle run id cannot provide a migration start time");
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  );
  if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3]) ||
      date.getHours() !== Number(match[4]) || date.getMinutes() !== Number(match[5])) {
    throw new Error("Lifecycle run id contains an invalid migration start time");
  }
  return date.toISOString();
}

function writeLifecycleEnvelopeAtomic(
  paths: RunPaths,
  state: LifecycleState,
  tempId: string,
  options?: {
    owner: Readonly<GraphCheckpointLease>;
    expectedGraphRevision: number;
    failAt?(point: CheckpointFailurePoint): void;
  },
  graph = graphForRun(paths),
  migrationLimits?: Readonly<ExecutionLimits>,
): LifecycleState {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(tempId)) throw new Error("Lifecycle snapshot temp id is invalid");
  const migrated = migrateLifecycleState(state, undefined, graph);
  const disk = existsSync(paths.state) ? readStateInternal(paths, {
    migrationLimits: migrationLimits ?? migrated.graphExecution?.effectiveLimits,
  }, false) : undefined;
  const expectedRevision = migrated.envelopeRevision;
  const expectedHash = migrated.envelopeHash;
  if (disk) {
    if (expectedRevision !== disk.envelopeRevision || expectedHash !== disk.envelopeHash) {
      throw new Error("Lifecycle envelope compare-and-swap conflict; state changed since it was read");
    }
  } else if (expectedRevision !== undefined || expectedHash !== undefined || migrated.previousEnvelopeHash !== undefined) {
    throw new Error("Initial lifecycle envelope cannot carry a prior compare-and-swap identity");
  }
  assertLifecycleRecoveryMonotonic(disk?.recovery, migrated.recovery);
  if (migrated.recovery && migrated.graphExecution) {
    migrated.recovery = authenticateLifecycleRecoveryEnvelope(paths, graph, migrated.graphExecution, migrated.recovery);
  }
  if (options) {
    if (!ownsRunLease(paths, options.owner)) {
      throw new Error(`Lifecycle graph checkpoint requires current lease generation ${options.owner.owner}/${options.owner.nonce}`);
    }
    if (!disk?.graphExecution) throw new Error("Current lifecycle snapshot is missing or corrupt; refusing CAS overwrite");
    if (disk.graphExecution.revision !== options.expectedGraphRevision) {
      throw new Error(`Lifecycle graph revision conflict: expected ${options.expectedGraphRevision}, found ${disk.graphExecution.revision}`);
    }
  }
  const persisted = cloneLifecycleEnvelope(migrated);
  persisted.envelopeRevision = disk ? disk.envelopeRevision! + 1 : 0;
  persisted.previousEnvelopeHash = disk?.envelopeHash ?? lifecycleEnvelopeGenesisHash(persisted.runId);
  delete persisted.envelopeHash;
  persisted.envelopeHash = lifecycleEnvelopeHash(persisted);
  validateLifecycleGraphPrefix(paths, persisted, graph);
  const bytes = `${JSON.stringify(persisted, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > MAX_LIFECYCLE_STATE_BYTES) throw new Error("Lifecycle state exceeds its size limit");
  const tempPath = `${paths.state}.${tempId}.tmp`;
  assertPathInsideRun(paths, tempPath);
  assertNoSymlinkComponents(tempPath);
  let renamed = false;
  try {
    const file = openSync(tempPath, "wx", 0o600);
    try {
      writeAll(file, Buffer.from(bytes));
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    options?.failAt?.("after-snapshot-temp-write");
    if (options && !ownsRunLease(paths, options.owner)) throw new Error("Lifecycle graph lease ownership changed before snapshot rename");
    renameSync(tempPath, paths.state);
    renamed = true;
    fsyncDirectory(dirname(paths.state));
    options?.failAt?.("after-snapshot-rename");
  } finally {
    if (!renamed) rmSync(tempPath, { force: true });
  }
  return persisted;
}

function assertPathInsideRun(paths: RunPaths, target: string): void {
  const contained = relative(resolve(paths.root), resolve(target));
  if (contained.startsWith("..") || isAbsolute(contained)) throw new Error("Lifecycle snapshot temp path escapes its run");
}

function fsyncDirectory(path: string): void {
  const file = openSync(path, "r");
  try {
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
}

export function appendJournal(paths: RunPaths, line: string, options: LifecycleAppendOptions): void {
  const timestamp = new Date().toISOString();
  const bytes = Buffer.from(`- ${timestamp} ${line}\n`);
  if (bytes.byteLength > MAX_LIFECYCLE_APPEND_RECORD_BYTES) {
    throw new Error("lifecycle journal record exceeds 256 KiB");
  }
  appendOwnedFileAndSync(paths, paths.journal, bytes, MAX_LIFECYCLE_JOURNAL_BYTES, "lifecycle journal", options);
}

export function appendRoutingTrace(paths: RunPaths, record: RoutingTraceRecord, options: LifecycleAppendOptions): void {
  if (!isRoutingTraceRecord(record)) throw new Error("routing trace record is invalid");
  const line = JSON.stringify(record);
  const bytes = Buffer.from(`${line}\n`);
  if (bytes.byteLength > MAX_LIFECYCLE_APPEND_RECORD_BYTES) throw new Error("routing trace record exceeds 256 KiB");
  appendOwnedFileAndSync(paths, paths.routing, bytes, MAX_LIFECYCLE_ROUTING_TRACE_BYTES, "lifecycle routing trace", options);
}

export function acquireRunLease(paths: RunPaths, owner: string): GraphCheckpointLease {
  assertRunPathsSafe(paths);
  return acquireGraphCheckpointLease(paths, owner, { now: new Date().toISOString(), pid: process.pid });
}

export function ownsRunLease(paths: RunPaths, owner: Readonly<GraphCheckpointLease>): boolean {
  assertRunPathsSafe(paths);
  return ownsGraphCheckpointLease(paths, owner);
}

export function releaseRunLease(paths: RunPaths, owner: Readonly<GraphCheckpointLease>): boolean {
  // Cleanup must remain possible when another lifecycle artifact became unsafe
  // during an external/model wait. The graph lease adapter validates only its
  // own exact contained authority paths.
  return releaseGraphCheckpointLease(paths, owner);
}

export function releaseRun(cwd: string, artifactsDir: string, runId: string, options: ReleaseRunOptions = {}): boolean {
  assertArtifactRootSafe(cwd, artifactsDir);
  return withCurrentRunLock(cwd, artifactsDir, () => releaseCurrentPointerIfMatches(cwd, artifactsDir, runId, options));
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
    graph: join(root, "graph.json"),
    events: join(root, "events.jsonl"),
    nodes: join(root, "nodes"),
    mutations: join(root, "mutations"),
    executionLease: join(root, "execution.lock"),
  };
}

function currentRunPath(cwd: string, artifactsDir: string): string {
  return join(realpathSync(cwd), ...normalizeArtifactsDir(artifactsDir).split("/"), "current");
}

function currentRunLockPath(cwd: string, _artifactsDir: string): string {
  return join(coordinationRoot(cwd), ".ai-orchestrator", "current.lock");
}

function repositoryActiveRunPath(cwd: string): string {
  return join(coordinationRoot(cwd), ".ai-orchestrator", "active-run.json");
}

function coordinationRoot(cwd: string): string {
  return resolveGitContext(cwd)?.worktreeRoot ?? realpathSync(cwd);
}

function readActiveRunRegistry(cwd: string): ActiveRunRegistry | undefined {
  const path = repositoryActiveRunPath(cwd);
  assertNoSymlinkComponents(path);
  if (!existsSync(path)) return undefined;
  let identity: BoundedFileIdentity;
  try {
    identity = readFileBoundedWithIdentity(path, 64 * 1024, "lifecycle active-run registry");
  } catch (error) {
    throw new Error(`Lifecycle active-run registry cannot be read safely: ${errorMessage(error)}; explicit recovery is required`);
  }
  return parseActiveRunRegistry(cwd, identity);
}

function observeActiveRunRegistry(cwd: string): Readonly<{
  registry: ActiveRunRegistry | undefined;
  close(): void;
}> {
  const path = repositoryActiveRunPath(cwd);
  assertNoSymlinkComponents(path);
  if (!existsSync(path)) return { registry: undefined, close() {} };
  let observation: BoundedFileObservation;
  try {
    observation = observeBoundedFile(path, 64 * 1024, "lifecycle active-run registry");
  } catch (error) {
    throw new Error(`Lifecycle active-run registry cannot be read safely: ${errorMessage(error)}; explicit recovery is required`);
  }
  return {
    registry: parseActiveRunRegistry(cwd, observation.identity),
    close: observation.close,
  };
}

function parseActiveRunRegistry(cwd: string, identity: BoundedFileIdentity): ActiveRunRegistry | undefined {
  try {
    const value = JSON.parse(identity.bytes.toString("utf8")) as { runId?: unknown; artifactsDir?: unknown; runCwd?: unknown };
    if (typeof value.runId !== "string" || !isRunId(value.runId) || typeof value.artifactsDir !== "string") return undefined;
    const root = coordinationRoot(cwd);
    const runCwd = typeof value.runCwd === "string" ? realpathSync(value.runCwd) : root;
    const contained = relative(root, runCwd);
    if (contained.startsWith("..") || isAbsolute(contained)) return undefined;
    return { runId: value.runId, artifactsDir: normalizeArtifactsDir(value.artifactsDir), runCwd, identity };
  } catch {
    return undefined;
  }
}

function readCurrentRunPointer(path: string): { runId: string; identity: BoundedFileIdentity } | undefined {
  assertNoSymlinkComponents(path);
  if (!existsSync(path)) return undefined;
  let identity: BoundedFileIdentity;
  try {
    identity = readFileBoundedWithIdentity(path, 1024, "lifecycle current pointer");
  } catch (error) {
    throw new Error(`Lifecycle current pointer cannot be read safely: ${errorMessage(error)}; explicit recovery is required`);
  }
  return parseCurrentRunPointer(identity);
}

function observeCurrentRunPointer(path: string): Readonly<{
  pointer: { runId: string; identity: BoundedFileIdentity } | undefined;
  close(): void;
}> {
  assertNoSymlinkComponents(path);
  if (!existsSync(path)) return { pointer: undefined, close() {} };
  let observation: BoundedFileObservation;
  try {
    observation = observeBoundedFile(path, 1024, "lifecycle current pointer");
  } catch (error) {
    throw new Error(`Lifecycle current pointer cannot be read safely: ${errorMessage(error)}; explicit recovery is required`);
  }
  return {
    pointer: parseCurrentRunPointer(observation.identity),
    close: observation.close,
  };
}

function parseCurrentRunPointer(identity: BoundedFileIdentity): { runId: string; identity: BoundedFileIdentity } | undefined {
  const runId = identity.bytes.toString("utf8").trim();
  return isRunId(runId) ? { runId, identity } : undefined;
}

function releaseCurrentPointerIfMatches(
  cwd: string,
  artifactsDir: string,
  runId: string,
  options: ReleaseRunOptions = {},
): boolean {
  const registryObservation = observeActiveRunRegistry(cwd);
  try {
    const registry = registryObservation.registry;
    const registryPath = repositoryActiveRunPath(cwd);
    if (!registry && existsSync(registryPath)) return false;
    if (registry && registry.runId !== runId) return false;
    const currentPath = currentRunPath(registry?.runCwd ?? cwd, registry?.artifactsDir ?? artifactsDir);
    const pointerObservation = observeCurrentRunPointer(currentPath);
    try {
      const pointer = pointerObservation.pointer;
      if (!pointer) {
        if (!registry || existsSync(currentPath)) return false;
        const state = readState(pathsForRun(registry.runCwd, registry.artifactsDir, registry.runId));
        if (!state || state.runId !== registry.runId) return false;
        options.beforeRegistryRemove?.();
        return removeBoundedFileIfUnchanged(registryPath, registry.identity, 64 * 1024, "registry-release");
      }
      if (pointer.runId !== runId) return false;
      options.beforeCurrentPointerRemove?.();
      if (!removeBoundedFileIfUnchanged(currentPath, pointer.identity, 1024, "pointer-release")) return false;
      if (registry?.runId !== runId) return true;
      options.beforeRegistryRemove?.();
      return removeBoundedFileIfUnchanged(registryPath, registry.identity, 64 * 1024, "registry-release");
    } finally {
      pointerObservation.close();
    }
  } finally {
    registryObservation.close();
  }
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
  const coordinatorRoot = relative(realWorktreeRoot, join(coordinationRoot(cwd), ".ai-orchestrator"));
  const coordinatorPatterns = coordinatorRoot.length > 0 && !coordinatorRoot.startsWith("..") && !isAbsolute(coordinatorRoot)
    ? ["active-run.json", "current.lock"].map((name) => `/${gitIgnorePath([...coordinatorRoot.split(/[\\/]+/), name])}`)
    : [];
  if (relativeArtifactRoot.length === 0 || relativeArtifactRoot.startsWith("..") || isAbsolute(relativeArtifactRoot)) {
    return [`/${gitIgnorePath(normalized.split("/"))}/`, ...coordinatorPatterns];
  }
  return [`/${gitIgnorePath(relativeArtifactRoot.split(/[\\/]+/))}/`, ...coordinatorPatterns];
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
        worktreeRoot: realpathSync(worktreeRoot),
      };
    }
  } catch {
    // Fall back to direct .git resolution for tests and minimal Git installations.
  }

  const gitDir = resolveGitDir(cwd);
  return gitDir ? { excludePath: join(gitDir, "info", "exclude"), worktreeRoot: realpathSync(cwd) } : undefined;
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
  assertNoSymlinkComponents(lockPath);
  mkdirSync(join(lockPath, ".."), { recursive: true });
  assertNoSymlinkComponents(lockPath);
  assertArtifactRootSafe(cwd, artifactsDir);
  const owner = `current-${process.pid}-${randomBytes(6).toString("hex")}`;
  const nonce = randomBytes(16).toString("hex");
  let held: CurrentRunLeaseRecord | undefined;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      writeCurrentRunLeaseExclusive(lockPath, { owner, nonce, pid: process.pid, createdAt: new Date().toISOString() });
      held = readCurrentRunLease(lockPath);
      if (!held || held.owner !== owner || held.nonce !== nonce) {
        throw new Error("Lifecycle current-run lock identity changed during acquisition; explicit recovery is required");
      }
      break;
    } catch (error) {
      if (!isNodeErrorWithCode(error, "EEXIST")) throw error;
      const existing = readCurrentRunLease(lockPath);
      if (!existing || isProcessAlive(existing.pid)) {
        throw new Error("An ai-orchestrator lifecycle run is already active or starting");
      }
      if (!removeCurrentRunLeaseIfUnchanged(lockPath, existing, "reclaim")) continue;
    }
  }
  if (!held) throw new Error("Lifecycle current-run lock could not be acquired");
  try {
    return operation();
  } finally {
    removeCurrentRunLeaseIfUnchanged(lockPath, held, "release");
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
  if (!isAbsolute(paths.root)) throw new Error("Lifecycle run root must be absolute");
  const root = resolve(paths.root);
  const expected: Record<Exclude<keyof RunPaths, "root">, string> = {
    spec: join(root, "spec.md"),
    plan: join(root, "plan.md"),
    debug: join(root, "debug.md"),
    state: join(root, "state.json"),
    journal: join(root, "journal.md"),
    routing: join(root, "routing.jsonl"),
    evidence: join(root, "evidence.jsonl"),
    graph: join(root, "graph.json"),
    events: join(root, "events.jsonl"),
    nodes: join(root, "nodes"),
    mutations: join(root, "mutations"),
    executionLease: join(root, "execution.lock"),
  };
  for (const [field, target] of Object.entries(expected) as [keyof typeof expected, string][]) {
    if (resolve(paths[field]) !== target) throw new Error(`Lifecycle ${field} path must be the exact contained child of its run root`);
    assertPathInsideRun(paths, target);
  }
  for (const path of [root, ...Object.values(expected)]) assertNoSymlinkComponents(path);
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

function readFileBounded(path: string, limit: number, label: string): Buffer {
  return readFileBoundedWithIdentity(path, limit, label).bytes;
}

function readFileBoundedWithIdentity(
  path: string,
  limit: number,
  label: string,
): { bytes: Buffer; dev: number; ino: number } {
  const observation = observeBoundedFile(path, limit, label);
  try {
    return observation.identity;
  } finally {
    observation.close();
  }
}

function observeBoundedFile(path: string, limit: number, label: string): BoundedFileObservation {
  assertNoSymlinkComponents(path);
  const file = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let completed = false;
  try {
    const before = fstatSync(file);
    if (!before.isFile() || before.size > limit) throw new Error(`${label} is oversized and exceeds its limit`);
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= limit) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - total));
      const count = readSync(file, chunk, 0, chunk.byteLength, null);
      if (count === 0) break;
      chunks.push(chunk.subarray(0, count));
      total += count;
    }
    const after = fstatSync(file);
    if (total > limit) throw new Error(`${label} is oversized and exceeds its limit`);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || total !== after.size) {
      throw new Error(`${label} changed while it was read; explicit recovery is required`);
    }
    let closed = false;
    completed = true;
    return {
      identity: { bytes: Buffer.concat(chunks, total), dev: after.dev, ino: after.ino },
      close() {
        if (closed) return;
        closed = true;
        closeSync(file);
      },
    };
  } finally {
    if (!completed) closeSync(file);
  }
}

function sameBoundedFileIdentity(left: BoundedFileIdentity, right: BoundedFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.bytes.equals(right.bytes);
}

function removeBoundedFileIfUnchanged(
  path: string,
  observed: BoundedFileIdentity,
  limit: number,
  operation: string,
): boolean {
  let current: BoundedFileIdentity;
  try {
    current = readFileBoundedWithIdentity(path, limit, `lifecycle ${operation}`);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) return false;
    throw error;
  }
  if (!sameBoundedFileIdentity(current, observed)) return false;
  const quarantine = `${path}.${operation}.${randomBytes(16).toString("hex")}.tmp`;
  assertNoSymlinkComponents(quarantine);
  try {
    renameSync(path, quarantine);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) return false;
    throw error;
  }
  fsyncDirectory(dirname(path));
  const moved = readFileBoundedWithIdentity(quarantine, limit, `lifecycle ${operation} quarantine`);
  if (!sameBoundedFileIdentity(moved, observed)) {
    restoreMovedCoordinationFile(path, quarantine);
    return false;
  }
  unlinkSync(quarantine);
  fsyncDirectory(dirname(path));
  return true;
}

function restoreMovedCoordinationFile(path: string, quarantine: string): void {
  try {
    linkSync(quarantine, path);
    fsyncDirectory(dirname(path));
    unlinkSync(quarantine);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if (!isNodeErrorWithCode(error, "EEXIST")) throw error;
    throw new Error(`Lifecycle coordination file changed during removal; replacement preserved at ${quarantine}; explicit recovery is required`);
  }
}

function appendOwnedFileAndSync(
  paths: RunPaths,
  path: string,
  bytes: Buffer,
  limit: number,
  label: string,
  options: LifecycleAppendOptions,
): void {
  if (!LEASE_TOKEN.test(options.owner.owner)) throw new Error(`${label} append owner is invalid`);
  assertRunPathsSafe(paths);
  if (!ownsRunLease(paths, options.owner)) throw new Error(`${label} append requires current lease owner ${options.owner.owner}`);
  options.beforeOpen?.();
  assertNoSymlinkComponents(path);
  const file = openSync(path, constants.O_APPEND | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(file);
    if (!before.isFile()) throw new Error(`${label} must be a regular file`);
    if (before.size + bytes.byteLength > limit) throw new Error(`${label} exceeds its file limit`);
    options.beforeWrite?.();
    if (!ownsRunLease(paths, options.owner)) throw new Error(`${label} append lease ownership changed before write`);
    assertOpenFileStillNamed(path, before.dev, before.ino, label);
    writeAll(file, bytes);
    fsyncSync(file);
    const after = fstatSync(file);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size + bytes.byteLength) {
      throw new Error(`${label} changed while it was appended; explicit recovery is required`);
    }
    if (!ownsRunLease(paths, options.owner)) throw new Error(`${label} append lease ownership changed after write`);
    assertOpenFileStillNamed(path, after.dev, after.ino, label);
  } finally {
    closeSync(file);
  }
  fsyncDirectory(dirname(path));
}

function assertOpenFileStillNamed(path: string, dev: number, ino: number, label: string): void {
  const named = lstatSync(path);
  if (!named.isFile() || named.isSymbolicLink() || named.dev !== dev || named.ino !== ino) {
    throw new Error(`${label} path identity changed during append; explicit recovery is required`);
  }
}

function writeAll(file: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(file, bytes, offset, bytes.byteLength - offset, null);
    if (written <= 0) throw new Error("Lifecycle state write made no progress");
    offset += written;
  }
}

function canonicalJson(value: unknown): string {
  const json = JSON.stringify(canonicalValue(value));
  if (json === undefined) throw new Error("Cannot canonicalize undefined lifecycle data");
  return json;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => item === undefined ? null : canonicalValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  return value;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readCurrentRunLease(path: string): CurrentRunLeaseRecord | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const read = readFileBoundedWithIdentity(path, 16 * 1024, "lifecycle current-run lock");
    const value = JSON.parse(read.bytes.toString("utf8")) as Record<string, unknown>;
    const keys = Object.keys(value).sort();
    if (keys.join("\0") !== ["createdAt", "nonce", "owner", "pid"].join("\0")) return undefined;
    if (typeof value.owner !== "string" || !LEASE_TOKEN.test(value.owner) ||
        typeof value.nonce !== "string" || !LEASE_TOKEN.test(value.nonce) ||
        !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 ||
        typeof value.createdAt !== "string" || !isIsoTimestamp(value.createdAt)) return undefined;
    return {
      owner: value.owner,
      nonce: value.nonce,
      pid: value.pid as number,
      createdAt: value.createdAt,
      dev: read.dev,
      ino: read.ino,
    };
  } catch {
    return undefined;
  }
}

function writeCurrentRunLeaseExclusive(
  path: string,
  record: Omit<CurrentRunLeaseRecord, "dev" | "ino">,
): void {
  const file = openSync(path, "wx", 0o600);
  try {
    writeAll(file, Buffer.from(`${JSON.stringify(record)}\n`, "utf8"));
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  fsyncDirectory(dirname(path));
}

function sameCurrentRunLease(left: CurrentRunLeaseRecord, right: CurrentRunLeaseRecord): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.owner === right.owner && left.nonce === right.nonce;
}

function removeCurrentRunLeaseIfUnchanged(
  path: string,
  observed: CurrentRunLeaseRecord,
  operation: "reclaim" | "release",
): boolean {
  const current = readCurrentRunLease(path);
  if (!current || !sameCurrentRunLease(current, observed)) return false;
  const quarantine = `${path}.${operation}.${randomBytes(16).toString("hex")}.tmp`;
  assertNoSymlinkComponents(quarantine);
  try {
    renameSync(path, quarantine);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) return false;
    throw error;
  }
  fsyncDirectory(dirname(path));
  const moved = readCurrentRunLease(quarantine);
  if (!moved || !sameCurrentRunLease(moved, observed)) {
    restoreCurrentRunLease(path, quarantine);
    return false;
  }
  unlinkSync(quarantine);
  fsyncDirectory(dirname(path));
  return true;
}

function restoreCurrentRunLease(path: string, quarantine: string): void {
  try {
    linkSync(quarantine, path);
    fsyncDirectory(dirname(path));
    unlinkSync(quarantine);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if (!isNodeErrorWithCode(error, "EEXIST")) throw error;
    throw new Error(`Lifecycle current-run lock changed during mutation; replacement preserved at ${quarantine}; explicit recovery is required`);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeErrorWithCode(error, "ESRCH");
  }
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

function isLifecycleStateEnvelope(value: unknown): value is LifecycleState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LifecycleState>;
  return (
    (candidate.version === 1 || candidate.version === 2) &&
    typeof candidate.runId === "string" &&
    isRunId(candidate.runId) &&
    typeof candidate.phase === "string" &&
    LIFECYCLE_PHASES.has(candidate.phase as LifecyclePhase) &&
    typeof candidate.task === "string" &&
    typeof candidate.buildIterations === "number" && Number.isSafeInteger(candidate.buildIterations) && candidate.buildIterations >= 0 &&
    typeof candidate.consecutiveRejections === "number" && Number.isSafeInteger(candidate.consecutiveRejections) && candidate.consecutiveRejections >= 0 &&
    Array.isArray(candidate.verdicts) &&
    candidate.verdicts.every(isLifecycleVerdict) &&
    (candidate.rejectionFingerprints === undefined || (Array.isArray(candidate.rejectionFingerprints) && candidate.rejectionFingerprints.every(isFingerprint))) &&
    (candidate.buildEvidenceFingerprints === undefined || (Array.isArray(candidate.buildEvidenceFingerprints) && candidate.buildEvidenceFingerprints.every(isFingerprint))) &&
    (candidate.planFingerprint === undefined || isFingerprint(candidate.planFingerprint)) &&
    isPendingCheckerVerdict(candidate.pendingCheckerVerdict) &&
    (candidate.modelSelections === undefined ||
      (Array.isArray(candidate.modelSelections) && candidate.modelSelections.every(isLifecycleModelSelection))) &&
    (candidate.routingPolicyVersion === undefined || (typeof candidate.routingPolicyVersion === "string" && candidate.routingPolicyVersion.length > 0)) &&
    (candidate.debugPath === undefined || typeof candidate.debugPath === "string") &&
    (candidate.debugDiagnosisVerdictIndex === undefined ||
      (Number.isInteger(candidate.debugDiagnosisVerdictIndex) && candidate.debugDiagnosisVerdictIndex >= 0)) &&
    (candidate.baselinePaths === undefined ||
      (Array.isArray(candidate.baselinePaths) && candidate.baselinePaths.every((path) => typeof path === "string"))) &&
    (candidate.baselineStagedPaths === undefined ||
      (Array.isArray(candidate.baselineStagedPaths) && candidate.baselineStagedPaths.every((path) => typeof path === "string"))) &&
    (candidate.modelRestored === undefined || typeof candidate.modelRestored === "boolean") &&
    (candidate.envelopeRevision === undefined || (Number.isSafeInteger(candidate.envelopeRevision) && candidate.envelopeRevision >= 0)) &&
    (candidate.previousEnvelopeHash === undefined || (typeof candidate.previousEnvelopeHash === "string" && SHA256.test(candidate.previousEnvelopeHash))) &&
    (candidate.envelopeHash === undefined || (typeof candidate.envelopeHash === "string" && SHA256.test(candidate.envelopeHash))) &&
    isLifecycleRevisionFeedback(candidate.revisionFeedback) &&
    isLifecycleReminder(candidate.reminder) &&
    isLifecycleOriginalModel(candidate.originalModel) &&
    (candidate.recovery === undefined || isLifecycleRecovery(candidate.recovery)) &&
    isLifecycleFinalization(candidate.finalization) &&
    (candidate.version === 1 ? candidate.graphExecution === undefined : !!candidate.graphExecution && typeof candidate.graphExecution === "object") &&
    typeof candidate.yolo === "boolean"
  );
}

function isLifecycleRecovery(value: unknown): boolean {
  try {
    validateLifecycleRecoveryEnvelope(value);
    return true;
  } catch {
    return false;
  }
}

function isLifecycleRevisionFeedback(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (candidate.artifact === "spec" || candidate.artifact === "plan") &&
    typeof candidate.feedback === "string" && candidate.feedback.trim().length > 0 && candidate.feedback.length <= 256_000 &&
    isIsoTimestamp(candidate.recordedAt);
}

function isLifecycleReminder(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.phase === "string" && LIFECYCLE_PHASES.has(candidate.phase as LifecyclePhase) &&
    (candidate.kind === "artifact" || candidate.kind === "verdict" || candidate.kind === "debug") &&
    isIsoTimestamp(candidate.recordedAt);
}

function isIsoTimestamp(value: unknown): boolean {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isPendingCheckerVerdict(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const phaseMatchesKind = (candidate.phase === "verifying" && candidate.kind === "verify") ||
    (candidate.phase === "reviewing" && candidate.kind === "review") ||
    (candidate.phase === "shipping" && candidate.kind === "ship");
  return phaseMatchesKind && (candidate.verdict === "approve" || candidate.verdict === "reject") &&
    typeof candidate.reasons === "string" && candidate.reasons.trim().length > 0 &&
    (candidate.requiredFixes === undefined || (typeof candidate.requiredFixes === "string" && candidate.requiredFixes.trim().length > 0));
}

function isFingerprint(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{16}$/.test(value);
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
  return (candidate.commitSha === undefined || isGitSha(candidate.commitSha)) &&
    (candidate.commitBaseSha === undefined || isGitSha(candidate.commitBaseSha)) &&
    (candidate.commitMessage === undefined || (typeof candidate.commitMessage === "string" && candidate.commitMessage.trim().length > 0 && candidate.commitMessage.length <= 200 && !/[\r\n]/.test(candidate.commitMessage))) &&
    (candidate.prUrl === undefined || isHttpsUrl(candidate.prUrl)) &&
    (candidate.prHead === undefined || (typeof candidate.prHead === "string" && /^[A-Za-z0-9._/-]{1,255}$/.test(candidate.prHead) && !candidate.prHead.includes("..") && !candidate.prHead.startsWith("-")));
}

function isGitSha(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{7,64}$/i.test(value);
}

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
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
    (candidate.phaseEntryKey === undefined || typeof candidate.phaseEntryKey === "string") &&
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
