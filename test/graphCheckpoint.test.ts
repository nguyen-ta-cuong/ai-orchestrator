import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileGraph, type GraphDefinition } from "../src/core/graph.js";
import {
  DEFAULT_EXECUTION_LIMITS,
  applySchedulerEvent,
  createGraphExecutionState,
  type GraphEvent,
  type GraphExecutionState,
} from "../src/core/scheduler.js";
import {
  acquireGraphCheckpointLease,
  appendGraphEvent,
  checkpointGraphEvent,
  checkpointPlanVersionReservation,
  createGraphCheckpointPaths,
  graphSnapshotDigest,
  ownsGraphCheckpointLease,
  readGraphEvents,
  readGraphSnapshot,
  readGraphMutationArtifact,
  readImmutableGraphCheckpoint,
  readNodeArtifact,
  releaseGraphCheckpointLease,
  replayGraphEvents,
  writeGraphSnapshot,
  writeGraphMutationArtifact,
  writeImmutableGraphCheckpoint,
  writeNodeArtifact,
} from "../src/runtime/graphCheckpoint.js";

const now = "2026-07-22T00:00:00.000Z";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(startSideEffect: "read" | "none" = "read") {
  return compileGraph({
    schemaVersion: 1,
    id: "checkpoint-graph",
    version: "1",
    kind: "dag",
    entry: "start",
    nodes: [
      {
        id: "start", handler: "start-handler", inputContracts: [], outputContracts: ["result"],
        sideEffect: startSideEffect, timeoutMs: 1_000, retryBudget: 1,
      },
      {
        id: "done", handler: "done-handler", terminal: true, inputContracts: [], outputContracts: [],
        sideEffect: "none", timeoutMs: 1_000, retryBudget: 0,
      },
    ],
    edges: [{ from: "start", to: "done", event: "complete" }],
  } satisfies GraphDefinition);
}

