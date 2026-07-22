import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileGraph, type GraphDefinition } from "../src/core/graph.js";
import {
  DEFAULT_EXECUTION_LIMITS,
  createGraphExecutionState,
  type GraphEvent,
  type GraphExecutionState,
} from "../src/core/scheduler.js";
import {
  acquireGraphCheckpointLease,
  appendGraphEvent,
  checkpointGraphEvent,
  createGraphCheckpointPaths,
  graphSnapshotDigest,
  ownsGraphCheckpointLease,
  readGraphEvents,
  readGraphSnapshot,
  readImmutableGraphCheckpoint,
  readNodeArtifact,
  releaseGraphCheckpointLease,
  replayGraphEvents,
  writeGraphSnapshot,
  writeImmutableGraphCheckpoint,
  writeNodeArtifact,
} from "../src/runtime/graphCheckpoint.js";

const now = "2026-07-22T00:00:00.000Z";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  return compileGraph({
    schemaVersion: 1,
    id: "checkpoint-graph",
    version: "1",
    kind: "dag",
    entry: "start",
    nodes: [
      {
        id: "start", handler: "start-handler", inputContracts: [], outputContracts: ["result"],
        sideEffect: "read", timeoutMs: 1_000, retryBudget: 1,
      },
      {
        id: "done", handler: "done-handler", terminal: true, inputContracts: [], outputContracts: [],
        sideEffect: "none", timeoutMs: 1_000, retryBudget: 0,
      },
    ],
    edges: [{ from: "start", to: "done", event: "complete" }],
  } satisfies GraphDefinition);
}

function setup(owner = "owner-a") {
  const root = mkdtempSync(join(tmpdir(), "ai-orchestrator-checkpoint-"));
  roots.push(root);
  const paths = createGraphCheckpointPaths(root);
  acquireGraphCheckpointLease(paths, owner, { now, pid: 101, isProcessAlive: () => true });
  const graph = fixture();
  const state = createGraphExecutionState(graph, {
    runId: "opaque-run-id",
    now,
    limits: { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} },
    metadata: { priorities: { start: 1 } },
  });
  writeImmutableGraphCheckpoint(paths, graph, state.schedulerMetadata, state, { owner });
  writeGraphSnapshot(paths, graph, state, { owner, tempId: "genesis" });
  return { graph, owner, paths, state };
}

function started(state: GraphExecutionState, eventId = "event-1", sequence = 1): GraphEvent {
  return {
    schemaVersion: 1,
    kind: "node-status",
    sequence,
    eventId,
    runId: state.runId,
    graphId: state.graphId,
    graphVersion: state.graphVersion,
    graphDigest: state.graphDigest,
    planVersion: state.planVersion,
    nodeId: "start",
    priorStatus: "ready",
    nextStatus: "running",
    attempt: 1,
    timestamp: now,
    artifactRefs: [],
  };
}

