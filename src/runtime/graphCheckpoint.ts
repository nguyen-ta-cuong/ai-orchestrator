import { createHash, randomBytes } from "node:crypto";
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
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { compileGraph, type CompiledGraph, type GraphDefinition } from "../core/graph.js";
import {
  applySchedulerEvent,
  assertGraphEventValid,
  assertScheduleValid,
  createGraphExecutionState,
  graphDefinitionDigest,
  graphEventDigest,
  schedulerMetadataFingerprint,
  type ArtifactReference,
  type GraphEvent,
  type GraphExecutionState,
  type SchedulerMetadata,
} from "../core/scheduler.js";

export interface GraphCheckpointPaths {
  root: string;
  state: string;
  graph: string;
  events: string;
  nodes: string;
  executionLease: string;
}

export interface CheckpointMutationOptions {
  owner: string;
}

export type CheckpointFailurePoint =
  | "after-event-append"
  | "after-snapshot-temp-write"
  | "after-snapshot-rename";

export interface SnapshotWriteOptions extends CheckpointMutationOptions {
  tempId: string;
  expectedRevision?: number;
  expectedSnapshotHash?: string;
  failAt?(point: CheckpointFailurePoint): void;
}

export interface LeaseOptions {
  now: string;
  pid: number;
  nonce?: string;
  isProcessAlive?(pid: number): boolean;
  beforeStaleLeaseRemove?(): void;
}

export interface LeaseReleaseOptions {
  beforeLeaseRemove?(): void;
}

export interface ImmutableGraphCheckpoint {
  schemaVersion: 1;
  graphDigest: string;
  metadataFingerprint: string;
  runId: string;
  genesisHash: string;
  genesisState: GraphExecutionState;
  definition: GraphDefinition;
  schedulerMetadata: SchedulerMetadata;
  graph: CompiledGraph;
}

export const MAX_GRAPH_CHECKPOINT_BYTES = 4 * 1024 * 1024;
export const MAX_GRAPH_SNAPSHOT_BYTES = 16 * 1024 * 1024;
export const MAX_GRAPH_EVENT_BYTES = 256 * 1024;
export const MAX_GRAPH_EVENT_LOG_BYTES = 32 * 1024 * 1024;
export const MAX_GRAPH_EVENTS = 8_192;
export const MAX_NODE_ARTIFACT_BYTES = 64 * 1024 * 1024;

const SHA256 = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

interface LeaseRecord {
  owner: string;
  nonce: string;
  pid: number;
  createdAt: string;
  dev: number | bigint;
  ino: number | bigint;
}

export function createGraphCheckpointPaths(root: string): GraphCheckpointPaths {
  const requestedRoot = resolve(root);
  if (existsSync(requestedRoot) && lstatSync(requestedRoot).isSymbolicLink()) {
    throw new Error("Graph checkpoint root must not be a symlink");
  }
  const absoluteRoot = existsSync(requestedRoot) ? realpathSync(requestedRoot) : requestedRoot;
  return {
    root: absoluteRoot,
    state: join(absoluteRoot, "state.json"),
    graph: join(absoluteRoot, "graph.json"),
    events: join(absoluteRoot, "events.jsonl"),
    nodes: join(absoluteRoot, "nodes"),
    executionLease: join(absoluteRoot, "execution.lock"),
  };
}

export function assertGraphCheckpointPathsSafe(paths: GraphCheckpointPaths): void {
  const root = resolve(paths.root);
  const expected: Record<Exclude<keyof GraphCheckpointPaths, "root">, string> = {
    state: join(root, "state.json"),
    graph: join(root, "graph.json"),
    events: join(root, "events.jsonl"),
    nodes: join(root, "nodes"),
    executionLease: join(root, "execution.lock"),
  };
  for (const [field, target] of Object.entries(expected) as [keyof typeof expected, string][]) {
    if (resolve(paths[field]) !== target) throw new Error(`Graph checkpoint ${field} path must remain inside its root`);
  }
  for (const target of [root, ...Object.values(expected)]) {
    assertContained(root, target);
    assertNoSymlinkComponents(target);
  }
}

