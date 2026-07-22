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
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { compileGraph, type CompiledGraph, type GraphDefinition } from "../core/graph.js";
import {
  applySchedulerEvent,
  assertGraphEventValid,
  assertScheduleValid,
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
  failAt?(point: CheckpointFailurePoint): void;
}

export interface LeaseOptions {
  now: string;
  pid: number;
  isProcessAlive?(pid: number): boolean;
}

export interface ImmutableGraphCheckpoint {
  schemaVersion: 1;
  graphDigest: string;
  metadataFingerprint: string;
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
  mkdirSync(paths.root, { recursive: true });
  assertGraphCheckpointPathsSafe(paths);
  const record = `${canonicalJson({ owner, pid: options.pid, createdAt: options.now })}\n`;
  const isAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeExclusiveAndSync(paths.executionLease, record);
      return;
    } catch (error) {
      if (!isNodeErrorWithCode(error, "EEXIST")) throw error;
      const existing = readLease(paths.executionLease);
      if (!existing) throw new Error("Graph checkpoint execution lease is corrupt; explicit recovery is required");
      if (existing.owner === owner) return;
      if (isAlive(existing.pid)) throw new Error(`Graph checkpoint is already executing under lease owner ${existing.owner}`);
      rmSync(paths.executionLease, { force: true });
    }
  }
  throw new Error("Graph checkpoint execution lease could not be acquired");
}

export function ownsGraphCheckpointLease(paths: GraphCheckpointPaths, owner: string): boolean {
  assertOwnerToken(owner);
  assertGraphCheckpointPathsSafe(paths);
  return readLease(paths.executionLease)?.owner === owner;
}

export function releaseGraphCheckpointLease(paths: GraphCheckpointPaths, owner: string): boolean {
  assertOwnerToken(owner);
  assertGraphCheckpointPathsSafe(paths);
  if (readLease(paths.executionLease)?.owner !== owner) return false;
  rmSync(paths.executionLease, { force: true });
  return true;
}

