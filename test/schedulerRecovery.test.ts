import { describe, expect, it } from "vitest";
import { compileGraph, type GraphDefinition } from "../src/core/graph.js";
import {
  assertSchedulerRecoveryAnchor,
  createSchedulerRecoveryBinding,
  schedulerFailureEvidence,
  validateSchedulerRecoveryBinding,
} from "../src/core/schedulerRecovery.js";
import {
  applySchedulerEvent,
  createGraphExecutionState,
  DEFAULT_EXECUTION_LIMITS,
  graphDefinitionDigest,
  graphEventDigest,
  type GraphEvent,
} from "../src/core/scheduler.js";

const definition: GraphDefinition = {
  schemaVersion: 1,
  id: "recovery-anchor",
  version: "1",
  kind: "state-machine",
  entry: "work",
  nodes: [
    { id: "work", handler: "build", inputContracts: [], outputContracts: [], sideEffect: "write", timeoutMs: 100, retryBudget: 1 },
    { id: "done", handler: "done", terminal: true, inputContracts: [], outputContracts: [], sideEffect: "none", timeoutMs: 1, retryBudget: 0 },
  ],
  edges: [{ from: "work", to: "done", event: "finish" }],
};

function runningFixture() {
  const graph = compileGraph(definition);
  const genesis = createGraphExecutionState(graph, {
    runId: "run-recovery-anchor",
    now: "2026-07-22T00:00:00.000Z",
    limits: { ...DEFAULT_EXECUTION_LIMITS, maxGraphSteps: 9, maxPlanVersions: 4 },
  });
  const event: GraphEvent = {
    schemaVersion: 1,
    kind: "node-status",
    sequence: 1,
    eventId: "work-started",
    runId: genesis.runId,
    graphId: definition.id,
    graphVersion: definition.version,
    graphDigest: graphDefinitionDigest(graph),
    planVersion: 1,
    nodeId: "work",
    priorStatus: "ready",
    nextStatus: "running",
    attempt: 1,
    timestamp: "2026-07-22T00:00:01.000Z",
    artifactRefs: [],
  };
  return { graph, state: applySchedulerEvent(graph, genesis, event), event };
}

describe("scheduler recovery authority", () => {
  it("issues a deterministic lineage and freezes caps at an external WAL head", () => {
    const { graph, state, event } = runningFixture();
    const binding = createSchedulerRecoveryBinding(graph, state, {
      nodeId: "work",
      activePlanVersion: 2,
      activePlanHash: "a".repeat(64),
    });

    expect(binding.anchor).toMatchObject({
      schedulerRevision: 1,
      eventSequence: 1,
      eventId: event.eventId,
      eventHash: graphEventDigest(event),
      eventChainHash: state.eventChainHash,
      failureLineageId: expect.stringMatching(/^lineage-[a-f0-9]{48}$/),
    });
    expect(binding.authority.limits).toEqual({
      maxEntries: 9,
      maxPlanVersions: 4,
      budgets: { retry: 1, repair: 1, replan: 1 },
    });
    expect(createSchedulerRecoveryBinding(graph, state, {
      nodeId: "work", activePlanVersion: 2, activePlanHash: "a".repeat(64),
    })).toEqual(binding);
    expect(() => assertSchedulerRecoveryAnchor(graph, state, binding)).not.toThrow();
  });

  it("rejects a forged lineage, relaxed caps, stale WAL head, and genesis-only recovery", () => {
    const { graph, state } = runningFixture();
    const binding = createSchedulerRecoveryBinding(graph, state, {
      nodeId: "work", activePlanVersion: 1, activePlanHash: "b".repeat(64),
    });
    expect(() => assertSchedulerRecoveryAnchor(graph, state, {
      ...binding,
      anchor: { ...binding.anchor, failureLineageId: "lineage-forged" },
    })).toThrow(/scheduler-issued/);
    expect(() => assertSchedulerRecoveryAnchor(graph, state, {
      ...binding,
      authority: { ...binding.authority, limits: { ...binding.authority.limits, maxPlanVersions: 5 } },
    })).toThrow(/frozen scheduler limits/);
    expect(() => assertSchedulerRecoveryAnchor(graph, { ...state, revision: 2 }, binding)).toThrow();

    const genesis = createGraphExecutionState(graph, {
      runId: "run-no-anchor", now: "2026-07-22T00:00:00.000Z", limits: DEFAULT_EXECUTION_LIMITS,
    });
    expect(() => createSchedulerRecoveryBinding(graph, genesis, {
      nodeId: "work", activePlanVersion: 1, activePlanHash: "c".repeat(64),
    })).toThrow(/externally anchored/);
  });

  it("derives bounded failure evidence from scheduler-owned identity", () => {
    const { graph, state } = runningFixture();
    const binding = createSchedulerRecoveryBinding(graph, state, {
      nodeId: "work", activePlanVersion: 3, activePlanHash: "d".repeat(64),
    });
    expect(schedulerFailureEvidence(graph, binding, 2, {
      category: "output-contract",
      contractViolation: "validator-rejected",
      contractId: "build-output",
      artifactHashes: ["e".repeat(64)],
    })).toEqual({
      version: 1,
      runId: state.runId,
      nodeId: "work",
      category: "output-contract",
      nodeKind: "build",
      graphVersion: state.graphVersion,
      graphDigest: state.graphDigest,
      planVersion: 3,
      planHash: "d".repeat(64),
      attempt: 2,
      failureLineageId: binding.anchor.failureLineageId,
      contractViolation: "validator-rejected",
      contractId: "build-output",
      artifactHashes: ["e".repeat(64)],
    });
  });

  it("accepts only exact plain persisted bindings", () => {
    const { graph, state } = runningFixture();
    const binding = createSchedulerRecoveryBinding(graph, state, {
      nodeId: "work", activePlanVersion: 1, activePlanHash: "f".repeat(64),
    });
    expect(() => validateSchedulerRecoveryBinding({ ...binding, injected: true })).toThrow(/unexpected or missing/);
    expect(() => validateSchedulerRecoveryBinding(Object.create(binding))).toThrow(/plain object/);
  });
});