export function acquireGraphCheckpointLease(
  paths: GraphCheckpointPaths,
  owner: string,
  options: LeaseOptions,
): void {
  assertOwnerToken(owner);
  assertIsoTimestamp(options.now, "lease timestamp");
  assertPositiveInteger(options.pid, "lease pid");
  assertGraphCheckpointPathsSafe(paths);
  ensureDirectoryDurable(paths.root);
  assertGraphCheckpointPathsSafe(paths);
  const nonce = options.nonce ?? randomToken();
  assertOwnerToken(nonce);
  const record = `${canonicalJson({ owner, nonce, pid: options.pid, createdAt: options.now })}\n`;
  const isAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      writeExclusiveAndSync(paths.executionLease, record);
      return;
    } catch (error) {
      if (!isNodeErrorWithCode(error, "EEXIST")) throw error;
      const existing = readLease(paths.executionLease);
      if (!existing) throw new Error("Graph checkpoint execution lease is corrupt; explicit recovery is required");
      if (existing.owner === owner) return;
      if (isAlive(existing.pid)) throw new Error(`Graph checkpoint is already executing under lease owner ${existing.owner}`);
      options.beforeStaleLeaseRemove?.();
      if (!removeLeaseIfUnchanged(paths.executionLease, existing, "reclaim")) continue;
    }
  }
  throw new Error("Graph checkpoint execution lease could not be acquired");
}

export function ownsGraphCheckpointLease(paths: GraphCheckpointPaths, owner: string): boolean {
  assertOwnerToken(owner);
  assertGraphCheckpointPathsSafe(paths);
  return readLease(paths.executionLease)?.owner === owner;
}

export function releaseGraphCheckpointLease(
  paths: GraphCheckpointPaths,
  owner: string,
  options: LeaseReleaseOptions = {},
): boolean {
  assertOwnerToken(owner);
  assertGraphCheckpointPathsSafe(paths);
  const lease = readLease(paths.executionLease);
  if (!lease || lease.owner !== owner) return false;
  options.beforeLeaseRemove?.();
  return removeLeaseIfUnchanged(paths.executionLease, lease, "release");
}

export function writeImmutableGraphCheckpoint(
  paths: GraphCheckpointPaths,
  graph: CompiledGraph,
  metadata: SchedulerMetadata,
  genesisState: Readonly<GraphExecutionState>,
  options: CheckpointMutationOptions,
): void {
  assertCheckpointOwner(paths, options.owner);
  const record = immutableGraphRecord(graph, metadata, genesisState);
  const bytes = `${canonicalJson(record)}\n`;
  if (Buffer.byteLength(bytes) > MAX_GRAPH_CHECKPOINT_BYTES) throw new Error("Immutable graph checkpoint exceeds its size limit");
  if (existsSync(paths.graph)) {
    const existing = readFileBounded(paths.graph, MAX_GRAPH_CHECKPOINT_BYTES, "immutable graph checkpoint").toString("utf8");
    if (existing === bytes) return;
    throw new Error("Refusing to mutate an existing immutable graph checkpoint");
  }
  publishImmutableAndSync(paths.graph, bytes, MAX_GRAPH_CHECKPOINT_BYTES, "immutable graph checkpoint");
}

export function readImmutableGraphCheckpoint(paths: GraphCheckpointPaths): ImmutableGraphCheckpoint {
  assertGraphCheckpointPathsSafe(paths);
  if (!existsSync(paths.graph)) throw new Error("Immutable graph checkpoint is missing");
  const bytes = readFileBounded(paths.graph, MAX_GRAPH_CHECKPOINT_BYTES, "immutable graph checkpoint").toString("utf8");
  if (!bytes.endsWith("\n")) throw new Error("Immutable graph checkpoint is partial or corrupt");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    throw new Error("Immutable graph checkpoint is corrupt JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Immutable graph checkpoint is invalid");
  const record = parsed as Record<string, unknown>;
  assertExactKeys(record, [
    "schemaVersion", "graphDigest", "metadataFingerprint", "runId", "genesisHash", "genesisState", "definition", "schedulerMetadata",
  ], "immutable graph checkpoint");
  if (record.schemaVersion !== 1 || typeof record.graphDigest !== "string" || !SHA256.test(record.graphDigest) ||
      typeof record.metadataFingerprint !== "string" || !SHA256.test(record.metadataFingerprint) ||
      typeof record.genesisHash !== "string" || !SHA256.test(record.genesisHash)) {
    throw new Error("Immutable graph checkpoint identity is invalid");
  }
  assertToken(record.runId, "immutable graph checkpoint run id");
  let graph: CompiledGraph;
  try {
    graph = compileGraph(record.definition as GraphDefinition);
  } catch (error) {
    throw new Error(`Immutable graph checkpoint definition is invalid: ${errorMessage(error)}`);
  }
  const schedulerMetadata = record.schedulerMetadata as SchedulerMetadata;
  const genesisState = record.genesisState as GraphExecutionState;
  const graphDigest = graphDefinitionDigest(graph);
  const metadataFingerprint = schedulerMetadataFingerprint(schedulerMetadata);
  if (record.graphDigest !== graphDigest || record.metadataFingerprint !== metadataFingerprint) {
    throw new Error("Immutable graph checkpoint digest validation failed");
  }
  assertGenesisState(graph, schedulerMetadata, genesisState, record.runId);
  if (record.genesisHash !== graphSnapshotDigest(genesisState)) throw new Error("Immutable graph checkpoint genesis hash is invalid");
  const canonical = `${canonicalJson(immutableGraphRecord(graph, schedulerMetadata, genesisState))}\n`;
  if (canonical !== bytes) throw new Error("Immutable graph checkpoint bytes are not canonical");
  return {
    schemaVersion: 1,
    graphDigest,
    metadataFingerprint,
    runId: record.runId,
    genesisHash: record.genesisHash,
    genesisState: cloneJson(genesisState),
    definition: graph.definition as GraphDefinition,
    schedulerMetadata,
    graph,
  };
}

