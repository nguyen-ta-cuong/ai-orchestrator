import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireRunLease,
  appendJournal,
  appendRoutingTrace,
  checkpointLifecycleGraphEvent,
  createRun,
  currentRun,
  ensureLifecycleGraphCheckpoint,
  ownsRunLease,
  pathsForRun,
  reconcileLifecycleCheckpoint,
  readState,
  releaseRun,
  releaseRunLease,
  writeLifecycleNodeResult,
  writeState,
} from "../src/lifecycle/artifacts.js";
import { createIdleLifecycleState } from "../src/core/lifecycle.js";
import {
  DEFAULT_EXECUTION_LIMITS,
  evaluateExecutionGuard,
  executionLimitsFingerprint,
  type GraphEvent,
} from "../src/core/scheduler.js";
import { compileGraph } from "../src/core/graph.js";
import { lifecycleWorkflowGraph } from "../src/core/workflowGraphs.js";
import { writeGraphMutationArtifact } from "../src/runtime/graphCheckpoint.js";

const tempDirs: string[] = [];
const artifactsDir = ".ai-orchestrator/runs";

function makeTempDir(): string {
  const dir = join(tmpdir(), `ai-orchestrator-artifacts-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function overwriteAsLegacy(paths: ReturnType<typeof pathsForRun>, state: ReturnType<typeof createIdleLifecycleState>): void {
  rmSync(paths.graph, { force: true });
  writeFileSync(paths.events, "");
  delete state.graphExecution;
  delete state.envelopeRevision;
  delete state.previousEnvelopeHash;
  delete state.envelopeHash;
  state.version = 1;
  writeFileSync(paths.state, `${JSON.stringify(state, null, 2)}\n`);
}

function graphEvent(
  state: NonNullable<ReturnType<typeof readState>>,
  patch: Pick<GraphEvent, "nodeId" | "priorStatus" | "nextStatus" | "attempt"> & Partial<GraphEvent>,
): GraphEvent {
  const graph = state.graphExecution!;
  return {
    schemaVersion: 1,
    kind: "node-status",
    sequence: graph.lastAppliedEventSequence + 1,
    eventId: `test-event-${graph.lastAppliedEventSequence + 1}-${Math.random().toString(36).slice(2)}`,
    runId: state.runId,
    graphId: graph.graphId,
    graphVersion: graph.graphVersion,
    graphDigest: graph.graphDigest,
    planVersion: graph.planVersion,
    nodeId: patch.nodeId,
    priorStatus: patch.priorStatus,
    nextStatus: patch.nextStatus,
    attempt: patch.attempt,
    timestamp: new Date().toISOString(),
    artifactRefs: [],
    ...patch,
  };
}

function requestDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeStateUnderLease(
  paths: ReturnType<typeof pathsForRun>,
  state: Parameters<typeof writeState>[1],
  options: NonNullable<Parameters<typeof writeState>[2]> = {},
): void {
  const owner = acquireRunLease(paths, `test-write-${Math.random().toString(36).slice(2)}`);
  try {
    writeState(paths, state, { ...options, owner });
  } finally {
    releaseRunLease(paths, owner);
  }
}

function withRunLease<T>(
  paths: ReturnType<typeof pathsForRun>,
  operation: (owner: ReturnType<typeof acquireRunLease>) => T,
): T {
  const owner = acquireRunLease(paths, `test-lease-${Math.random().toString(36).slice(2)}`);
  try {
    return operation(owner);
  } finally {
    releaseRunLease(paths, owner);
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("lifecycle artifacts", () => {
  it("creates a run directory, current pointer, and journal", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, artifactsDir, "ship a feature");

    expect(run.runId).toMatch(/^\d{8}-\d{4}-[a-f0-9]{6}$/);
    expect(existsSync(run.paths.root)).toBe(true);
    expect(existsSync(run.paths.spec)).toBe(true);
    expect(existsSync(run.paths.plan)).toBe(true);
    expect(existsSync(run.paths.debug)).toBe(true);
    expect(readFileSync(run.paths.routing, "utf8")).toBe("");
    expect(readFileSync(run.paths.events, "utf8").trim().split("\n")).toHaveLength(2);
    expect(existsSync(run.paths.nodes)).toBe(true);
    expect(existsSync(run.paths.graph)).toBe(true);
    expect(readFileSync(join(cwd, ".ai-orchestrator", "runs", "current"), "utf8").trim()).toBe(run.runId);
    expect(readFileSync(run.paths.journal, "utf8")).toContain("Task: ship a feature");
    expect(readState(run.paths)).toMatchObject({
      runId: run.runId,
      phase: "defining",
      task: "ship a feature",
      envelopeRevision: 2,
      graphExecution: { revision: 2, lastAppliedEventSequence: 2, ready: ["defining"] },
    });

    expect(currentRun(cwd, artifactsDir)?.runId).toBe(run.runId);
  });

  it("never deletes a preexisting run root when exclusive id allocation collides", () => {
    const cwd = makeTempDir();
    const collidingId = "20260722-1501-abcdef";
    const colliding = pathsForRun(cwd, artifactsDir, collidingId);
    mkdirSync(colliding.root, { recursive: true });
    const sentinel = join(colliding.root, "older-run.txt");
    writeFileSync(sentinel, "older run survives\n");

    expect(() => createRun(cwd, artifactsDir, "new task", false, {
      runIdFactory: () => collidingId,
    })).toThrow(/exclusive lifecycle run root.*collisions/);
    expect(readFileSync(sentinel, "utf8")).toBe("older run survives\n");
    expect(readdirSync(colliding.root)).toEqual(["older-run.txt"]);
  });

  it("appends bounded routing decision records", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, artifactsDir, "task");
    withRunLease(run.paths, (owner) => appendRoutingTrace(run.paths, {
      decisionId: "decision-1",
      runId: run.runId,
      stage: "build",
      recordedAt: new Date(0).toISOString(),
      plan: { engine: "capability", candidates: [] },
      attempts: [{ provider: "p", model: "m", outcome: "selected" }],
    }, { owner }));
    expect(JSON.parse(readFileSync(run.paths.routing, "utf8"))).toMatchObject({ decisionId: "decision-1", stage: "build" });
    expect(() => withRunLease(run.paths, (owner) => appendRoutingTrace(run.paths, {
      decisionId: "oversized", runId: run.runId, stage: "build", recordedAt: "now",
      plan: { text: "x".repeat(300_000) }, attempts: [],
    }, { owner }))).toThrow(/exceeds 256 KiB/);
  });

  it("writes and reads state atomically", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, artifactsDir, "task");
    const state = readState(run.paths)!;
    state.task = "updated task";

    writeStateUnderLease(run.paths, state);

    expect(readState(run.paths)).toMatchObject({
      ...state,
      version: 2,
      task: "updated task",
      envelopeRevision: 3,
      graphExecution: { schemaVersion: 2, runId: run.runId, ready: ["defining"] },
    });
    expect(readFileSync(run.paths.state, "utf8")).toContain('"phase": "defining"');
  });

  it("rejects stale lifecycle envelope writers without changing durable bytes", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, artifactsDir, "task");
    const first = readState(run.paths)!;
    const stale = readState(run.paths)!;
    const owner = acquireRunLease(run.paths, "two-writer-owner");
    first.task = "first writer";
    writeState(run.paths, first, { owner });
    const durable = readFileSync(run.paths.state);

    stale.task = "stale writer";
    expect(() => writeState(run.paths, stale, { owner })).toThrow(/compare-and-swap conflict/);
    expect(readFileSync(run.paths.state)).toEqual(durable);
    expect(readState(run.paths)!.task).toBe("first writer");
    expect(releaseRunLease(run.paths, owner)).toBe(true);
  });

  it("never recreates missing state outside createRun when run authority remains", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, artifactsDir, "task");
    const state = readState(run.paths)!;
    const graph = readFileSync(run.paths.graph);
    const events = readFileSync(run.paths.events);
    const nodes = readdirSync(run.paths.nodes);
    const owner = acquireRunLease(run.paths, "missing-state-writer");
    unlinkSync(run.paths.state);

    expect(() => writeState(run.paths, state, { owner }))
      .toThrow(/state is missing.*only createRun may initialize/);
    expect(existsSync(run.paths.state)).toBe(false);
    expect(readFileSync(run.paths.graph)).toEqual(graph);
    expect(readFileSync(run.paths.events)).toEqual(events);
    expect(readdirSync(run.paths.nodes)).toEqual(nodes);
    expect(releaseRunLease(run.paths, owner)).toBe(true);
  });

  it("detects envelope tampering and oversized state before accepting business fields", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, artifactsDir, "task");
    const tampered = JSON.parse(readFileSync(run.paths.state, "utf8")) as Record<string, unknown>;
    tampered.task = "forged without a matching hash";
    writeFileSync(run.paths.state, `${JSON.stringify(tampered)}\n`);
    expect(() => readState(run.paths)).toThrow(/hash does not match.*explicit recovery/);

    writeFileSync(run.paths.state, Buffer.alloc(16 * 1024 * 1024 + 1, 0x20));
    expect(() => readState(run.paths)).toThrow(/cannot be read safely.*oversized.*explicit recovery/);
  });

  it("persists revision feedback and reminder checkpoints across resume", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, artifactsDir, "task");
    const state = readState(run.paths)!;
    state.revisionFeedback = {
      artifact: "spec",
      feedback: "Clarify the recovery invariant.",
      recordedAt: new Date(0).toISOString(),
    };
    state.reminder = {
      phase: "defining",
      kind: "artifact",
      recordedAt: new Date(1).toISOString(),
    };
    writeStateUnderLease(run.paths, state);

    expect(readState(run.paths)).toMatchObject({
      revisionFeedback: { artifact: "spec", feedback: "Clarify the recovery invariant." },
      reminder: { phase: "defining", kind: "artifact" },
    });
  });

  it("persists the DEBUG diagnosis checkpoint for crash-safe resume", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, artifactsDir, "task");
    const state = readState(run.paths)!;
    state.verdicts = [{ stage: "verify", verdict: "reject", reasons: "failed" }];
    state.debugDiagnosisVerdictIndex = 0;

    writeStateUnderLease(run.paths, state);
    expect(readState(run.paths)).toMatchObject({ phase: "defining", debugDiagnosisVerdictIndex: 0 });
  });

  it("persists yolo on the initial lifecycle run state", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, artifactsDir, "task", true);

    expect(readState(run.paths)).toMatchObject({ yolo: true, phase: "defining" });
  });

  it("returns undefined for missing state and surfaces corrupt state for explicit recovery", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, artifactsDir, "task");

    unlinkSync(run.paths.state);
    expect(readState(run.paths)).toBeUndefined();
    writeFileSync(run.paths.state, "not json");
    expect(() => readState(run.paths)).toThrow(/corrupt JSON.*explicit recovery/);
    writeFileSync(run.paths.state, JSON.stringify({ phase: "defining" }));
    expect(() => readState(run.paths)).toThrow(/envelope is invalid.*explicit recovery/);
    for (const counters of [{ buildIterations: -1 }, { consecutiveRejections: 1.5 }]) {
      writeFileSync(run.paths.state, JSON.stringify({
        ...createIdleLifecycleState({ runId: run.runId, phase: "defining", task: "task" }),
        ...counters,
      }));
      expect(() => readState(run.paths)).toThrow(/envelope is invalid.*explicit recovery/);
    }
    writeFileSync(run.paths.state, JSON.stringify(createIdleLifecycleState({ runId: run.runId, phase: "defining", task: "task", verdicts: [{ stage: "bad", verdict: "approve", reasons: "x" } as never] })));
    expect(() => readState(run.paths)).toThrow(/envelope is invalid.*explicit recovery/);
    writeFileSync(run.paths.state, JSON.stringify(createIdleLifecycleState({
      runId: run.runId,
      phase: "debugging",
      task: "task",
      modelSelections: [{ stage: "debug", provider: "", model: "bad", thinking: "xhigh", reason: "", selectedAt: "now" }],
    })));
    expect(() => readState(run.paths)).toThrow(/envelope is invalid.*explicit recovery/);
    writeFileSync(run.paths.state, JSON.stringify({
      ...createIdleLifecycleState({ runId: run.runId, phase: "defining", task: "task" }),
      originalModel: { provider: "anthropic", id: "model", thinking: "impossible" },
    }));
    expect(() => readState(run.paths)).toThrow(/envelope is invalid.*explicit recovery/);
    writeFileSync(run.paths.state, JSON.stringify({
      ...createIdleLifecycleState({ runId: run.runId, phase: "debugging", task: "task" }),
      debugDiagnosisVerdictIndex: -1,
    }));
    expect(() => readState(run.paths)).toThrow(/envelope is invalid.*explicit recovery/);
  });

  it("migrates older version-one state without model selections", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, artifactsDir, "task");
    const oldState = createIdleLifecycleState({ runId: run.runId, phase: "defining", task: "task" }) as unknown as Record<string, unknown>;
    delete oldState.modelSelections;
    rmSync(run.paths.graph, { force: true });
    writeFileSync(run.paths.events, "");
    const bytes = JSON.stringify(oldState);
    writeFileSync(run.paths.state, bytes);

    expect(readState(run.paths)).toMatchObject({
      version: 2,
      modelSelections: [],
      graphExecution: { schemaVersion: 2, ready: ["defining"] },
    });
    expect(readFileSync(run.paths.state, "utf8")).toBe(bytes);
  });

  it("preserves lifecycle fields through phase entry and transition checkpoints", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, artifactsDir, "task");
    const initial = readState(run.paths)!;
    const rich = {
      ...initial,
      specPath: "spec.md",
      debugPath: "debug.md",
      buildIterations: 2,
      consecutiveRejections: 1,
      verdicts: [{ stage: "verify" as const, verdict: "reject" as const, reasons: "kept" }],
      rejectionFingerprints: ["a".repeat(16)],
      buildEvidenceFingerprints: ["b".repeat(16)],
      pendingCheckerVerdict: {
        phase: "verifying" as const,
        kind: "verify" as const,
        verdict: "reject" as const,
        reasons: "structured checkpoint",
      },
      finalization: { commitSha: "abcdef1", commitMessage: "kept state" },
    };
    const owner = acquireRunLease(run.paths, "owner-a");
    writeState(run.paths, rich, { owner });

    const start = graphEvent(rich, {
      nodeId: "defining", priorStatus: "ready", nextStatus: "running", attempt: 1,
    });
    const entered = checkpointLifecycleGraphEvent(run.paths, rich, start, {
      owner, tempId: "phase-entry",
    });
    expect(entered.graphExecution!.nodeStates.defining!.status).toBe("running");

    writeFileSync(run.paths.spec, "# Immutable spec\n");
    const resultRef = writeLifecycleNodeResult(run.paths, {
      owner,
      graphState: entered.graphExecution!,
      nodeId: "defining",
      contract: "spec",
      nextState: { ...entered, phase: "awaiting_spec_approval", specPath: "spec.md" },
      payload: { artifactPath: "spec.md" },
    });
    const digest = requestDigest("write spec bytes");
    const checkpointRef = writeGraphMutationArtifact(run.paths, {
      owner,
      mutationId: digest,
      bytes: Buffer.from('{"kind":"write-spec-request"}\n'),
    });
    const intentState = checkpointLifecycleGraphEvent(run.paths, entered, graphEvent(entered, {
      kind: "side-effect-intent",
      nodeId: "defining", priorStatus: "running", nextStatus: "running", attempt: 1,
      requestRef: digest,
      checkpointRef,
      sideEffect: { phase: "intent", ordinal: 1, idempotencyKey: "write-spec-1", class: "write" },
    }), { owner, tempId: "spec-intent" });
    const effectState = checkpointLifecycleGraphEvent(run.paths, intentState, graphEvent(intentState, {
      kind: "side-effect-result",
      nodeId: "defining", priorStatus: "running", nextStatus: "running", attempt: 1,
      requestRef: digest,
      checkpointRef,
      sideEffect: {
        phase: "result", ordinal: 1, idempotencyKey: "write-spec-1", class: "write", outcome: "succeeded", resultRef,
      },
    }), { owner, tempId: "spec-result" });
    const transition = graphEvent(effectState, {
      nodeId: "defining", priorStatus: "running", nextStatus: "blocked", attempt: 1,
      chosenEdge: {
        from: "defining",
        to: "awaiting_spec_approval",
        event: "spec_produced",
        guard: "human-approval-required",
        boundedBy: "run-transition-budget",
      },
      validatorResult: { status: "passed", contracts: ["spec"] },
      artifactRefs: [resultRef],
    });
    const transitioned = checkpointLifecycleGraphEvent(run.paths, effectState, transition, {
      owner,
      tempId: "phase-transition",
      nextState: { ...effectState, phase: "awaiting_spec_approval", specPath: "spec.md" },
    });
    const disk = readState(run.paths)!;
    expect(disk).toMatchObject({
      phase: "awaiting_spec_approval",
      buildIterations: 2,
      consecutiveRejections: 1,
      specPath: "spec.md",
      debugPath: "debug.md",
      pendingCheckerVerdict: { reasons: "structured checkpoint" },
      finalization: { commitSha: "abcdef1", commitMessage: "kept state" },
      graphExecution: { revision: 6, lastAppliedEventSequence: 6 },
    });
    expect(disk.verdicts).toEqual(rich.verdicts);
    expect(disk.rejectionFingerprints).toEqual(rich.rejectionFingerprints);
    expect(transitioned.graphExecution!.nodeStates.awaiting_spec_approval!.status).toBe("ready");
    expect(releaseRunLease(run.paths, owner)).toBe(true);
  });

  it("replays an append-before-snapshot lifecycle transition and reconciles its business envelope", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, artifactsDir, "task");
    const owner = acquireRunLease(run.paths, "owner-replay");
    ensureLifecycleGraphCheckpoint(run.paths, owner);
    const initial = readState(run.paths)!;
    const entry = graphEvent(initial, {
      nodeId: "defining", priorStatus: "ready", nextStatus: "running", attempt: 1,
    });
    const entered = checkpointLifecycleGraphEvent(run.paths, initial, entry, {
      owner, tempId: "replay-entry",
    });
    const businessNext = { ...entered, phase: "awaiting_spec_approval" as const, specPath: "spec.md" };
    writeFileSync(run.paths.spec, "# Crash-safe spec\n");
    const reference = writeLifecycleNodeResult(run.paths, {
      owner,
      graphState: entered.graphExecution!,
      nodeId: "defining",
      contract: "spec",
      nextState: businessNext,
      payload: { artifactPath: "spec.md" },
    });
    const digest = requestDigest("crash-safe spec write");
    const checkpointRef = writeGraphMutationArtifact(run.paths, {
      owner,
      mutationId: digest,
      bytes: Buffer.from('{"kind":"crash-safe-spec-request"}\n'),
    });
    const intentState = checkpointLifecycleGraphEvent(run.paths, entered, graphEvent(entered, {
      kind: "side-effect-intent",
      nodeId: "defining", priorStatus: "running", nextStatus: "running", attempt: 1,
      requestRef: digest,
      checkpointRef,
      sideEffect: { phase: "intent", ordinal: 1, idempotencyKey: "replay-write-spec-1", class: "write" },
    }), { owner, tempId: "replay-intent" });
    const effectState = checkpointLifecycleGraphEvent(run.paths, intentState, graphEvent(intentState, {
      kind: "side-effect-result",
      nodeId: "defining", priorStatus: "running", nextStatus: "running", attempt: 1,
      requestRef: digest,
      checkpointRef,
      sideEffect: {
        phase: "result", ordinal: 1, idempotencyKey: "replay-write-spec-1", class: "write", outcome: "succeeded",
        resultRef: reference,
      },
    }), { owner, tempId: "replay-result" });
    const transition = graphEvent(effectState, {
      nodeId: "defining", priorStatus: "running", nextStatus: "blocked", attempt: 1,
      chosenEdge: {
        from: "defining",
        to: "awaiting_spec_approval",
        event: "spec_produced",
        guard: "human-approval-required",
        boundedBy: "run-transition-budget",
      },
      validatorResult: { status: "passed", contracts: ["spec"] },
      artifactRefs: [reference],
    });
    expect(() => checkpointLifecycleGraphEvent(run.paths, effectState, transition, {
      owner,
      tempId: "replay-transition",
      nextState: businessNext,
      failAt(point) {
        if (point === "after-event-append") throw new Error("simulated crash");
      },
    })).toThrow("simulated crash");

    expect(JSON.parse(readFileSync(run.paths.state, "utf8"))).toMatchObject({ phase: "defining", graphExecution: { revision: 5 } });
    expect(readState(run.paths)).toMatchObject({ phase: "awaiting_spec_approval", specPath: "spec.md", graphExecution: { revision: 6 } });
    expect(reconcileLifecycleCheckpoint(run.paths, {
      owner, tempId: "reconcile-replay",
    })).toMatchObject({ phase: "awaiting_spec_approval", graphExecution: { revision: 6 } });
    expect(JSON.parse(readFileSync(run.paths.state, "utf8"))).toMatchObject({ phase: "awaiting_spec_approval", graphExecution: { revision: 6 } });
    expect(releaseRunLease(run.paths, owner)).toBe(true);

    writeFileSync(run.paths.spec, "# Mutated after checkpoint\n");
    expect(() => readState(run.paths)).toThrow(/no longer match immutable lifecycle output.*explicit recovery/);
  });

  it("replays cancellation without consuming a succeeded receipt from a guard-denied transition", () => {
    const cwd = makeTempDir();
    const limits = {
      ...DEFAULT_EXECUTION_LIMITS,
      backEdgeBudgets: { "run-transition-budget": 2 },
    };
    const run = createRun(cwd, artifactsDir, "task", false, { executionLimits: limits });
    const owner = acquireRunLease(run.paths, "owner-cancel-replay");
    const initial = readState(run.paths)!;
    const entered = checkpointLifecycleGraphEvent(run.paths, initial, graphEvent(initial, {
      nodeId: "defining", priorStatus: "ready", nextStatus: "running", attempt: 1,
    }), { owner, tempId: "cancel-entry" });
    writeFileSync(run.paths.spec, "# Guard-denied spec\n");
    const normalNext = { ...entered, phase: "awaiting_spec_approval" as const, specPath: "spec.md" };
    const resultRef = writeLifecycleNodeResult(run.paths, {
      owner,
      graphState: entered.graphExecution!,
      nodeId: "defining",
      contract: "spec",
      nextState: normalNext,
      payload: { lifecycleEvent: { type: "spec_produced", specPath: "spec.md" }, journal: "normal transition" },
    });
    const digest = requestDigest("guard-denied-transition");
    const checkpointRef = writeGraphMutationArtifact(run.paths, {
      owner,
      mutationId: digest,
      bytes: Buffer.from('{"kind":"guard-denied-write-request"}\n'),
    });
    const intent = checkpointLifecycleGraphEvent(run.paths, entered, graphEvent(entered, {
      kind: "side-effect-intent",
      nodeId: "defining", priorStatus: "running", nextStatus: "running", attempt: 1,
      requestRef: digest,
      checkpointRef,
      sideEffect: { phase: "intent", ordinal: 1, idempotencyKey: "guard-denied", class: "write" },
    }), { owner, tempId: "cancel-intent" });
    const settled = checkpointLifecycleGraphEvent(run.paths, intent, graphEvent(intent, {
      kind: "side-effect-result",
      nodeId: "defining", priorStatus: "running", nextStatus: "running", attempt: 1,
      requestRef: digest,
      checkpointRef,
      sideEffect: {
        phase: "result", ordinal: 1, idempotencyKey: "guard-denied", class: "write", outcome: "succeeded", resultRef,
      },
    }), { owner, tempId: "cancel-result" });
    const specEdge = {
      from: "defining", to: "awaiting_spec_approval", event: "spec_produced",
      guard: "human-approval-required", boundedBy: "run-transition-budget",
    } as const;
    expect(evaluateExecutionGuard(compileGraph(lifecycleWorkflowGraph()), settled.graphExecution!, limits, {
      action: "transition",
      nodeId: "defining",
      additionalReady: 1,
      edge: specEdge,
      now: new Date().toISOString(),
      unattended: false,
    })).toMatchObject({ allowed: false, code: "back-edge-budget" });

    const cancellation = graphEvent(settled, {
      nodeId: "defining", priorStatus: "running", nextStatus: "cancelled", attempt: 1,
      chosenEdge: {
        from: "defining", to: "idle", event: "cancelled", guard: "run-cancelled", boundedBy: "run-transition-budget",
      },
    });
    expect(() => checkpointLifecycleGraphEvent(run.paths, settled, cancellation, {
      owner,
      tempId: "cancel-transition",
      nextState: { ...settled, phase: "idle" },
      failAt(point) {
        if (point === "after-event-append") throw new Error("simulated cancellation crash");
      },
    })).toThrow("simulated cancellation crash");

    expect(readState(run.paths)).toMatchObject({
      phase: "idle",
      graphExecution: { ready: [], nodeStates: { defining: { status: "cancelled", sideEffect: { status: "succeeded" } } } },
    });
    expect(reconcileLifecycleCheckpoint(run.paths, {
      owner, tempId: "cancel-reconcile",
    })).toMatchObject({ phase: "idle", graphExecution: { ready: [] } });
    expect(releaseRunLease(run.paths, owner)).toBe(true);
  });

  it("replays cancellation only after a model intent releases its provider reservations", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, artifactsDir, "cancel an interrupted model call");
    const owner = acquireRunLease(run.paths, "owner-model-cancel-replay");
    const initial = readState(run.paths)!;
    const entered = checkpointLifecycleGraphEvent(run.paths, initial, graphEvent(initial, {
      nodeId: "defining", priorStatus: "ready", nextStatus: "running", attempt: 1,
    }), { owner, tempId: "model-cancel-entry" });
    const checkpointRef = writeGraphMutationArtifact(run.paths, {
      owner,
      mutationId: "7".repeat(64),
      bytes: Buffer.from('{"kind":"lifecycle-phase-request"}\n'),
    });
    const digest = requestDigest("model request that may have reached its provider");
    const intent = checkpointLifecycleGraphEvent(run.paths, entered, graphEvent(entered, {
      kind: "side-effect-intent",
      nodeId: "defining", priorStatus: "running", nextStatus: "running", attempt: 1,
      requestRef: digest,
      routingDecisionId: "route-model-cancel",
      checkpointRef,
      sideEffect: { phase: "intent", ordinal: 1, idempotencyKey: "model-cancel-1", class: "model" },
      reservation: { modelCalls: 1, providerCalls: 1 },
    }), { owner, tempId: "model-cancel-intent" });
    expect(intent.graphExecution!.guard).toMatchObject({ modelCallsInFlight: 1, providerCallsInFlight: 1 });
    const unknown = checkpointLifecycleGraphEvent(run.paths, intent, graphEvent(intent, {
      kind: "side-effect-result",
      nodeId: "defining", priorStatus: "running", nextStatus: "running", attempt: 1,
      requestRef: digest,
      routingDecisionId: "route-model-cancel",
      checkpointRef,
      sideEffect: {
        phase: "result", ordinal: 1, idempotencyKey: "model-cancel-1", class: "model", outcome: "unknown",
      },
      reservation: { modelCalls: -1, providerCalls: -1 },
      usage: {
        estimatedCostUsd: "unknown", observedCostUsd: "unknown", inputTokens: "unknown", outputTokens: "unknown",
      },
    }), { owner, tempId: "model-cancel-unknown" });
    expect(unknown.graphExecution!.guard).toMatchObject({ modelCallsInFlight: 0, providerCallsInFlight: 0 });
    const cancellation = graphEvent(unknown, {
      nodeId: "defining", priorStatus: "running", nextStatus: "cancelled", attempt: 1,
      chosenEdge: {
        from: "defining", to: "idle", event: "cancelled", guard: "run-cancelled", boundedBy: "run-transition-budget",
      },
    });
    expect(() => checkpointLifecycleGraphEvent(run.paths, unknown, cancellation, {
      owner,
      tempId: "model-cancel-transition",
      nextState: { ...unknown, phase: "idle" },
      failAt(point) {
        if (point === "after-event-append") throw new Error("simulated model cancellation crash");
      },
    })).toThrow("simulated model cancellation crash");

    expect(readState(run.paths)).toMatchObject({
      phase: "idle",
      graphExecution: {
        ready: [],
        guard: { modelCallsInFlight: 0, providerCallsInFlight: 0 },
        nodeStates: { defining: { status: "cancelled", sideEffect: { status: "unknown", class: "model" } } },
      },
    });
    expect(reconcileLifecycleCheckpoint(run.paths, { owner, tempId: "model-cancel-reconcile" })).toMatchObject({
      phase: "idle", graphExecution: { ready: [] },
    });
    expect(releaseRunLease(run.paths, owner)).toBe(true);
  });

  it("removes a failed snapshot temp and resumes from its durable event", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, artifactsDir, "task");
    const owner = acquireRunLease(run.paths, "owner-temp-crash");
    const initial = readState(run.paths)!;
    expect(() => checkpointLifecycleGraphEvent(run.paths, initial, graphEvent(initial, {
      nodeId: "defining", priorStatus: "ready", nextStatus: "running", attempt: 1,
    }), {
      owner,
      tempId: "injected-temp-crash",
      failAt(point) {
        if (point === "after-snapshot-temp-write") throw new Error("injected temp crash");
      },
    })).toThrow("injected temp crash");

    expect(JSON.parse(readFileSync(run.paths.state, "utf8"))).toMatchObject({ graphExecution: { revision: 2 } });
    expect(readdirSync(run.paths.root).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    expect(readState(run.paths)).toMatchObject({ graphExecution: { revision: 3 }, phase: "defining" });
    expect(reconcileLifecycleCheckpoint(run.paths, {
      owner, tempId: "reconcile-temp-crash",
    })).toMatchObject({ graphExecution: { revision: 3 } });
    expect(releaseRunLease(run.paths, owner)).toBe(true);
  });

  it("counts pre-migration downtime against the frozen wall-time guard", () => {
    const cwd = makeTempDir();
    const current = createRun(cwd, artifactsDir, "current");
    const currentState = readState(current.paths)!;
    const graph = compileGraph(lifecycleWorkflowGraph());
    expect(evaluateExecutionGuard(graph, currentState.graphExecution!, currentState.graphExecution!.effectiveLimits, {
      action: "node", nodeId: "defining", nodeAttempts: 1, concurrency: 1,
      now: new Date().toISOString(), unattended: false,
    })).toEqual({ allowed: true });

    const expiredId = "20000101-0000-abcdef";
    const expiredPaths = pathsForRun(cwd, ".expired/runs", expiredId);
    mkdirSync(expiredPaths.root, { recursive: true });
    const old = createIdleLifecycleState({ runId: expiredId, phase: "defining", task: "old" });
    writeFileSync(expiredPaths.state, JSON.stringify(old));
    const migrated = readState(expiredPaths)!;
    expect(evaluateExecutionGuard(graph, migrated.graphExecution!, migrated.graphExecution!.effectiveLimits, {
      action: "node", nodeId: "defining", nodeAttempts: 1, concurrency: 1,
      now: new Date().toISOString(), unattended: true,
    })).toMatchObject({ allowed: false, code: "wall-time-limit" });
  });

  it("freezes configured execution ceilings when a new run is created", () => {
    const cwd = makeTempDir();
    const limits = {
      ...DEFAULT_EXECUTION_LIMITS,
      maxGraphSteps: 17,
      humanWait: "deny" as const,
      backEdgeBudgets: { "run-transition-budget": 9 },
    };

    const run = createRun(cwd, artifactsDir, "bounded", false, { executionLimits: limits });
    const state = readState(run.paths)!;
    expect(state.graphExecution!.effectiveLimits).toEqual(limits);
    expect(state.graphExecution!.limitsFingerprint).toBe(executionLimitsFingerprint(limits));
  });

  it("uses current config only for v1 migration and keeps the persisted v2 policy on resume", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, artifactsDir, "legacy");
    const v1 = createIdleLifecycleState({ runId: run.runId, phase: "defining", task: "legacy" });
    overwriteAsLegacy(run.paths, v1);
    const migrationLimits = {
      ...DEFAULT_EXECUTION_LIMITS,
      maxGraphSteps: 11,
      maxEstimatedCostUsd: 3,
      humanWait: "deny" as const,
      backEdgeBudgets: { "run-transition-budget": 7 },
    };

    const migrated = readState(run.paths, { migrationLimits })!;
    expect(migrated.graphExecution!.effectiveLimits).toEqual(migrationLimits);
    writeStateUnderLease(run.paths, migrated, { migrationLimits });

    const changedConfig = {
      ...DEFAULT_EXECUTION_LIMITS,
      maxGraphSteps: 999,
      maxEstimatedCostUsd: 99,
      backEdgeBudgets: { "run-transition-budget": 999 },
    };
    const resumed = readState(run.paths, { migrationLimits: changedConfig })!;
    expect(resumed.graphExecution!.effectiveLimits).toEqual(migrationLimits);
    expect(resumed.graphExecution!.limitsFingerprint).toBe(executionLimitsFingerprint(migrationLimits));
  });

  it("recovers a v1 migration when immutable genesis was written before the state rewrite", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, artifactsDir, "legacy migration crash");
    const legacy = createIdleLifecycleState({ runId: run.runId, phase: "defining", task: "legacy" });
    overwriteAsLegacy(run.paths, legacy);
    const frozenLimits = {
      ...DEFAULT_EXECUTION_LIMITS,
      maxGraphSteps: 13,
      maxEstimatedCostUsd: 4,
      backEdgeBudgets: { "run-transition-budget": 6 },
    };
    const lease = acquireRunLease(run.paths, "migration-crash-writer");
    ensureLifecycleGraphCheckpoint(run.paths, lease, { migrationLimits: frozenLimits });
    expect(releaseRunLease(run.paths, lease)).toBe(true);

    const changedConfig = {
      ...DEFAULT_EXECUTION_LIMITS,
      maxGraphSteps: 999,
      maxEstimatedCostUsd: 99,
      backEdgeBudgets: { "run-transition-budget": 999 },
    };
    const recovered = readState(run.paths, { migrationLimits: changedConfig })!;
    expect(recovered.version).toBe(2);
    expect(recovered.graphExecution!.effectiveLimits).toEqual(frozenLimits);
    expect(recovered.graphExecution!.limitsFingerprint).toBe(executionLimitsFingerprint(frozenLimits));
  });

  it("blocks creating a new run immediately while the current state is active", () => {
    const cwd = makeTempDir();
    createRun(cwd, artifactsDir, "first");

    expect(() => createRun(cwd, artifactsDir, "second")).toThrow(/already active/);
  });

  it("prevents concurrent execution and reclaims a dead-process lease", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, artifactsDir, "task");
    const ownerA = acquireRunLease(run.paths, "owner-a");
    expect(ownsRunLease(run.paths, ownerA)).toBe(true);
    expect(() => acquireRunLease(run.paths, "owner-b")).toThrow(/already executing/);
    expect(releaseRunLease(run.paths, { ...ownerA, owner: "owner-b" })).toBe(false);
    expect(releaseRunLease(run.paths, ownerA)).toBe(true);

    writeFileSync(run.paths.executionLease, `${JSON.stringify({
      owner: "dead", nonce: "dead-nonce", pid: 99_999_999, createdAt: new Date().toISOString(),
    })}\n`);
    const ownerB = acquireRunLease(run.paths, "owner-b");
    expect(ownsRunLease(run.paths, ownerB)).toBe(true);
    expect(releaseRunLease(run.paths, ownerB)).toBe(true);
  });

  it("reclaims a current-run lock owned by a dead process", () => {
    const cwd = makeTempDir();
    const lock = join(cwd, ".ai-orchestrator", "current.lock");
    mkdirSync(join(lock, ".."), { recursive: true });
    writeFileSync(lock, `${JSON.stringify({
      owner: "dead", nonce: "dead-nonce", pid: 99_999_999, createdAt: new Date().toISOString(),
    })}\n`);

    expect(createRun(cwd, artifactsDir, "recovered").runId).toMatch(/^\d{8}-\d{4}-[a-f0-9]{6}$/);
    expect(existsSync(lock)).toBe(false);
  });

  it("blocks creating a run while another process holds the current-run lock", () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, ".ai-orchestrator", "current.lock"), { recursive: true });

    expect(() => createRun(cwd, artifactsDir, "second")).toThrow(/active or starting/);
    expect(existsSync(join(cwd, ".ai-orchestrator", "runs", "current"))).toBe(false);
  });

  it("allows terminal replacement but fails closed on corrupt current state", () => {
    const cwd = makeTempDir();
    const first = createRun(cwd, artifactsDir, "first");
    overwriteAsLegacy(first.paths, createIdleLifecycleState({ runId: first.runId, phase: "done", task: "first" }));

    const second = createRun(cwd, artifactsDir, "second");
    expect(second.runId).not.toBe(first.runId);

    writeFileSync(second.paths.state, "not json");
    expect(() => createRun(cwd, artifactsDir, "third")).toThrow(/corrupt JSON.*explicit recovery/);

    writeFileSync(second.paths.state, JSON.stringify({ ...createIdleLifecycleState({ runId: second.runId, task: "second" }), phase: "unknown" }));
    expect(() => createRun(cwd, artifactsDir, "third")).toThrow(/envelope is invalid.*explicit recovery/);
  });

  it("ignores invalid current run ids instead of joining untrusted path text", () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, ".ai-orchestrator", "runs"), { recursive: true });
    writeFileSync(join(cwd, ".ai-orchestrator", "runs", "current"), "../../outside\n");

    expect(currentRun(cwd, artifactsDir)).toBeUndefined();
    expect(() => createRun(cwd, artifactsDir, "task")).toThrow(/current pointer is invalid/);
  });

  it("keeps the current pointer inside the artifact directory for non-default artifact directories", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, ".orch/runs", "task");

    expect(readFileSync(join(cwd, ".orch", "runs", "current"), "utf8").trim()).toBe(run.runId);
    expect(existsSync(join(cwd, ".orch", "current"))).toBe(false);
    expect(existsSync(join(cwd, "current"))).toBe(false);
  });

  it("does not delete sibling current files under artifact parents", () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "current"), "user-owned file\n");

    const run = createRun(cwd, "src/orch-runs", "task");

    expect(readFileSync(join(cwd, "src", "current"), "utf8")).toBe("user-owned file\n");
    expect(readFileSync(join(cwd, "src", "orch-runs", "current"), "utf8").trim()).toBe(run.runId);
  });

  it("normalizes backslash separators before deriving run and current paths", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, ".orch\\runs", "task");

    expect(run.paths.root).toBe(join(realpathSync(cwd), ".orch", "runs", run.runId));
    expect(readFileSync(join(cwd, ".orch", "runs", "current"), "utf8").trim()).toBe(run.runId);
    expect(existsSync(join(cwd, ".orch", "current"))).toBe(false);
    expect(existsSync(join(cwd, "current"))).toBe(false);
    expect(existsSync(join(cwd, ".orch\\runs"))).toBe(false);
  });

  it("rejects symlinked artifact ancestors and artifact files", () => {
    const cwd = makeTempDir();
    const outside = makeTempDir();
    symlinkSync(outside, join(cwd, ".ai-orchestrator"), "dir");
    expect(() => createRun(cwd, artifactsDir, "task")).toThrow(/must not contain symlinks/);
    expect(existsSync(join(outside, "runs"))).toBe(false);

    unlinkSync(join(cwd, ".ai-orchestrator"));
    const run = createRun(cwd, artifactsDir, "task");
    const outsideJournal = join(outside, "journal.md");
    writeFileSync(outsideJournal, "outside\n");
    const owner = acquireRunLease(run.paths, "symlinked-journal-owner");
    unlinkSync(run.paths.journal);
    symlinkSync(outsideJournal, run.paths.journal);
    expect(() => appendJournal(run.paths, "must not escape", { owner })).toThrow(/must not contain symlinks/);
    expect(readFileSync(outsideJournal, "utf8")).toBe("outside\n");
    expect(releaseRunLease(run.paths, owner)).toBe(true);
  });

  it("refuses journal and routing symlink swaps after append validation", () => {
    const cwd = makeTempDir();
    const outside = makeTempDir();

    const journalRun = createRun(cwd, artifactsDir, "journal swap");
    const outsideJournal = join(outside, "outside-journal.md");
    writeFileSync(outsideJournal, "outside journal\n");
    const journalOwner = acquireRunLease(journalRun.paths, "journal-swap-owner");
    expect(() => appendJournal(journalRun.paths, "must not escape", {
      owner: journalOwner,
      beforeWrite() {
        unlinkSync(journalRun.paths.journal);
        symlinkSync(outsideJournal, journalRun.paths.journal);
      },
    })).toThrow(/must not contain symlinks/);
    expect(readFileSync(outsideJournal, "utf8")).toBe("outside journal\n");
    expect(releaseRunLease(journalRun.paths, journalOwner)).toBe(true);

    expect(releaseRun(cwd, artifactsDir, journalRun.runId)).toBe(true);
    const routingRun = createRun(cwd, artifactsDir, "routing swap");
    const outsideRouting = join(outside, "outside-routing.jsonl");
    writeFileSync(outsideRouting, "outside routing\n");
    const routingOwner = acquireRunLease(routingRun.paths, "routing-swap-owner");
    expect(() => appendRoutingTrace(routingRun.paths, {
      decisionId: "decision-swap",
      runId: routingRun.runId,
      stage: "build",
      recordedAt: new Date(0).toISOString(),
      plan: { engine: "capability" },
      attempts: [],
    }, {
      owner: routingOwner,
      beforeOpen() {
        unlinkSync(routingRun.paths.routing);
        symlinkSync(outsideRouting, routingRun.paths.routing);
      },
    })).toThrow(/must not contain symlinks/);
    expect(readFileSync(outsideRouting, "utf8")).toBe("outside routing\n");
    expect(releaseRunLease(routingRun.paths, routingOwner)).toBe(true);
  });

  it("refuses an append when execution lease ownership changes before write", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, artifactsDir, "lease swap");
    const owner = acquireRunLease(run.paths, "append-original-owner");
    let replacement: ReturnType<typeof acquireRunLease> | undefined;

    expect(() => appendJournal(run.paths, "must not append", {
      owner,
      beforeWrite() {
        expect(releaseRunLease(run.paths, owner)).toBe(true);
        replacement = acquireRunLease(run.paths, "append-replacement-owner");
      },
    })).toThrow(/requires current lease owner|lease ownership changed/);
    expect(readFileSync(run.paths.journal, "utf8")).not.toContain("must not append");
    expect(replacement).toBeDefined();
    expect(releaseRunLease(run.paths, replacement!)).toBe(true);
  });

  it("rejects forged RunPaths fields even when the target is otherwise contained", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, artifactsDir, "task");
    const forgedJournal = join(run.paths.root, "forged-journal.md");
    writeFileSync(forgedJournal, "must remain unchanged\n");

    withRunLease(run.paths, (owner) => {
      expect(() => appendJournal({ ...run.paths, journal: forgedJournal }, "escape exact mapping", { owner }))
        .toThrow(/journal path must be the exact contained child/);
    });
    expect(readFileSync(forgedJournal, "utf8")).toBe("must remain unchanged\n");
  });

  it("rejects artifact directories that collide with current coordination names", () => {
    const cwd = makeTempDir();

    expect(() => createRun(cwd, ".ai-orchestrator/current", "task")).toThrow(/reserved/);
    expect(() => createRun(cwd, ".ai-orchestrator/current.lock", "task")).toThrow(/reserved/);
    expect(existsSync(join(cwd, ".ai-orchestrator", "current"))).toBe(false);
    expect(existsSync(join(cwd, ".ai-orchestrator", "current.lock"))).toBe(false);
  });

  it("rejects artifact directories with control characters before writing git excludes", () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, ".git", "info"), { recursive: true });

    expect(() => createRun(cwd, ".orch/runs\n*.ts\n#", "task")).toThrow(/control characters/);
    expect(existsSync(join(cwd, ".git", "info", "exclude"))).toBe(false);
  });

  it("adds narrow lifecycle artifact patterns to local git excludes", () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, ".git", "info"), { recursive: true });
    writeFileSync(join(cwd, ".git", "info", "exclude"), "# existing\n");

    const first = createRun(cwd, "src/orch-runs", "task");
    overwriteAsLegacy(first.paths, createIdleLifecycleState({ runId: first.runId, phase: "done", task: "task" }));
    createRun(cwd, "src/orch-runs", "task 2");

    const exclude = readFileSync(join(cwd, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("/src/orch-runs/");
    expect(exclude).not.toContain("/src/current");
    expect(exclude).not.toContain("/src/current.lock/");
    expect(exclude).not.toMatch(/^\/src\/$/m);
    expect(exclude.match(/^\/src\/orch-runs\/$/gm)).toHaveLength(1);
  });

  it("adds repo-root-relative git excludes when cwd is a repository subdirectory", () => {
    const repo = makeTempDir();
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const packageDir = join(repo, "packages", "pkg");
    mkdirSync(packageDir, { recursive: true });

    createRun(packageDir, ".ai-orchestrator/runs", "task");

    const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("/packages/pkg/.ai-orchestrator/runs/");
    expect(exclude).not.toMatch(/^\/\.ai-orchestrator\/runs\/$/m);
  });

  it("escapes gitignore metacharacters in lifecycle artifact patterns", () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, ".git", "info"), { recursive: true });

    createRun(cwd, "src/*[tmp]?/runs", "task");

    const exclude = readFileSync(join(cwd, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("/src/\\*\\[tmp\\]\\?/runs/");
    expect(exclude).not.toContain("/src/\\*\\[tmp\\]\\?/current");
    expect(exclude).not.toContain("/src/*[tmp]?/runs/");
  });

  it("resolves gitdir files before adding local git excludes", () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, ".real-git"), { recursive: true });
    writeFileSync(join(cwd, ".git"), "gitdir: .real-git\n");

    createRun(cwd, ".orch/runs", "task");

    const exclude = readFileSync(join(cwd, ".real-git", "info", "exclude"), "utf8");
    expect(exclude).toContain("/.orch/runs/");
    expect(exclude).not.toContain("/.orch/current");
    expect(exclude).not.toContain("/.orch/current.lock/");
  });

  it("coordinates one active run across worktree subdirectories", () => {
    const root = makeTempDir();
    execFileSync("git", ["init", "-q"], { cwd: root });
    const firstCwd = join(root, "packages", "one");
    const secondCwd = join(root, "packages", "two");
    mkdirSync(firstCwd, { recursive: true });
    mkdirSync(secondCwd, { recursive: true });
    const first = createRun(firstCwd, ".orch/runs", "first");

    expect(currentRun(secondCwd, ".orch/runs")?.paths.root).toBe(first.paths.root);
    expect(() => createRun(secondCwd, ".orch/runs", "second")).toThrow(/already active/);
  });

  it("fails closed when the repository active-run registry is corrupt", () => {
    const cwd = makeTempDir();
    const registry = join(cwd, ".ai-orchestrator", "active-run.json");
    mkdirSync(join(registry, ".."), { recursive: true });
    writeFileSync(registry, "not-json\n");

    expect(() => currentRun(cwd, artifactsDir)).toThrow(/registry is corrupt/);
    expect(() => createRun(cwd, artifactsDir, "blocked")).toThrow(/registry is corrupt/);
  });

  it("fails closed on oversized or symlinked coordination files", () => {
    const registryCwd = makeTempDir();
    createRun(registryCwd, artifactsDir, "registry");
    const registry = join(registryCwd, ".ai-orchestrator", "active-run.json");
    writeFileSync(registry, Buffer.alloc(64 * 1024 + 1, 0x20));
    expect(() => currentRun(registryCwd, artifactsDir)).toThrow(/registry cannot be read safely.*oversized.*explicit recovery/);

    const pointerCwd = makeTempDir();
    createRun(pointerCwd, artifactsDir, "pointer");
    unlinkSync(join(pointerCwd, ".ai-orchestrator", "active-run.json"));
    const pointer = join(pointerCwd, ".ai-orchestrator", "runs", "current");
    writeFileSync(pointer, Buffer.alloc(1025, 0x20));
    expect(() => currentRun(pointerCwd, artifactsDir)).toThrow(/current pointer cannot be read safely.*oversized.*explicit recovery/);

    const symlinkCwd = makeTempDir();
    createRun(symlinkCwd, artifactsDir, "symlink");
    const symlinkRegistry = join(symlinkCwd, ".ai-orchestrator", "active-run.json");
    const outside = join(makeTempDir(), "registry.json");
    writeFileSync(outside, "outside\n");
    unlinkSync(symlinkRegistry);
    symlinkSync(outside, symlinkRegistry);
    expect(() => currentRun(symlinkCwd, artifactsDir)).toThrow(/must not contain symlinks/);
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
  });

  it("preserves a replacement current pointer across a release race", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, artifactsDir, "task");
    const pointer = join(cwd, ".ai-orchestrator", "runs", "current");

    expect(releaseRun(cwd, artifactsDir, run.runId, {
      beforeCurrentPointerRemove() {
        unlinkSync(pointer);
        writeFileSync(pointer, `${run.runId}\n`);
      },
    })).toBe(false);
    expect(readFileSync(pointer, "utf8").trim()).toBe(run.runId);
    expect(existsSync(join(cwd, ".ai-orchestrator", "active-run.json"))).toBe(true);
  });

  it("preserves a replacement active-run registry across a release race", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, artifactsDir, "task");
    const pointer = join(cwd, ".ai-orchestrator", "runs", "current");
    const registry = join(cwd, ".ai-orchestrator", "active-run.json");
    const registryBytes = readFileSync(registry);

    expect(releaseRun(cwd, artifactsDir, run.runId, {
      beforeRegistryRemove() {
        unlinkSync(registry);
        writeFileSync(registry, registryBytes);
      },
    })).toBe(false);
    expect(existsSync(pointer)).toBe(false);
    expect(readFileSync(registry)).toEqual(registryBytes);
    expect(currentRun(cwd, artifactsDir)).toMatchObject({ runId: run.runId });
  });

  it("recovers exact registry ownership after a crash between pointer and registry release", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, artifactsDir, "task");
    const pointer = join(cwd, ".ai-orchestrator", "runs", "current");
    const registry = join(cwd, ".ai-orchestrator", "active-run.json");

    expect(() => releaseRun(cwd, artifactsDir, run.runId, {
      beforeRegistryRemove() {
        throw new Error("simulated registry-release crash");
      },
    })).toThrow("simulated registry-release crash");
    expect(existsSync(pointer)).toBe(false);
    expect(existsSync(registry)).toBe(true);
    expect(currentRun(cwd, artifactsDir)).toMatchObject({ runId: run.runId, paths: { root: run.paths.root } });

    const differentRunId = `${run.runId.slice(0, -1)}${run.runId.endsWith("0") ? "1" : "0"}`;
    writeFileSync(pointer, `${differentRunId}\n`, { flag: "wx" });
    expect(() => currentRun(cwd, artifactsDir)).toThrow(/registry and current pointer disagree/);
    expect(releaseRun(cwd, artifactsDir, run.runId)).toBe(false);
    unlinkSync(pointer);

    expect(releaseRun(cwd, artifactsDir, run.runId)).toBe(true);
    expect(existsSync(registry)).toBe(false);
    expect(currentRun(cwd, artifactsDir)).toBeUndefined();
  });

  it("keeps repository ownership visible after artifactsDir changes", () => {
    const cwd = makeTempDir();
    const first = createRun(cwd, ".one/runs", "first");

    expect(currentRun(cwd, ".two/runs")?.paths.root).toBe(first.paths.root);
    expect(() => createRun(cwd, ".two/runs", "second")).toThrow(/already active/);
    expect(releaseRun(cwd, ".two/runs", first.runId)).toBe(true);
    expect(currentRun(cwd, ".two/runs")).toBeUndefined();
  });

  it("appends journal entries and releases the current run pointer", () => {
    const cwd = makeTempDir();
    const run = createRun(cwd, artifactsDir, "task");

    withRunLease(run.paths, (owner) => appendJournal(run.paths, "moved to planning", { owner }));
    expect(readFileSync(run.paths.journal, "utf8")).toContain("moved to planning");

    expect(releaseRun(cwd, artifactsDir, run.runId)).toBe(true);
    expect(currentRun(cwd, artifactsDir)).toBeUndefined();

    const next = createRun(cwd, artifactsDir, "next");
    expect(next.runId).not.toBe(run.runId);
  });

  it("does not release a newer run's pointer from an older run", () => {
    const cwd = makeTempDir();
    const oldRun = createRun(cwd, artifactsDir, "old");
    overwriteAsLegacy(oldRun.paths, createIdleLifecycleState({ runId: oldRun.runId, phase: "done", task: "old" }));
    const newRun = createRun(cwd, artifactsDir, "new");

    expect(releaseRun(cwd, artifactsDir, oldRun.runId)).toBe(false);
    expect(currentRun(cwd, artifactsDir)?.runId).toBe(newRun.runId);
    expect(releaseRun(cwd, artifactsDir, newRun.runId)).toBe(true);
    expect(currentRun(cwd, artifactsDir)).toBeUndefined();
  });
});