export function writeImmutableGraphCheckpoint(
  paths: GraphCheckpointPaths,
  graph: CompiledGraph,
  metadata: SchedulerMetadata,
  options: CheckpointMutationOptions,
): void {
  assertCheckpointOwner(paths, options.owner);
  const record = immutableGraphRecord(graph, metadata);
  const bytes = `${canonicalJson(record)}\n`;
  if (Buffer.byteLength(bytes) > MAX_GRAPH_CHECKPOINT_BYTES) throw new Error("Immutable graph checkpoint exceeds its size limit");
  if (existsSync(paths.graph)) {
    const existing = readFileBounded(paths.graph, MAX_GRAPH_CHECKPOINT_BYTES, "immutable graph checkpoint").toString("utf8");
    if (existing === bytes) return;
    throw new Error("Refusing to mutate an existing immutable graph checkpoint");
  }
  writeExclusiveAndSync(paths.graph, bytes);
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
  assertExactKeys(record, ["schemaVersion", "graphDigest", "metadataFingerprint", "definition", "schedulerMetadata"], "immutable graph checkpoint");
  if (record.schemaVersion !== 1 || typeof record.graphDigest !== "string" || !SHA256.test(record.graphDigest) ||
      typeof record.metadataFingerprint !== "string" || !SHA256.test(record.metadataFingerprint)) {
    throw new Error("Immutable graph checkpoint identity is invalid");
  }
  let graph: CompiledGraph;
  try {
    graph = compileGraph(record.definition as GraphDefinition);
  } catch (error) {
    throw new Error(`Immutable graph checkpoint definition is invalid: ${errorMessage(error)}`);
  }
  const schedulerMetadata = record.schedulerMetadata as SchedulerMetadata;
  const graphDigest = graphDefinitionDigest(graph);
  const metadataFingerprint = schedulerMetadataFingerprint(schedulerMetadata);
  if (record.graphDigest !== graphDigest || record.metadataFingerprint !== metadataFingerprint) {
    throw new Error("Immutable graph checkpoint digest validation failed");
  }
  const canonical = `${canonicalJson(immutableGraphRecord(graph, schedulerMetadata))}\n`;
  if (canonical !== bytes) throw new Error("Immutable graph checkpoint bytes are not canonical");
  return {
    schemaVersion: 1,
    graphDigest,
    metadataFingerprint,
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
  const fileName = `${sha256(Buffer.from(input.contract, "utf8"))}.artifact`;
  const relativePath = `nodes/${input.planVersion}/${input.nodeId}/${fileName}`;
  const target = checkpointRelativePath(paths, relativePath);
  mkdirSync(join(target, ".."), { recursive: true });
  assertGraphCheckpointPathsSafe(paths);
  assertNoSymlinkComponents(target);
  if (existsSync(target)) {
    const existing = readFileBounded(target, MAX_NODE_ARTIFACT_BYTES, "node artifact");
    if (!existing.equals(bytes)) throw new Error("Refusing to mutate an existing immutable node artifact");
  } else {
    writeExclusiveAndSync(target, bytes);
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
  if (existing.length >= MAX_GRAPH_EVENTS) throw new Error("Graph event log exceeds its record limit");
  const line = `${canonicalJson(event)}\n`;
  const lineBytes = Buffer.byteLength(line);
  if (lineBytes > MAX_GRAPH_EVENT_BYTES) throw new Error("Graph event record exceeds its record limit");
  const currentBytes = existsSync(paths.events) ? statSync(paths.events).size : 0;
  if (currentBytes + lineBytes > MAX_GRAPH_EVENT_LOG_BYTES) throw new Error("Graph event log exceeds its file limit");
  appendAndSync(paths.events, line);
}

export function readGraphEvents(paths: GraphCheckpointPaths): GraphEvent[] {
  assertGraphCheckpointPathsSafe(paths);
  if (!existsSync(paths.events)) return [];
  const bytes = readFileBounded(paths.events, MAX_GRAPH_EVENT_LOG_BYTES, "graph event log");
  if (bytes.byteLength === 0) return [];
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
    if (events.length > 0) assertSameRunIdentity(events[0]!, parsed);
    events.push(parsed);
  }
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
  assertScheduleValid(graph, state);
  const bytes = `${canonicalJson(state)}\n`;
  if (Buffer.byteLength(bytes) > MAX_GRAPH_SNAPSHOT_BYTES) throw new Error("Graph snapshot exceeds its size limit");
  if (existsSync(paths.state)) {
    const current = readGraphSnapshot(paths, graph);
    const currentBytes = `${canonicalJson(current)}\n`;
    if (currentBytes === bytes) return;
    if (options.expectedRevision === undefined) throw new Error("Graph snapshot overwrite requires an expected revision");
    if (current.revision !== options.expectedRevision) {
      throw new Error(`Graph snapshot revision conflict: expected ${options.expectedRevision}, found ${current.revision}`);
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

export function readGraphSnapshot(paths: GraphCheckpointPaths, graph: CompiledGraph): GraphExecutionState {
  const state = readSnapshotUnchecked(paths);
  try {
    assertScheduleValid(graph, state);
  } catch (error) {
    throw new Error(`Graph snapshot is invalid: ${errorMessage(error)}`);
  }
  return state;
}

export function replayGraphEvents(
  graph: CompiledGraph,
  snapshot: Readonly<GraphExecutionState>,
  events: readonly Readonly<GraphEvent>[],
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
  let state = cloneJson(snapshot);
  for (const event of events.slice(snapshot.lastAppliedEventSequence)) state = applySchedulerEvent(graph, state, event);
  return state;
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
  const next = applySchedulerEvent(input.graph, input.state, input.event);
  appendGraphEvent(input.paths, input.event, { owner: input.owner });
  input.failAt?.("after-event-append");
  writeGraphSnapshot(input.paths, input.graph, next, {
    owner: input.owner,
    tempId: input.tempId,
    expectedRevision: input.state.revision,
    failAt: input.failAt,
  });
  return next;
}

function immutableGraphRecord(graph: CompiledGraph, metadata: SchedulerMetadata): Omit<ImmutableGraphCheckpoint, "graph"> {
  const schedulerMetadata = normalizeMetadata(metadata);
  for (const nodeId of Object.keys(schedulerMetadata.priorities ?? {})) {
    if (!graph.nodesById.has(nodeId)) throw new Error(`Scheduler metadata references unknown graph node ${nodeId}`);
  }
  return {
    schemaVersion: 1,
    graphDigest: graphDefinitionDigest(graph),
    metadataFingerprint: schedulerMetadataFingerprint(schedulerMetadata),
    definition: graph.definition as GraphDefinition,
    schedulerMetadata,
  };
}

function normalizeMetadata(metadata: SchedulerMetadata): SchedulerMetadata {
  schedulerMetadataFingerprint(metadata);
  const priorities = Object.fromEntries(Object.entries(metadata.priorities ?? {}).sort(([left], [right]) => left.localeCompare(right)));
  return Object.keys(priorities).length > 0 ? { priorities } : {};
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

function readLease(path: string): { owner: string; pid: number; createdAt: string } | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileBounded(path, 16 * 1024, "graph checkpoint lease").toString("utf8")) as Record<string, unknown>;
    if (typeof value.owner !== "string" || !TOKEN.test(value.owner) || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 ||
        typeof value.createdAt !== "string" || !isIsoTimestamp(value.createdAt)) return undefined;
    return { owner: value.owner, pid: value.pid as number, createdAt: value.createdAt };
  } catch {
    return undefined;
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
    return Buffer.concat(chunks, total);
  } finally {
    closeSync(fd);
  }
}

function writeExclusiveAndSync(path: string, data: string | Uint8Array): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(dirname(path));
}

function appendAndSync(path: string, data: string): void {
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(dirname(path));
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
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