export function writeNodeArtifact(
  paths: GraphCheckpointPaths,
  input: {
    owner: string;
    planVersion: number;
    nodeId: string;
    contract: string;
    bytes: Uint8Array;
  },
): ArtifactReference {
  assertCheckpointOwner(paths, input.owner);
  assertPositiveInteger(input.planVersion, "artifact plan version");
  assertToken(input.nodeId, "artifact node id");
  assertContract(input.contract);
  const bytes = Buffer.from(input.bytes);
  if (bytes.byteLength > MAX_NODE_ARTIFACT_BYTES) throw new Error("Node artifact exceeds its size limit");
  const digest = sha256(bytes);
  const fileName = `${sha256(Buffer.from(input.contract, "utf8"))}-${digest}.artifact`;
  const relativePath = `nodes/${input.planVersion}/${input.nodeId}/${fileName}`;
  const target = checkpointRelativePath(paths, relativePath);
  ensureDirectoryDurable(dirname(target));
  assertGraphCheckpointPathsSafe(paths);
  assertNoSymlinkComponents(target);
  if (existsSync(target)) {
    const existing = readFileBounded(target, MAX_NODE_ARTIFACT_BYTES, "node artifact");
    if (!existing.equals(bytes)) throw new Error("Refusing to mutate an existing immutable node artifact");
  } else {
    publishImmutableAndSync(target, bytes, MAX_NODE_ARTIFACT_BYTES, "node artifact");
  }
  return {
    planVersion: input.planVersion,
    nodeId: input.nodeId,
    contract: input.contract,
    path: relativePath,
    sha256: digest,
    sizeBytes: bytes.byteLength,
  };
}

export function readNodeArtifact(paths: GraphCheckpointPaths, reference: Readonly<ArtifactReference>): Buffer {
  assertGraphCheckpointPathsSafe(paths);
  assertArtifactReference(reference);
  const expectedPrefix = `nodes/${reference.planVersion}/${reference.nodeId}/`;
  if (!reference.path.startsWith(expectedPrefix)) throw new Error("Node artifact reference is outside its plan/node directory");
  const target = checkpointRelativePath(paths, reference.path);
  const bytes = readFileBounded(target, MAX_NODE_ARTIFACT_BYTES, "node artifact");
  if (bytes.byteLength !== reference.sizeBytes) throw new Error("Node artifact size does not match its reference");
  if (sha256(bytes) !== reference.sha256) throw new Error("Node artifact SHA-256 does not match its reference");
  return bytes;
}

export function appendGraphEvent(
  paths: GraphCheckpointPaths,
  event: Readonly<GraphEvent>,
  options: CheckpointMutationOptions,
): void {
  assertCheckpointOwner(paths, options.owner);
  assertGraphEventValid(event);
  const checkpoint = readImmutableGraphCheckpoint(paths);
  assertEventMatchesCheckpoint(checkpoint, event);
  const existing = readGraphEvents(paths);
  if (event.sequence <= existing.length) {
    const prior = existing[event.sequence - 1];
    if (prior && prior.eventId === event.eventId && graphEventDigest(prior) === graphEventDigest(event)) return;
    throw new Error(`Graph event log has a conflicting duplicate sequence ${event.sequence}`);
  }
  if (event.sequence !== existing.length + 1) {
    throw new Error(`Graph event sequence ${event.sequence} is out of order; expected ${existing.length + 1}`);
  }
  if (existing.some((prior) => prior.eventId === event.eventId)) throw new Error(`Graph event log contains duplicate event id ${event.eventId}`);
  const previousTimestamp = existing.at(-1)?.timestamp ?? checkpoint.genesisState.guard.startedAt;
  if (Date.parse(event.timestamp) < Date.parse(previousTimestamp)) {
    throw new Error("Graph event timestamp predates the last durable event");
  }
  const priorState = replayFromGenesis(checkpoint, existing);
  applySchedulerEvent(checkpoint.graph, priorState, event, checkpoint.schedulerMetadata);
  if (existing.length >= MAX_GRAPH_EVENTS) throw new Error("Graph event log exceeds its record limit");
  const line = `${canonicalJson(event)}\n`;
  const lineBytes = Buffer.byteLength(line);
  if (lineBytes > MAX_GRAPH_EVENT_BYTES) throw new Error("Graph event record exceeds its record limit");
  appendAndSync(paths.events, line, MAX_GRAPH_EVENT_LOG_BYTES);
}

