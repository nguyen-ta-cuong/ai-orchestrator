import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileLegacySequentialBuildPlan } from "../src/core/buildPlan.js";
import { DEFAULT_EXECUTION_LIMITS, type GraphEvent } from "../src/core/scheduler.js";
import {
  acquireBuildGraphExecutionLease,
  buildGraphExecutionPaths,
  checkpointBuildGraphEvent,
  initializeBuildGraphExecution,
  recoverBuildGraphExecution,
  releaseBuildGraphExecution,
} from "../src/lifecycle/buildGraphExecution.js";
import { acquireRunLease, createRun, releaseRunLease } from "../src/lifecycle/artifacts.js";

const temporaryDirectories: string[] = [];
const ownerToken = "build-graph-owner";
const now = "2026-07-22T00:00:00.000Z";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "build-graph-execution-"));
  temporaryDirectories.push(cwd);
  const run = createRun(cwd, ".ai-orchestrator/runs", "durable BUILD graph");
  const owner = acquireRunLease(run.paths, ownerToken);
  const graphOwner = acquireBuildGraphExecutionLease(run.paths, owner, {
    now,
    pid: process.pid,
  });
  const compiled = compileLegacySequentialBuildPlan("Implement it.", 1, ["src"]);
  return { run, compiled, owner, graphOwner };
}

function startEvent(state: ReturnType<typeof initializeBuildGraphExecution>): GraphEvent {
  return {
    schemaVersion: 1,
    kind: "node-status",
    sequence: state.lastAppliedEventSequence + 1,
    eventId: "start-legacy-build",
    runId: state.runId,
    graphId: state.graphId,
    graphVersion: state.graphVersion,
    graphDigest: state.graphDigest,
    planVersion: state.planVersion,
    nodeId: "legacy-build",
    priorStatus: "ready",
    nextStatus: "running",
    attempt: 1,
    timestamp: now,
    artifactRefs: [],
  };
}

describe("durable BUILD graph execution", () => {
  it("initializes idempotently and recovers an event appended before the snapshot rename", () => {
    const { run, compiled, owner, graphOwner } = fixture();
    const initial = initializeBuildGraphExecution(run.paths, compiled, {
      owner,
      graphOwner,
      now,
      pid: process.pid,
      limits: { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} },
    });
    expect(initial).toMatchObject({ runId: run.runId, planVersion: 1, ready: ["legacy-build"] });
    expect(() => checkpointBuildGraphEvent(run.paths, compiled, initial, startEvent(initial), {
      owner,
      graphOwner,
      tempId: "crash-after-event",
      failAt(point) {
        if (point === "after-event-append") throw new Error("simulated crash");
      },
    })).toThrow(/simulated crash/i);

    const recovered = recoverBuildGraphExecution(run.paths, compiled, {
      owner,
      graphOwner,
      tempId: "recover-event",
    });
    expect(recovered.nodeStates["legacy-build"]).toMatchObject({ status: "running", attempts: 1 });
    expect(initializeBuildGraphExecution(run.paths, compiled, {
      owner,
      graphOwner,
      now,
      pid: process.pid,
      limits: { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} },
    })).toEqual(recovered);
    expect(releaseBuildGraphExecution(run.paths, graphOwner)).toBe(true);
  });

  it("binds the checkpoint to one immutable plan and the outer lifecycle lease", () => {
    const { run, compiled, owner, graphOwner } = fixture();
    initializeBuildGraphExecution(run.paths, compiled, {
      owner,
      graphOwner,
      now,
      pid: process.pid,
      limits: { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} },
    });
    const changed = compileLegacySequentialBuildPlan("Different plan.", 1, ["src"]);
    expect(() => initializeBuildGraphExecution(run.paths, changed, {
      owner,
      graphOwner,
      now,
      pid: process.pid,
      limits: { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} },
    })).toThrow(/immutable graph checkpoint|immutable BUILD plan/i);
    expect(releaseBuildGraphExecution(run.paths, graphOwner)).toBe(true);
    expect(releaseRunLease(run.paths, owner)).toBe(true);
    expect(() => recoverBuildGraphExecution(run.paths, compiled, {
      owner,
      graphOwner,
      tempId: "without-lifecycle-lease",
    }))
      .toThrow(/lifecycle lease/i);
    expect(buildGraphExecutionPaths(run.paths).root).toContain(`${join("build", "execution")}`);
  });

  it("rejects a current nested lease inherited from a stale outer lifecycle generation", () => {
    const { run, compiled, owner, graphOwner } = fixture();
    expect(releaseRunLease(run.paths, owner)).toBe(true);
    const replacement = acquireRunLease(run.paths, "replacement-build-owner");

    expect(() => initializeBuildGraphExecution(run.paths, compiled, {
      owner: replacement,
      graphOwner,
      now,
      pid: process.pid,
      limits: { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} },
    })).toThrow(/active lifecycle generation/i);

    expect(releaseBuildGraphExecution(run.paths, graphOwner)).toBe(true);
    expect(releaseRunLease(run.paths, replacement)).toBe(true);
  });

  it("keeps every immutable plan version in a distinct recoverable graph namespace", () => {
    const { run, compiled, owner, graphOwner } = fixture();
    const second = compileLegacySequentialBuildPlan("Implement the successor.", 2, ["src"]);
    const secondOwner = acquireBuildGraphExecutionLease(run.paths, owner, {
      now,
      pid: process.pid,
      planVersion: 2,
    });

    const firstState = initializeBuildGraphExecution(run.paths, compiled, {
      owner,
      graphOwner,
      now,
      pid: process.pid,
      limits: { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} },
    });
    const secondState = initializeBuildGraphExecution(run.paths, second, {
      owner,
      graphOwner: secondOwner,
      now,
      pid: process.pid,
      limits: { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} },
    });

    expect(firstState.planVersion).toBe(1);
    expect(secondState.planVersion).toBe(2);
    expect(buildGraphExecutionPaths(run.paths, 1).root).not.toBe(buildGraphExecutionPaths(run.paths, 2).root);
    expect(recoverBuildGraphExecution(run.paths, compiled, {
      owner,
      graphOwner,
      tempId: "recover-first-version",
    }).planVersion).toBe(1);
    expect(recoverBuildGraphExecution(run.paths, second, {
      owner,
      graphOwner: secondOwner,
      tempId: "recover-second-version",
    }).planVersion).toBe(2);

    expect(releaseBuildGraphExecution(run.paths, graphOwner, 1)).toBe(true);
    expect(releaseBuildGraphExecution(run.paths, secondOwner, 2)).toBe(true);
  });
});