function setup(owner = "owner-a", startSideEffect: "read" | "none" = "read") {
  const root = mkdtempSync(join(tmpdir(), "ai-orchestrator-checkpoint-"));
  roots.push(root);
  const paths = createGraphCheckpointPaths(root);
  const lease = acquireGraphCheckpointLease(paths, owner, { now, pid: 101, isProcessAlive: () => true });
  const graph = fixture(startSideEffect);
  const state = createGraphExecutionState(graph, {
    runId: "opaque-run-id",
    now,
    limits: { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} },
    metadata: { priorities: { start: 1 } },
  });
  writeImmutableGraphCheckpoint(paths, graph, state.schedulerMetadata, state, { owner: lease });
  writeGraphSnapshot(paths, graph, state, { owner: lease, tempId: "genesis" });
  return { graph, owner: lease, paths, state };
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

  it("rejects completion and side-effect result events whose immutable artifacts are unavailable", () => {
    const completionFixture = setup("artifact-completion-owner", "none");
    expect(readImmutableGraphCheckpoint(completionFixture.paths).graph.nodesById.get("start")?.sideEffect).toBe("none");
    const start = started(completionFixture.state);
    appendGraphEvent(completionFixture.paths, start, { owner: completionFixture.owner });
    const missingOutput = {
      planVersion: 1,
      nodeId: "start",
      contract: "result",
      path: "nodes/1/start/missing-output.json",
      sha256: "7".repeat(64),
      sizeBytes: 4,
    };
    expect(() => appendGraphEvent(completionFixture.paths, {
      ...started(completionFixture.state, "event-2", 2),
      priorStatus: "running",
      nextStatus: "executed",
      artifactRefs: [missingOutput],
      validatorResult: { status: "passed", contracts: ["result"] },
    }, { owner: completionFixture.owner })).toThrow(/artifact|missing|ENOENT/i);

    const resultFixture = setup("artifact-result-owner");
    appendGraphEvent(resultFixture.paths, started(resultFixture.state), { owner: resultFixture.owner });
    const requestRef = "8".repeat(64);
    appendGraphEvent(resultFixture.paths, {
      ...started(resultFixture.state, "event-2", 2),
      kind: "side-effect-intent",
      priorStatus: "running",
      nextStatus: "running",
      requestRef,
      sideEffect: { phase: "intent", ordinal: 1, idempotencyKey: "tool-result", class: "tool" },
    }, { owner: resultFixture.owner });
    expect(() => appendGraphEvent(resultFixture.paths, {
      ...started(resultFixture.state, "event-3", 3),
      kind: "side-effect-result",
      priorStatus: "running",
      nextStatus: "running",
      requestRef,
      sideEffect: {
        phase: "result",
        ordinal: 1,
        idempotencyKey: "tool-result",
        class: "tool",
        outcome: "succeeded",
        resultRef: {
          planVersion: 1,
          nodeId: "start",
          contract: "tool-result",
          path: "nodes/1/start/missing-result.json",
          sha256: "9".repeat(64),
          sizeBytes: 4,
        },
      },
    }, { owner: resultFixture.owner })).toThrow(/artifact|missing|ENOENT/i);
  });

  it("revalidates completion and successful-result artifact bytes during durable log replay", () => {
    const completionFixture = setup("replay-completion-owner", "none");
    appendGraphEvent(completionFixture.paths, started(completionFixture.state), { owner: completionFixture.owner });
    const outputRef = writeNodeArtifact(completionFixture.paths, {
      owner: completionFixture.owner,
      planVersion: 1,
      nodeId: "start",
      contract: "result",
      bytes: Buffer.from("validated output\n"),
    });
    appendGraphEvent(completionFixture.paths, {
      ...started(completionFixture.state, "completion-event", 2),
      priorStatus: "running",
      nextStatus: "executed",
      artifactRefs: [outputRef],
      validatorResult: { status: "passed", contracts: ["result"] },
    }, { owner: completionFixture.owner });
    writeFileSync(join(completionFixture.paths.root, outputRef.path), "tampered output\n");
    expect(() => readGraphEvents(completionFixture.paths)).toThrow(/artifact (size|SHA-256)/i);

    const resultFixture = setup("replay-result-owner");
    appendGraphEvent(resultFixture.paths, started(resultFixture.state), { owner: resultFixture.owner });
    const requestRef = "6".repeat(64);
    appendGraphEvent(resultFixture.paths, {
      ...started(resultFixture.state, "result-intent", 2),
      kind: "side-effect-intent",
      priorStatus: "running",
      nextStatus: "running",
      requestRef,
      sideEffect: { phase: "intent", ordinal: 1, idempotencyKey: "replay-tool-result", class: "tool" },
    }, { owner: resultFixture.owner });
    const resultRef = writeNodeArtifact(resultFixture.paths, {
      owner: resultFixture.owner,
      planVersion: 1,
      nodeId: "start",
      contract: "tool-result",
      bytes: Buffer.from("validated result\n"),
    });
    appendGraphEvent(resultFixture.paths, {
      ...started(resultFixture.state, "result-event", 3),
      kind: "side-effect-result",
      priorStatus: "running",
      nextStatus: "running",
      requestRef,
      sideEffect: {
        phase: "result",
        ordinal: 1,
        idempotencyKey: "replay-tool-result",
        class: "tool",
        outcome: "succeeded",
        resultRef,
      },
    }, { owner: resultFixture.owner });
    writeFileSync(join(resultFixture.paths.root, resultRef.path), "tampered result\n");
    expect(() => readGraphEvents(resultFixture.paths)).toThrow(/artifact (size|SHA-256)/i);
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

  it("writes bounded immutable graph mutation artifacts under flat deterministic ids", () => {
    const { owner, paths } = setup();
    const mutationId = "a".repeat(64);
    const bytes = Buffer.from('{"kind":"test-mutation"}\n');
    const reference = writeGraphMutationArtifact(paths, { owner, mutationId, bytes });
    expect(reference.path).toBe(`mutations/${mutationId}.json`);
    expect(readGraphMutationArtifact(paths, reference)).toEqual(bytes);
    expect(writeGraphMutationArtifact(paths, { owner, mutationId, bytes })).toEqual(reference);
    expect(() => writeGraphMutationArtifact(paths, {
      owner, mutationId, bytes: Buffer.from("conflicting"),
    })).toThrow(/immutable graph mutation/);
    for (const invalid of ["../escape", "nested/id", "with:colon", "short"]) {
      expect(() => writeGraphMutationArtifact(paths, { owner, mutationId: invalid, bytes })).toThrow(/flat SHA-256/);
    }
    const oversized = { byteLength: 64 * 1024 * 1024 + 1 } as Uint8Array;
    expect(() => writeGraphMutationArtifact(paths, { owner, mutationId: "b".repeat(64), bytes: oversized })).toThrow(/size limit/);
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
    const replayed = replayGraphEvents(graph, disk, readGraphEvents(paths), state);
    expect(replayed).toMatchObject({ lastAppliedEventSequence: 1, revision: 1 });
    expect(replayed.nodeStates.start!.status).toBe("running");
    writeGraphSnapshot(paths, graph, replayed, {
      owner, tempId: "replayed", expectedRevision: 0, expectedSnapshotHash: graphSnapshotDigest(state),
    });
    expect(replayGraphEvents(graph, readGraphSnapshot(paths, graph), readGraphEvents(paths), state)).toEqual(replayed);
  });

  it("replays model route identity and rejects a substituted result route", () => {
    const { graph, owner, paths, state } = setup();
    const start = started(state);
    const checkpointRef = writeGraphMutationArtifact(paths, {
      owner,
      mutationId: "7".repeat(64),
      bytes: Buffer.from('{"kind":"model-request"}\n'),
    });
    const intent: GraphEvent = {
      ...started(state, "route-intent", 2),
      kind: "side-effect-intent",
      priorStatus: "running",
      nextStatus: "running",
      attempt: 1,
      requestRef: "8".repeat(64),
      routingDecisionId: "route-decision-1",
      checkpointRef,
      sideEffect: { phase: "intent", ordinal: 1, idempotencyKey: "model-route-call", class: "model" },
      reservation: { modelCalls: 1, providerCalls: 1 },
    };
    const result: GraphEvent = {
      ...intent,
      kind: "side-effect-result",
      sequence: 3,
      eventId: "route-result",
      sideEffect: {
        phase: "result", ordinal: 1, idempotencyKey: "model-route-call", class: "model", outcome: "unknown",
      },
      reservation: { modelCalls: -1, providerCalls: -1 },
      usage: { estimatedCostUsd: "unknown", observedCostUsd: "unknown", inputTokens: "unknown", outputTokens: "unknown" },
    };
    appendGraphEvent(paths, start, { owner });
    appendGraphEvent(paths, intent, { owner });
    appendGraphEvent(paths, result, { owner });

    const intentState = replayGraphEvents(graph, state, [start, intent], state);
    expect(() => applySchedulerEvent(graph, intentState, {
      ...result,
      routingDecisionId: "route-decision-substituted",
    })).toThrow(/does not match the persisted intent/);
    const replayed = replayGraphEvents(graph, state, readGraphEvents(paths), state);
    expect(replayed.nodeStates.start!.sideEffect).toMatchObject({
      status: "unknown",
      routingDecisionId: "route-decision-1",
      checkpointRef,
    });
  });

  it("rejects a WAL event whose immutable checkpoint reference was substituted on disk", () => {
    const { owner, paths, state } = setup();
    const checkpointRef = writeGraphMutationArtifact(paths, {
      owner,
      mutationId: "9".repeat(64),
      bytes: Buffer.from('{"kind":"model-request"}\n'),
    });
    const start = started(state);
    const intent: GraphEvent = {
      ...started(state, "checkpoint-intent", 2),
      kind: "side-effect-intent",
      priorStatus: "running",
      nextStatus: "running",
      attempt: 1,
      requestRef: "a".repeat(64),
      routingDecisionId: "route-checkpoint-substitution",
      checkpointRef,
      sideEffect: { phase: "intent", ordinal: 1, idempotencyKey: "checkpoint-substitution", class: "model" },
      reservation: { modelCalls: 1, providerCalls: 1 },
    };
    appendGraphEvent(paths, start, { owner });
    appendGraphEvent(paths, intent, { owner });
    const lines = readFileSync(paths.events, "utf8").trim().split("\n").map((line) => JSON.parse(line) as GraphEvent);
    lines[1] = { ...lines[1]!, checkpointRef: { ...checkpointRef, sha256: "e".repeat(64) } };
    writeFileSync(paths.events, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

    expect(() => readGraphEvents(paths)).toThrow(/mutation artifact SHA-256 does not match its reference/);
  });

  it("durably reserves a plan namespace and replays an append-before-snapshot crash", () => {
    const { graph, owner, paths, state } = setup();
    const activationRef = writeNodeArtifact(paths, {
      owner,
      planVersion: 2,
      nodeId: "start",
      contract: "plan-version-intent",
      bytes: Buffer.from('{"prior":1,"next":2}\n'),
    });
    expect(() => checkpointPlanVersionReservation({
      graph,
      paths,
      state,
      nodeId: "start",
      activationRef,
      eventId: "reserve-plan-version-2",
      timestamp: now,
      unattended: false,
      owner,
      tempId: "reserve-plan-version",
      failAt(point) { if (point === "after-event-append") throw new Error("injected reservation crash"); },
    })).toThrow(/reservation crash/);
    const snapshot = readGraphSnapshot(paths, graph);
    expect(snapshot.planVersion).toBe(1);
    const replayed = replayGraphEvents(graph, snapshot, readGraphEvents(paths), state);
    expect(replayed).toMatchObject({ planVersion: 2, revision: 1 });
    expect(replayed.nodeStates.start).toMatchObject({ planVersion: 2, status: "ready" });
    expect(() => checkpointPlanVersionReservation({
      graph,
      paths,
      state: replayed,
      nodeId: "start",
      activationRef: { ...activationRef, planVersion: 3, path: activationRef.path.replace("nodes/2/", "nodes/3/") },
      eventId: "reserve-plan-version-3",
      timestamp: now,
      unattended: false,
      owner,
      tempId: "over-limit",
    })).toThrow(/input state|artifact|missing|limit/);
  });

  it("migrates legacy scheduler-v2 node namespaces in memory and persists only under CAS", () => {
    const { graph, owner, paths } = setup();
    const graphRecord = JSON.parse(readFileSync(paths.graph, "utf8")) as Record<string, unknown>;
    const legacyGenesis = structuredClone(graphRecord.genesisState) as GraphExecutionState;
    for (const node of Object.values(legacyGenesis.nodeStates)) delete (node as typeof node & { planVersion?: number }).planVersion;
    graphRecord.genesisState = legacyGenesis;
    graphRecord.genesisHash = graphSnapshotDigest(legacyGenesis);
    writeFileSync(paths.graph, `${JSON.stringify(graphRecord)}\n`);

    const legacySnapshot = JSON.parse(readFileSync(paths.state, "utf8")) as GraphExecutionState;
    for (const node of Object.values(legacySnapshot.nodeStates)) delete (node as typeof node & { planVersion?: number }).planVersion;
    writeFileSync(paths.state, `${JSON.stringify(legacySnapshot)}\n`);
    const legacyBytes = readFileSync(paths.state, "utf8");

    expect(readImmutableGraphCheckpoint(paths).genesisState.nodeStates.start!.planVersion).toBe(1);
    const migrated = readGraphSnapshot(paths, graph);
    expect(migrated.nodeStates.start!.planVersion).toBe(1);
    expect(readFileSync(paths.state, "utf8")).toBe(legacyBytes);
    writeGraphSnapshot(paths, graph, migrated, {
      owner,
      tempId: "legacy-node-plan-version",
      expectedRevision: 0,
      expectedSnapshotHash: graphSnapshotDigest(migrated),
    });
    expect(JSON.parse(readFileSync(paths.state, "utf8")).nodeStates.start.planVersion).toBe(1);

    const inconsistent = structuredClone(migrated);
    delete (inconsistent.nodeStates.start as typeof inconsistent.nodeStates.start & { planVersion?: number }).planVersion;
    inconsistent.nodeStates.start!.outputRefs = [
      { planVersion: 1, nodeId: "start", contract: "result", path: "nodes/1/start/a", sha256: "a".repeat(64), sizeBytes: 1 },
      { planVersion: 2, nodeId: "start", contract: "result", path: "nodes/2/start/b", sha256: "b".repeat(64), sizeBytes: 1 },
    ];
    writeFileSync(paths.state, `${JSON.stringify(inconsistent)}\n`);
    expect(() => readGraphSnapshot(paths, graph)).toThrow(/mixes artifact plan versions/);
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
    const next = replayGraphEvents(graph, state, [startEvent], state);
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
    const next = replayGraphEvents(graph, state, [startEvent], state);
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
    const paths = createGraphCheckpointPaths(root);
    const owner = acquireGraphCheckpointLease(paths, "owner-a", { now, pid: 101, isProcessAlive: () => true });
    symlinkSync(outside, join(root, "nodes"), "dir");
    expect(() => writeNodeArtifact(paths, {
      owner, planVersion: 1, nodeId: "start", contract: "result", bytes: Buffer.from("no"),
    })).toThrow(/symlink/);
    expect(existsSync(join(outside, "1"))).toBe(false);
  });

  it("rejects a mutation-directory symlink without writing outside the run", () => {
    const outside = mkdtempSync(join(tmpdir(), "ai-orchestrator-mutation-outside-"));
    roots.push(outside);
    const { owner, paths } = setup();
    symlinkSync(outside, paths.mutations, "dir");
    expect(() => writeGraphMutationArtifact(paths, {
      owner,
      mutationId: "c".repeat(64),
      bytes: Buffer.from("{}\n"),
    })).toThrow(/symlink/);
    expect(existsSync(join(outside, `${"c".repeat(64)}.json`))).toBe(false);
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
      const owner = field === "executionLease"
        ? undefined
        : acquireGraphCheckpointLease(paths, `owner-${field}`, { now, pid: 101, isProcessAlive: () => true });
      symlinkSync(target, paths[field]);
      const graph = fixture();
      const state = createGraphExecutionState(graph, {
        runId: "opaque-run-id", now, limits: { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} },
      });
      const operation = field === "executionLease"
        ? () => acquireGraphCheckpointLease(paths, "owner-a", { now, pid: 101, isProcessAlive: () => true })
        : field === "graph"
          ? () => writeImmutableGraphCheckpoint(paths, graph, {}, state, { owner: owner! })
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
    const other = { ...owner, owner: "other" };
    expect(() => writeImmutableGraphCheckpoint(paths, graph, state.schedulerMetadata, state, { owner: other })).toThrow(/lease generation/);
    expect(() => writeNodeArtifact(paths, {
      owner: other, planVersion: 1, nodeId: "start", contract: "result", bytes: Buffer.from("x"),
    })).toThrow(/lease generation/);
    expect(() => appendGraphEvent(paths, started(state), { owner: other })).toThrow(/lease generation/);
    expect(() => writeGraphSnapshot(paths, graph, state, { owner: other, tempId: "temp" })).toThrow(/lease generation/);
    expect(() => checkpointGraphEvent({
      graph, paths, state, event: started(state), owner: other, tempId: "temp",
    })).toThrow(/lease generation/);
    expect(() => writeGraphSnapshot(paths, graph, state, { owner, tempId: "../escape" })).toThrow(/temp id/);
    expect(existsSync(join(paths.root, "..", "escape.tmp"))).toBe(false);
  });

  it("requires a current owner token and safely reclaims only stale leases", () => {
    const { owner, paths, state } = setup();
    expect(ownsGraphCheckpointLease(paths, owner)).toBe(true);
    const other = { ...owner, owner: "owner-b" };
    expect(() => appendGraphEvent(paths, started(state), { owner: other })).toThrow(/lease generation/);
    expect(releaseGraphCheckpointLease(paths, other)).toBe(false);
    expect(releaseGraphCheckpointLease(paths, owner)).toBe(true);

    writeFileSync(paths.executionLease, `${JSON.stringify({ owner: "dead", nonce: "dead-nonce", pid: 999, createdAt: now })}\n`);
    const reclaimed = acquireGraphCheckpointLease(paths, "owner-b", { now, pid: 202, isProcessAlive: () => false });
    expect(ownsGraphCheckpointLease(paths, reclaimed)).toBe(true);
    expect(releaseGraphCheckpointLease(paths, reclaimed)).toBe(true);
  });

  it("does not treat a different nonce as the same lease generation even when the owner string matches", () => {
    const { owner, paths } = setup("same-owner");
    expect(() => acquireGraphCheckpointLease(paths, owner.owner, {
      now,
      pid: 202,
      nonce: "second-generation",
      isProcessAlive: () => true,
    })).toThrow(/already executing|lease generation|nonce/i);
  });

  it("revalidates the exact lease generation and expected WAL head immediately before append", () => {
    const leaseFixture = setup("append-generation-owner");
    const leaseOptions = {
      owner: leaseFixture.owner,
      beforeAppend() {
        expect(releaseGraphCheckpointLease(leaseFixture.paths, leaseFixture.owner)).toBe(true);
        acquireGraphCheckpointLease(leaseFixture.paths, leaseFixture.owner.owner, {
          now,
          pid: 202,
          nonce: "replacement-generation",
          isProcessAlive: () => true,
        });
      },
    } as Parameters<typeof appendGraphEvent>[2] & { beforeAppend(): void };
    expect(() => appendGraphEvent(leaseFixture.paths, started(leaseFixture.state), leaseOptions))
      .toThrow(/lease.*changed|lease generation|current lease/i);
    expect(readGraphEvents(leaseFixture.paths)).toEqual([]);

    const headFixture = setup("append-head-owner");
    const concurrent = started(headFixture.state, "concurrent-event", 1);
    const headOptions = {
      owner: headFixture.owner,
      beforeAppend() {
        writeFileSync(headFixture.paths.events, `${JSON.stringify(concurrent)}\n`, { flag: "a" });
      },
    } as Parameters<typeof appendGraphEvent>[2] & { beforeAppend(): void };
    expect(() => appendGraphEvent(headFixture.paths, started(headFixture.state), headOptions))
      .toThrow(/event log.*changed|expected.*head|append conflict/i);
    expect(readGraphEvents(headFixture.paths)).toEqual([concurrent]);
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
    const replacement = acquireGraphCheckpointLease(paths, "replacement", {
      now, pid: 303, nonce: "replacement-nonce", isProcessAlive: () => true,
    });
    expect(ownsGraphCheckpointLease(paths, replacement)).toBe(true);

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
    const fastOwner = acquireGraphCheckpointLease(paths, "fast-owner", {
      now, pid: 505, nonce: "fast-nonce", isProcessAlive: () => true,
    });
    expect(ownsGraphCheckpointLease(paths, fastOwner)).toBe(true);
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