export function readGraphEvents(paths: GraphCheckpointPaths): GraphEvent[] {
  assertGraphCheckpointPathsSafe(paths);
  if (!existsSync(paths.events)) return [];
  const bytes = readFileBounded(paths.events, MAX_GRAPH_EVENT_LOG_BYTES, "graph event log");
  if (bytes.byteLength === 0) return [];
  const checkpoint = readImmutableGraphCheckpoint(paths);
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n")) throw new Error("Graph event log has a partial final record; explicit recovery is required");
  const lines = text.slice(0, -1).split("\n");
  if (lines.length > MAX_GRAPH_EVENTS) throw new Error("Graph event log exceeds its record limit");
  const events: GraphEvent[] = [];
  const eventIds = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (Buffer.byteLength(`${line}\n`) > MAX_GRAPH_EVENT_BYTES) throw new Error(`Graph event record ${index + 1} exceeds its record limit`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
      assertGraphEventValid(parsed);
    } catch (error) {
      throw new Error(`Graph event log is corrupt at record ${index + 1}: ${errorMessage(error)}`);
    }
    if (parsed.sequence !== index + 1) throw new Error(`Graph event log is out of order at sequence ${parsed.sequence}; expected ${index + 1}`);
    if (eventIds.has(parsed.eventId)) throw new Error(`Graph event log contains duplicate event id ${parsed.eventId}`);
    eventIds.add(parsed.eventId);
    assertEventMatchesCheckpoint(checkpoint, parsed);
    if (events.length > 0) {
      assertSameRunIdentity(events[0]!, parsed);
      if (Date.parse(parsed.timestamp) < Date.parse(events.at(-1)!.timestamp)) {
        throw new Error(`Graph event log timestamp is out of order at sequence ${parsed.sequence}`);
      }
    } else if (Date.parse(parsed.timestamp) < Date.parse(checkpoint.genesisState.guard.startedAt)) {
      throw new Error("Graph event log begins before scheduler genesis");
    }
    events.push(parsed);
  }
  replayFromGenesis(checkpoint, events);
  return events;
}

export function writeGraphSnapshot(
  paths: GraphCheckpointPaths,
  graph: CompiledGraph,
  state: Readonly<GraphExecutionState>,
  options: SnapshotWriteOptions,
): void {
  assertCheckpointOwner(paths, options.owner);
  assertToken(options.tempId, "snapshot temp id");
  const checkpoint = readImmutableGraphCheckpoint(paths);
  assertSuppliedGraph(checkpoint, graph);
  validateSnapshotPrefix(checkpoint, state, readGraphEvents(paths));
  const bytes = `${canonicalJson(state)}\n`;
  if (Buffer.byteLength(bytes) > MAX_GRAPH_SNAPSHOT_BYTES) throw new Error("Graph snapshot exceeds its size limit");
  if (existsSync(paths.state)) {
    const current = readGraphSnapshot(paths, graph);
    const currentBytes = `${canonicalJson(current)}\n`;
    if (currentBytes === bytes) return;
    if (options.expectedRevision === undefined) throw new Error("Graph snapshot overwrite requires an expected revision");
    if (options.expectedSnapshotHash === undefined || !SHA256.test(options.expectedSnapshotHash)) {
      throw new Error("Graph snapshot overwrite requires an expected snapshot hash");
    }
    if (current.revision !== options.expectedRevision) {
      throw new Error(`Graph snapshot revision conflict: expected ${options.expectedRevision}, found ${current.revision}`);
    }
    if (graphSnapshotDigest(current) !== options.expectedSnapshotHash) {
      throw new Error("Graph snapshot compare-and-swap conflict: current state differs from the expected snapshot");
    }
  } else if (options.expectedRevision !== undefined) {
    throw new Error("Graph snapshot revision conflict: no prior snapshot exists");
  }

  const tempPath = `${paths.state}.${options.tempId}.tmp`;
  assertContained(paths.root, tempPath);
  assertNoSymlinkComponents(tempPath);
  let renamed = false;
  try {
    writeExclusiveAndSync(tempPath, bytes);
    options.failAt?.("after-snapshot-temp-write");
    assertCheckpointOwner(paths, options.owner);
    renameSync(tempPath, paths.state);
    renamed = true;
    fsyncDirectory(dirname(paths.state));
    options.failAt?.("after-snapshot-rename");
  } finally {
    if (!renamed) rmSync(tempPath, { force: true });
  }
}