describe("graph checkpoints", () => {
  it("writes canonical immutable graph and metadata bytes once", () => {
    const { graph, owner, paths, state } = setup();
    writeImmutableGraphCheckpoint(paths, graph, state.schedulerMetadata, state, { owner });
    const first = readFileSync(paths.graph, "utf8");
    writeImmutableGraphCheckpoint(paths, graph, state.schedulerMetadata, state, { owner });
    expect(readFileSync(paths.graph, "utf8")).toBe(first);
    expect(readImmutableGraphCheckpoint(paths)).toMatchObject({
      graphDigest: state.graphDigest,
      metadataFingerprint: state.metadataFingerprint,
    });

    const mutated = compileGraph({
      ...graph.definition,
      nodes: graph.definition.nodes.map((node) => node.id === "start" ? { ...node, handler: "changed-handler" } : { ...node }),
      edges: graph.definition.edges.map((edge) => ({ ...edge })),
    });
    expect(() => writeImmutableGraphCheckpoint(paths, mutated, state.schedulerMetadata, state, { owner })).toThrow(/immutable graph checkpoint|compiled graph|graph digest/);
  });

  it("writes contained immutable node artifacts and verifies bytes, size, and hash", () => {
    const { owner, paths } = setup();
    const bytes = Buffer.from("structured result\n");
    const reference = writeNodeArtifact(paths, {
      owner, planVersion: 1, nodeId: "start", contract: "result", bytes,
    });
    expect(reference.path).toMatch(/^nodes\/1\/start\//);
    expect(readNodeArtifact(paths, reference)).toEqual(bytes);
    expect(writeNodeArtifact(paths, {
      owner, planVersion: 1, nodeId: "start", contract: "result", bytes,
    })).toEqual(reference);

    writeFileSync(join(paths.root, reference.path), "tampered");
    expect(() => readNodeArtifact(paths, reference)).toThrow(/size|SHA-256/);
  });

  it("publishes immutable artifacts atomically despite an orphaned pre-publish temp file", () => {
    const { owner, paths } = setup();
    const bytes = Buffer.from("atomic artifact\n");
    const reference = writeNodeArtifact(paths, {
      owner, planVersion: 1, nodeId: "start", contract: "result", bytes,
    });
    const target = join(paths.root, reference.path);
    rmSync(target);
    writeFileSync(`${target}.publish.orphan.tmp`, "partial");
    expect(writeNodeArtifact(paths, {
      owner, planVersion: 1, nodeId: "start", contract: "result", bytes,
    })).toEqual(reference);
    expect(readNodeArtifact(paths, reference)).toEqual(bytes);
  });

  it("appends and reads a bounded unique strictly sequenced JSONL log", () => {
    const { owner, paths, state } = setup();
    const first = started(state);
    appendGraphEvent(paths, first, { owner });
    appendGraphEvent(paths, first, { owner });
    expect(readGraphEvents(paths)).toEqual([first]);
    expect(() => appendGraphEvent(paths, { ...first, eventId: "conflict" }, { owner })).toThrow(/duplicate sequence/);
    expect(() => appendGraphEvent(paths, { ...first, sequence: 3, eventId: "event-3" }, { owner })).toThrow(/out of order/);
    expect(() => appendGraphEvent(paths, { ...first, sequence: 2 }, { owner })).toThrow(/duplicate event id/);
  });

  it("fails closed without truncating corrupt, partial, or oversized logs", () => {
    const { paths } = setup();
    for (const contents of ["not-json\n", `${JSON.stringify({ schemaVersion: 1 })}\n`, JSON.stringify(started(createGraphExecutionState(fixture(), {
      runId: "opaque-run-id", now, limits: { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} },
    })))]) {
      writeFileSync(paths.events, contents);
      expect(() => readGraphEvents(paths)).toThrow(/corrupt|partial|invalid/i);
      expect(readFileSync(paths.events, "utf8")).toBe(contents);
    }
    const oversized = `${"x".repeat(300_000)}\n`;
    writeFileSync(paths.events, oversized);
    expect(() => readGraphEvents(paths)).toThrow(/record.*limit|oversized/i);
    expect(readFileSync(paths.events, "utf8")).toBe(oversized);
  });

  it("atomically snapshots and replays a crash after append but before snapshot", () => {
    const { graph, owner, paths, state } = setup();
    writeGraphSnapshot(paths, graph, state, { owner, tempId: "initial" });
    const event = started(state);
    expect(() => checkpointGraphEvent({
      graph, paths, state, event, owner, tempId: "next", failAt(point) {
        if (point === "after-event-append") throw new Error("injected crash");
      },
    })).toThrow(/injected crash/);

    const disk = readGraphSnapshot(paths, graph);
    expect(disk.lastAppliedEventSequence).toBe(0);
    const replayed = replayGraphEvents(graph, disk, readGraphEvents(paths));
    expect(replayed).toMatchObject({ lastAppliedEventSequence: 1, revision: 1 });
    expect(replayed.nodeStates.start!.status).toBe("running");
    writeGraphSnapshot(paths, graph, replayed, {
      owner, tempId: "replayed", expectedRevision: 0, expectedSnapshotHash: graphSnapshotDigest(state),
    });
    expect(replayGraphEvents(graph, readGraphSnapshot(paths, graph), readGraphEvents(paths))).toEqual(replayed);
  });

  it("rejects a caught-up same-revision snapshot whose guard fields do not match full genesis replay", () => {
    const { graph, owner, paths, state } = setup();
    const next = checkpointGraphEvent({
      graph, paths, state, event: started(state), owner, tempId: "valid-next",
    });
    const forged = structuredClone(next);
    forged.guard.estimatedCostUsd = 12;
    writeFileSync(paths.state, `${JSON.stringify(forged)}\n`);
    expect(() => readGraphSnapshot(paths, graph)).toThrow(/exactly match replay from immutable genesis/);
  });

  it("binds immutable scheduler genesis to the run id and canonical zero-revision state", () => {
    const { graph, owner, paths, state } = setup();
    rmSync(paths.graph);
    const forged = structuredClone(state);
    forged.runId = "different-run";
    expect(() => writeImmutableGraphCheckpoint(paths, graph, state.schedulerMetadata, forged, { owner })).toThrow(/canonical scheduler genesis/);
    expect(existsSync(paths.graph)).toBe(false);
  });

  it("validates transitions and complete scheduler state before either durable write", () => {
    const { graph, owner, paths, state } = setup();
    const before = existsSync(paths.events) ? readFileSync(paths.events) : undefined;
    const stateBefore = readFileSync(paths.state);
    expect(() => checkpointGraphEvent({
      graph,
      paths,
      state,
      event: { ...started(state), priorStatus: "pending" },
      owner,
      tempId: "invalid-event",
    })).toThrow(/prior status/);
    expect(existsSync(paths.events) ? readFileSync(paths.events) : undefined).toEqual(before);

    const malformed = structuredClone(state);
    malformed.ready = ["done"];
    expect(() => writeGraphSnapshot(paths, graph, malformed, { owner, tempId: "invalid-state" })).toThrow(/ready node|ready order/);
    expect(readFileSync(paths.state)).toEqual(stateBefore);
  });

  it("keeps the old atomic snapshot on a pre-rename failure and accepts post-rename recovery", () => {
    const { graph, owner, paths, state } = setup();
    writeGraphSnapshot(paths, graph, state, { owner, tempId: "initial" });
    const startEvent = started(state);
    appendGraphEvent(paths, startEvent, { owner });
    const next = replayGraphEvents(graph, state, [startEvent]);
    expect(() => writeGraphSnapshot(paths, graph, next, {
      owner, tempId: "before-rename", expectedRevision: 0, expectedSnapshotHash: graphSnapshotDigest(state),
      failAt(point) { if (point === "after-snapshot-temp-write") throw new Error("injected pre-rename crash"); },
    })).toThrow(/pre-rename crash/);
    expect(readGraphSnapshot(paths, graph).revision).toBe(0);

    expect(() => writeGraphSnapshot(paths, graph, next, {
      owner, tempId: "after-rename", expectedRevision: 0, expectedSnapshotHash: graphSnapshotDigest(state),
      failAt(point) { if (point === "after-snapshot-rename") throw new Error("injected post-rename crash"); },
    })).toThrow(/post-rename crash/);
    expect(readGraphSnapshot(paths, graph).revision).toBe(1);
  });

  it("preserves a corrupt current snapshot instead of overwriting matching revision text", () => {
    const { graph, owner, paths, state } = setup();
    writeGraphSnapshot(paths, graph, state, { owner, tempId: "initial" });
    const corrupt = { ...state, ready: ["done"] };
    writeFileSync(paths.state, `${JSON.stringify(corrupt)}\n`);
    const bytes = readFileSync(paths.state);
    const startEvent = started(state);
    appendGraphEvent(paths, startEvent, { owner });
    const next = replayGraphEvents(graph, state, [startEvent]);
    expect(() => writeGraphSnapshot(paths, graph, next, {
      owner, tempId: "must-not-overwrite", expectedRevision: 0, expectedSnapshotHash: graphSnapshotDigest(state),
    })).toThrow(/current snapshot|snapshot is invalid|ready node/i);
    expect(readFileSync(paths.state)).toEqual(bytes);
  });

  it("rejects symlink escapes for graph, event, snapshot, and node paths", () => {
    const outside = mkdtempSync(join(tmpdir(), "ai-orchestrator-checkpoint-outside-"));
    roots.push(outside);
    const root = mkdtempSync(join(tmpdir(), "ai-orchestrator-checkpoint-symlink-"));
    roots.push(root);
    symlinkSync(outside, join(root, "nodes"), "dir");
    const paths = createGraphCheckpointPaths(root);
    writeFileSync(paths.executionLease, `${JSON.stringify({ owner: "owner-a", pid: 101, createdAt: now })}\n`);
    expect(() => writeNodeArtifact(paths, {
      owner: "owner-a", planVersion: 1, nodeId: "start", contract: "result", bytes: Buffer.from("no"),
    })).toThrow(/symlink/);
    expect(existsSync(join(outside, "1"))).toBe(false);
  });

  it("rejects every checkpoint file symlink without modifying its target", () => {
    const outside = mkdtempSync(join(tmpdir(), "ai-orchestrator-checkpoint-targets-"));
    roots.push(outside);
    for (const field of ["graph", "events", "state", "executionLease"] as const) {
      const root = mkdtempSync(join(tmpdir(), `ai-orchestrator-checkpoint-${field}-`));
      roots.push(root);
      const paths = createGraphCheckpointPaths(root);
      const target = join(outside, `${field}.txt`);
      writeFileSync(target, "outside remains unchanged\n");
      symlinkSync(target, paths[field]);
      const graph = fixture();
      const state = createGraphExecutionState(graph, {
        runId: "opaque-run-id", now, limits: { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} },
      });
      const operation = field === "executionLease"
        ? () => acquireGraphCheckpointLease(paths, "owner-a", { now, pid: 101, isProcessAlive: () => true })
        : field === "graph"
          ? () => writeImmutableGraphCheckpoint(paths, graph, {}, state, { owner: "owner-a" })
          : field === "events"
            ? () => readGraphEvents(paths)
            : () => readGraphSnapshot(paths, graph);
      expect(operation, field).toThrow(/symlink/);
      expect(readFileSync(target, "utf8")).toBe("outside remains unchanged\n");
      expect(state.revision).toBe(0);
    }
  });

  it("checks ownership for every mutation and contains snapshot temp names", () => {
    const { graph, owner, paths, state } = setup();
    expect(() => writeImmutableGraphCheckpoint(paths, graph, state.schedulerMetadata, state, { owner: "other" })).toThrow(/lease owner/);
    expect(() => writeNodeArtifact(paths, {
      owner: "other", planVersion: 1, nodeId: "start", contract: "result", bytes: Buffer.from("x"),
    })).toThrow(/lease owner/);
    expect(() => appendGraphEvent(paths, started(state), { owner: "other" })).toThrow(/lease owner/);
    expect(() => writeGraphSnapshot(paths, graph, state, { owner: "other", tempId: "temp" })).toThrow(/lease owner/);
    expect(() => checkpointGraphEvent({
      graph, paths, state, event: started(state), owner: "other", tempId: "temp",
    })).toThrow(/lease owner/);
    expect(() => writeGraphSnapshot(paths, graph, state, { owner, tempId: "../escape" })).toThrow(/temp id/);
    expect(existsSync(join(paths.root, "..", "escape.tmp"))).toBe(false);
  });

  it("requires a current owner token and safely reclaims only stale leases", () => {
    const { owner, paths, state } = setup();
    expect(ownsGraphCheckpointLease(paths, owner)).toBe(true);
    expect(() => appendGraphEvent(paths, started(state), { owner: "owner-b" })).toThrow(/lease owner/);
    expect(releaseGraphCheckpointLease(paths, "owner-b")).toBe(false);
    expect(releaseGraphCheckpointLease(paths, owner)).toBe(true);

    writeFileSync(paths.executionLease, `${JSON.stringify({ owner: "dead", nonce: "dead-nonce", pid: 999, createdAt: now })}\n`);
    acquireGraphCheckpointLease(paths, "owner-b", { now, pid: 202, isProcessAlive: () => false });
    expect(ownsGraphCheckpointLease(paths, "owner-b")).toBe(true);
    expect(releaseGraphCheckpointLease(paths, "owner-b")).toBe(true);
  });

  it("preserves a replacement lease across reclaim and release races", () => {
    const { owner, paths } = setup();
    expect(releaseGraphCheckpointLease(paths, owner, {
      beforeLeaseRemove() {
        rmSync(paths.executionLease);
        writeFileSync(paths.executionLease, `${JSON.stringify({
          owner: "replacement", nonce: "replacement-nonce", pid: 303, createdAt: now,
        })}\n`);
      },
    })).toBe(false);
    expect(ownsGraphCheckpointLease(paths, "replacement")).toBe(true);

    rmSync(paths.executionLease);
    writeFileSync(paths.executionLease, `${JSON.stringify({ owner: "dead", nonce: "dead-nonce", pid: 999, createdAt: now })}\n`);
    expect(() => acquireGraphCheckpointLease(paths, "slow-reclaimer", {
      now,
      pid: 404,
      isProcessAlive(pid) { return pid === 505; },
      beforeStaleLeaseRemove() {
        rmSync(paths.executionLease);
        writeFileSync(paths.executionLease, `${JSON.stringify({
          owner: "fast-owner", nonce: "fast-nonce", pid: 505, createdAt: now,
        })}\n`);
      },
    })).toThrow(/already executing.*fast-owner/);
    expect(ownsGraphCheckpointLease(paths, "fast-owner")).toBe(true);
  });

  it("rejects backdated event-log records without changing durable bytes", () => {
    const { owner, paths, state } = setup();
    const first = started(state);
    first.timestamp = "2026-07-22T00:00:02.000Z";
    appendGraphEvent(paths, first, { owner });
    const before = readFileSync(paths.events);
    expect(() => appendGraphEvent(paths, {
      ...first,
      kind: "progress",
      sequence: 2,
      eventId: "event-2",
      priorStatus: "running",
      nextStatus: "running",
      attempt: 1,
      timestamp: "2026-07-22T00:00:01.000Z",
      progressFingerprint: "a".repeat(16),
    }, { owner })).toThrow(/predates the last durable event/);
    expect(readFileSync(paths.events)).toEqual(before);
  });
});