export function readGraphSnapshot(paths: GraphCheckpointPaths, graph?: CompiledGraph): GraphExecutionState {
  const checkpoint = readImmutableGraphCheckpoint(paths);
  if (graph) assertSuppliedGraph(checkpoint, graph);
  const state = readSnapshotUnchecked(paths);
  try {
    validateSnapshotPrefix(checkpoint, state, readGraphEvents(paths));
  } catch (error) {
    throw new Error(`Graph snapshot is invalid: ${errorMessage(error)}`);
  }
  return state;
}

export function replayGraphEvents(
  graph: CompiledGraph,
  snapshot: Readonly<GraphExecutionState>,
  events: readonly Readonly<GraphEvent>[],
  genesis?: Readonly<GraphExecutionState>,
): GraphExecutionState {
  assertScheduleValid(graph, snapshot);
  assertEventArray(events);
  if (snapshot.lastAppliedEventSequence > events.length) throw new Error("Graph snapshot is ahead of its event log");
  if (snapshot.lastAppliedEventSequence > 0) {
    const applied = events[snapshot.lastAppliedEventSequence - 1]!;
    if (applied.eventId !== snapshot.lastAppliedEventId || graphEventDigest(applied) !== snapshot.lastAppliedEventHash) {
      throw new Error("Graph snapshot event tail does not match the event log");
    }
  }
  if (genesis) {
    assertScheduleValid(graph, genesis);
    if (genesis.lastAppliedEventSequence !== 0) throw new Error("Graph replay genesis must be at event sequence zero");
    let expected = cloneJson(genesis);
    for (const event of events.slice(0, snapshot.lastAppliedEventSequence)) expected = applySchedulerEvent(graph, expected, event);
    if (canonicalJson(expected) !== canonicalJson(snapshot)) throw new Error("Graph snapshot does not match full replay from immutable genesis");
  }
  let state = cloneJson(snapshot);
  for (const event of events.slice(snapshot.lastAppliedEventSequence)) state = applySchedulerEvent(graph, state, event);
  return state;
}

export function graphSnapshotDigest(state: Readonly<GraphExecutionState>): string {
  return sha256(Buffer.from(canonicalJson(state), "utf8"));
}

export function checkpointGraphEvent(input: {
  graph: CompiledGraph;
  paths: GraphCheckpointPaths;
  state: Readonly<GraphExecutionState>;
  event: Readonly<GraphEvent>;
  owner: string;
  tempId: string;
  failAt?(point: CheckpointFailurePoint): void;
}): GraphExecutionState {
  assertCheckpointOwner(input.paths, input.owner);
  const current = readGraphSnapshot(input.paths, input.graph);
  if (canonicalJson(current) !== canonicalJson(input.state)) {
    throw new Error("Graph checkpoint input state does not match the current durable snapshot");
  }
  const next = applySchedulerEvent(input.graph, input.state, input.event);
  appendGraphEvent(input.paths, input.event, { owner: input.owner });
  input.failAt?.("after-event-append");
  writeGraphSnapshot(input.paths, input.graph, next, {
    owner: input.owner,
    tempId: input.tempId,
    expectedRevision: input.state.revision,
    expectedSnapshotHash: graphSnapshotDigest(input.state),
    failAt: input.failAt,
  });
  return next;
}

function immutableGraphRecord(
  graph: CompiledGraph,
  metadata: SchedulerMetadata,
  genesisState: Readonly<GraphExecutionState>,
): Omit<ImmutableGraphCheckpoint, "graph"> {
  const schedulerMetadata = normalizeMetadata(metadata);
  for (const nodeId of Object.keys(schedulerMetadata.priorities ?? {})) {
    if (!graph.nodesById.has(nodeId)) throw new Error(`Scheduler metadata references unknown graph node ${nodeId}`);
  }
  assertGenesisState(graph, schedulerMetadata, genesisState, genesisState.runId);
  return {
    schemaVersion: 1,
    graphDigest: graphDefinitionDigest(graph),
    metadataFingerprint: schedulerMetadataFingerprint(schedulerMetadata),
    runId: genesisState.runId,
    genesisHash: graphSnapshotDigest(genesisState),
    genesisState: cloneJson(genesisState),
    definition: graph.definition as GraphDefinition,
    schedulerMetadata,
  };
}

function normalizeMetadata(metadata: SchedulerMetadata): SchedulerMetadata {
  schedulerMetadataFingerprint(metadata);
  const priorities = Object.fromEntries(Object.entries(metadata.priorities ?? {}).sort(([left], [right]) => left.localeCompare(right)));
  return Object.keys(priorities).length > 0 ? { priorities } : {};
}

function assertGenesisState(
  graph: CompiledGraph,
  metadata: SchedulerMetadata,
  state: Readonly<GraphExecutionState>,
  runId: unknown,
): asserts runId is string {
  assertToken(runId, "immutable graph checkpoint run id");
  assertScheduleValid(graph, state, metadata);
  if (state.runId !== runId) throw new Error("Immutable graph checkpoint genesis is not bound to its run id");
  if (state.revision !== 0 || state.lastAppliedEventSequence !== 0) {
    throw new Error("Immutable graph checkpoint genesis must be at revision zero");
  }
  const activated = Object.values(state.nodeStates).filter((node) => node.visits === 1);
  if (activated.length !== 1) throw new Error("Immutable graph checkpoint genesis must activate exactly one node");
  const expected = createGraphExecutionState(graph, {
    runId,
    now: state.guard.startedAt,
    limits: state.effectiveLimits,
    planVersion: state.planVersion,
    currentNodeId: activated[0]!.nodeId,
    metadata,
  });
  if (canonicalJson(expected) !== canonicalJson(state)) {
    throw new Error("Immutable graph checkpoint genesis is not a canonical scheduler genesis");
  }
}

function assertSuppliedGraph(checkpoint: ImmutableGraphCheckpoint, graph: CompiledGraph): void {
  if (graphDefinitionDigest(graph) !== checkpoint.graphDigest || graph.definition.id !== checkpoint.graph.definition.id ||
      graph.definition.version !== checkpoint.graph.definition.version) {
    throw new Error("Supplied graph does not match the immutable graph checkpoint");
  }
}

function assertEventMatchesCheckpoint(checkpoint: ImmutableGraphCheckpoint, event: Readonly<GraphEvent>): void {
  if (event.runId !== checkpoint.runId || event.graphId !== checkpoint.graph.definition.id ||
      event.graphVersion !== checkpoint.graph.definition.version || event.graphDigest !== checkpoint.graphDigest ||
      event.planVersion !== checkpoint.genesisState.planVersion) {
    throw new Error("Graph event does not match its immutable graph checkpoint identity");
  }
}

function replayFromGenesis(
  checkpoint: ImmutableGraphCheckpoint,
  events: readonly Readonly<GraphEvent>[],
): GraphExecutionState {
  let state = cloneJson(checkpoint.genesisState);
  for (const event of events) state = applySchedulerEvent(checkpoint.graph, state, event, checkpoint.schedulerMetadata);
  return state;
}

function validateSnapshotPrefix(
  checkpoint: ImmutableGraphCheckpoint,
  snapshot: Readonly<GraphExecutionState>,
  events: readonly Readonly<GraphEvent>[],
): void {
  assertScheduleValid(checkpoint.graph, snapshot, checkpoint.schedulerMetadata);
  if (snapshot.runId !== checkpoint.runId) throw new Error("Graph snapshot run id does not match immutable genesis");
  if (snapshot.lastAppliedEventSequence > events.length) throw new Error("Graph snapshot is ahead of its event log");
  const expected = replayFromGenesis(checkpoint, events.slice(0, snapshot.lastAppliedEventSequence));
  if (canonicalJson(expected) !== canonicalJson(snapshot)) {
    throw new Error("Graph snapshot does not exactly match replay from immutable genesis");
  }
}

function readSnapshotUnchecked(paths: GraphCheckpointPaths): GraphExecutionState {
  assertGraphCheckpointPathsSafe(paths);
  if (!existsSync(paths.state)) throw new Error("Graph snapshot is missing");
  const bytes = readFileBounded(paths.state, MAX_GRAPH_SNAPSHOT_BYTES, "graph snapshot").toString("utf8");
  if (!bytes.endsWith("\n")) throw new Error("Graph snapshot is partial or corrupt");
  try {
    return JSON.parse(bytes) as GraphExecutionState;
  } catch {
    throw new Error("Graph snapshot is corrupt JSON");
  }
}

function assertEventArray(events: readonly Readonly<GraphEvent>[]): void {
  const ids = new Set<string>();
  events.forEach((event, index) => {
    assertGraphEventValid(event);
    if (event.sequence !== index + 1) throw new Error(`Graph events are out of order at sequence ${event.sequence}`);
    if (ids.has(event.eventId)) throw new Error(`Graph events contain duplicate event id ${event.eventId}`);
    ids.add(event.eventId);
    if (index > 0) assertSameRunIdentity(events[0]!, event);
  });
}

function assertSameRunIdentity(first: Readonly<GraphEvent>, next: Readonly<GraphEvent>): void {
  if (first.runId !== next.runId || first.graphId !== next.graphId || first.graphVersion !== next.graphVersion || first.graphDigest !== next.graphDigest) {
    throw new Error("Graph event log mixes run or graph identities");
  }
}

function assertCheckpointOwner(paths: GraphCheckpointPaths, owner: string): void {
  assertOwnerToken(owner);
  assertGraphCheckpointPathsSafe(paths);
  const lease = readLease(paths.executionLease);
  if (!lease || lease.owner !== owner) throw new Error(`Graph checkpoint mutation requires current lease owner ${owner}`);
}

function readLease(path: string): LeaseRecord | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const read = readFileBoundedWithIdentity(path, 16 * 1024, "graph checkpoint lease");
    const value = JSON.parse(read.bytes.toString("utf8")) as Record<string, unknown>;
    assertExactKeys(value, ["owner", "nonce", "pid", "createdAt"], "graph checkpoint lease");
    if (typeof value.owner !== "string" || !TOKEN.test(value.owner) || typeof value.nonce !== "string" || !TOKEN.test(value.nonce) ||
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

function sameLeaseIdentity(left: LeaseRecord, right: LeaseRecord): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.nonce === right.nonce && left.owner === right.owner;
}

function removeLeaseIfUnchanged(path: string, observed: LeaseRecord, operation: "reclaim" | "release"): boolean {
  const current = readLease(path);
  if (!current || !sameLeaseIdentity(current, observed)) return false;
  const quarantine = `${path}.${operation}.${randomToken()}.tmp`;
  assertNoSymlinkComponents(quarantine);
  try {
    renameSync(path, quarantine);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) return false;
    throw error;
  }
  fsyncDirectory(dirname(path));
  const moved = readLease(quarantine);
  if (!moved || !sameLeaseIdentity(moved, observed)) {
    restoreMovedLease(path, quarantine);
    return false;
  }
  unlinkSync(quarantine);
  fsyncDirectory(dirname(path));
  return true;
}

function restoreMovedLease(path: string, quarantine: string): void {
  try {
    linkSync(quarantine, path);
    fsyncDirectory(dirname(path));
    unlinkSync(quarantine);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if (!isNodeErrorWithCode(error, "EEXIST")) throw error;
    throw new Error(`Graph checkpoint lease changed during mutation; replacement preserved at ${quarantine}; explicit recovery is required`);
  }
}

function checkpointRelativePath(paths: GraphCheckpointPaths, relativePath: string): string {
  if (!isSafeRelativePath(relativePath)) throw new Error("Graph checkpoint relative path is invalid");
  const target = resolve(paths.root, ...relativePath.split("/"));
  assertContained(paths.root, target);
  assertNoSymlinkComponents(target);
  return target;
}

function assertArtifactReference(reference: Readonly<ArtifactReference>): void {
  assertPositiveInteger(reference.planVersion, "artifact reference plan version");
  assertToken(reference.nodeId, "artifact reference node id");
  assertContract(reference.contract);
  if (!isSafeRelativePath(reference.path)) throw new Error("Artifact reference path is invalid");
  if (!SHA256.test(reference.sha256)) throw new Error("Artifact reference SHA-256 is invalid");
  assertNonNegativeInteger(reference.sizeBytes, "artifact reference size");
  if (reference.sizeBytes > MAX_NODE_ARTIFACT_BYTES) throw new Error("Artifact reference size exceeds its limit");
}

function assertContract(value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Artifact contract is invalid");
  }
}

function readFileBounded(path: string, limit: number, label: string): Buffer {
  return readFileBoundedWithIdentity(path, limit, label).bytes;
}

function readFileBoundedWithIdentity(
  path: string,
  limit: number,
  label: string,
): { bytes: Buffer; dev: number | bigint; ino: number | bigint } {
  assertNoSymlinkComponents(path);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > limit) throw new Error(`${label} is oversized and exceeds its limit`);
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= limit) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.byteLength, null);
      if (count === 0) break;
      chunks.push(chunk.subarray(0, count));
      total += count;
    }
    const after = fstatSync(fd);
    if (total > limit) throw new Error(`${label} is oversized and exceeds its limit`);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || total !== after.size) {
      throw new Error(`${label} changed while it was being read; explicit recovery is required`);
    }
    return { bytes: Buffer.concat(chunks, total), dev: after.dev, ino: after.ino };
  } finally {
    closeSync(fd);
  }
}

function writeExclusiveAndSync(path: string, data: string | Uint8Array): void {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    writeAll(fd, Buffer.from(data));
    if (!fstatSync(fd).isFile()) throw new Error("Checkpoint target is not a regular file");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(dirname(path));
}

function publishImmutableAndSync(path: string, data: string | Uint8Array, limit: number, label: string): void {
  const bytes = Buffer.from(data);
  const temp = `${path}.publish.${randomToken()}.tmp`;
  let published = false;
  try {
    writeExclusiveAndSync(temp, bytes);
    try {
      linkSync(temp, path);
      published = true;
      fsyncDirectory(dirname(path));
    } catch (error) {
      if (!isNodeErrorWithCode(error, "EEXIST")) throw error;
      const existing = readFileBounded(path, limit, label);
      if (!existing.equals(bytes)) throw new Error(`Refusing to mutate an existing ${label}`);
    }
  } finally {
    try {
      unlinkSync(temp);
      fsyncDirectory(dirname(temp));
    } catch (error) {
      if (!isNodeErrorWithCode(error, "ENOENT")) throw error;
    }
  }
  if (!published) {
    const existing = readFileBounded(path, limit, label);
    if (!existing.equals(bytes)) throw new Error(`Refusing to mutate an existing ${label}`);
  }
}

function appendAndSync(path: string, data: string, limit: number): void {
  const fd = openSync(
    path,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error("Graph event log must be a regular file");
    const bytes = Buffer.from(data);
    if (before.size + bytes.byteLength > limit) throw new Error("Graph event log exceeds its file limit");
    writeAll(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(dirname(path));
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset, null);
    if (written <= 0) throw new Error("Checkpoint write made no progress");
    offset += written;
  }
}

function ensureDirectoryDurable(path: string): void {
  const absolute = resolve(path);
  assertNoSymlinkComponents(absolute);
  if (existsSync(absolute)) {
    if (!lstatSync(absolute).isDirectory()) throw new Error(`Checkpoint directory is not a directory: ${absolute}`);
    return;
  }
  const parent = dirname(absolute);
  if (parent === absolute) throw new Error(`Cannot create checkpoint directory: ${absolute}`);
  ensureDirectoryDurable(parent);
  try {
    mkdirSync(absolute, { mode: 0o700 });
  } catch (error) {
    if (!isNodeErrorWithCode(error, "EEXIST")) throw error;
    if (!lstatSync(absolute).isDirectory()) throw error;
  }
  fsyncDirectory(parent);
  fsyncDirectory(absolute);
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function randomToken(): string {
  return randomBytes(16).toString("hex");
}

function canonicalJson(value: unknown): string {
  const json = JSON.stringify(canonicalValue(value));
  if (json === undefined) throw new Error("Cannot canonicalize undefined checkpoint data");
  return json;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => item === undefined ? null : canonicalValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  return value;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertExpectedRoot(root: string): void {
  if (!isAbsolute(root)) throw new Error("Graph checkpoint root must be absolute");
}

function assertContained(root: string, target: string): void {
  const absoluteRoot = resolve(root);
  assertExpectedRoot(absoluteRoot);
  const contained = relative(absoluteRoot, resolve(target));
  if (contained.startsWith("..") || isAbsolute(contained)) throw new Error("Graph checkpoint path escapes its root");
}

function assertNoSymlinkComponents(target: string): void {
  const absolute = resolve(target);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Graph checkpoint path must not contain symlinks: ${current}`);
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) return;
      throw error;
    }
  }
}

function isSafeRelativePath(value: string): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024 || value.startsWith("/") || value.startsWith("\\") ||
      /^[A-Za-z]:/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return false;
  return value.split(/[\\/]+/).every((part) => part.length > 0 && part !== "." && part !== "..");
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} contains unexpected or missing fields`);
  }
}

function assertOwnerToken(value: string): void {
  if (typeof value !== "string" || !TOKEN.test(value)) throw new Error("Graph checkpoint owner must be a bounded token");
}

function assertToken(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !TOKEN.test(value)) throw new Error(`${label} must be a bounded token`);
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive integer`);
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`);
}

function assertIsoTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !isIsoTimestamp(value)) throw new Error(`${label} must be an ISO timestamp`);
}

function isIsoTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function defaultIsProcessAlive(pid: number): boolean {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
