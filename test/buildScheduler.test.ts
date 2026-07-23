import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  compileBuildPlan,
  type BuildNode,
  type BuildPlan,
} from "../src/core/buildPlan.js";
import {
  planBuildDispatch,
  validateBuildNodeOutputs,
  type BuildArtifactInspection,
  type BuildOutputValidationAdapter,
  type BuildWorkspaceInspection,
  type BuildWorktreeOwnershipProof,
} from "../src/core/buildScheduler.js";
import {
  DEFAULT_EXECUTION_LIMITS,
  applySchedulerEvent,
  createGraphExecutionState,
  type ArtifactReference,
  type GraphEvent,
  type GraphExecutionState,
} from "../src/core/scheduler.js";

const now = "2026-07-22T00:00:00.000Z";

function node(id: string, overrides: Partial<BuildNode> = {}): BuildNode {
  return {
    id,
    handler: "inspect",
    priority: 0,
    objective: `Complete ${id}.`,
    instructions: [`Perform the ${id} task.`],
    acceptanceCriteria: [`${id} produces its declared output.`],
    verificationCommands: [],
    inputContracts: [],
    outputContracts: [{ id: `${id}-output`, kind: "artifact", validation: "sha256" }],
    toolPolicy: "read-only",
    sideEffect: "read",
    workspace: "shared",
    idempotency: "read-replay-safe",
    resourceLocks: [],
    writeSet: [],
    retryLimit: 0,
    timeoutMs: 1_000,
    ...overrides,
  };
}

function plan(): BuildPlan {
  return {
    schemaVersion: 1,
    id: "parallel-build",
    planVersion: 1,
    summary: "Inspect, design, implement isolated patches, validate, and pause for integration.",
    entry: "inspect",
    exit: "integrate",
    nodes: [
      node("inspect", {
        priority: 20,
        outputContracts: [{ id: "inventory", kind: "artifact", validation: "sha256" }],
      }),
      node("design", {
        handler: "design",
        priority: 10,
        inputContracts: ["inventory"],
        outputContracts: [{ id: "design", kind: "artifact", validation: "structured", validatorRef: "build-design-schema" }],
      }),
      node("implement-a", {
        handler: "implement",
        priority: 5,
        inputContracts: ["design"],
        outputContracts: [{ id: "patch-a", kind: "file-set", validation: "sha256" }],
        toolPolicy: "declared-writes",
        sideEffect: "write",
        workspace: "isolated-worktree",
        idempotency: "keyed",
        resourceLocks: [{ kind: "path", value: "src/a.ts", mode: "exclusive" }],
        writeSet: ["src/a.ts"],
        retryLimit: 1,
      }),
      node("implement-b", {
        handler: "implement",
        priority: 5,
        inputContracts: ["design"],
        outputContracts: [{ id: "patch-b", kind: "file-set", validation: "sha256" }],
        toolPolicy: "declared-writes",
        sideEffect: "write",
        workspace: "isolated-worktree",
        idempotency: "keyed",
        resourceLocks: [{ kind: "path", value: "src/b.ts", mode: "exclusive" }],
        writeSet: ["src/b.ts"],
        retryLimit: 1,
      }),
      node("validate-a", {
        handler: "validate",
        priority: 2,
        inputContracts: ["patch-a"],
        outputContracts: [{ id: "verification-a", kind: "evidence", validation: "reviewed-command", validatorRef: "project-test-command" }],
        toolPolicy: "reviewed-validation",
        workspace: "isolated-worktree",
        targetWorktreeNodeId: "implement-a",
      }),
      node("validate-b", {
        handler: "validate",
        priority: 2,
        inputContracts: ["patch-b"],
        outputContracts: [{ id: "verification-b", kind: "evidence", validation: "reviewed-command", validatorRef: "project-test-command" }],
        toolPolicy: "reviewed-validation",
        workspace: "isolated-worktree",
        targetWorktreeNodeId: "implement-b",
      }),
      node("integrate", {
        handler: "integrate",
        inputContracts: ["verification-a", "verification-b"],
        outputContracts: [{ id: "integration-decision", kind: "evidence", validation: "human-review", validatorRef: "candidate-integration-gate" }],
        toolPolicy: "human-integration",
        sideEffect: "external",
        idempotency: "none",
      }),
    ],
    dependencies: [
      { from: "inspect", to: "design", contracts: ["inventory"] },
      { from: "design", to: "implement-a", contracts: ["design"] },
      { from: "design", to: "implement-b", contracts: ["design"] },
      { from: "implement-a", to: "validate-a", contracts: ["patch-a"] },
      { from: "implement-b", to: "validate-b", contracts: ["patch-b"] },
      { from: "validate-a", to: "integrate", contracts: ["verification-a"] },
      { from: "validate-b", to: "integrate", contracts: ["verification-b"] },
    ],
    joins: [{ nodeId: "integrate", mode: "all_of" }],
  };
}

function executionState(input: BuildPlan = plan()): {
  compiled: ReturnType<typeof compileBuildPlan>;
  state: GraphExecutionState;
} {
  const compiled = compileBuildPlan(input);
  const state = createGraphExecutionState(compiled.graph, {
    runId: "build-run-1",
    now,
    planVersion: compiled.plan.planVersion,
    metadata: compiled.schedulerMetadata,
    limits: { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} },
  });
  return { compiled, state };
}

function artifact(state: GraphExecutionState, nodeId: string, contract: string): ArtifactReference {
  return {
    planVersion: state.planVersion,
    nodeId,
    contract,
    path: `nodes/${state.planVersion}/${nodeId}/${contract}.json`,
    sha256: "a".repeat(64),
    sizeBytes: 12,
  };
}

function ownerships(
  compiled: ReturnType<typeof compileBuildPlan>,
  state: GraphExecutionState,
  ...nodeIds: string[]
): BuildWorktreeOwnershipProof[] {
  return nodeIds.map((nodeId) => ({
    schemaVersion: 1,
    intentId: createHash("sha256").update(`${state.runId}\0${compiled.hash}\0${nodeId}`).digest("hex"),
    runId: state.runId,
    nodeId,
    planVersion: state.planVersion,
    planHash: compiled.hash,
    baseSha: "b".repeat(40),
    reconciled: true,
    cleanupStatus: "active",
  }));
}

function validationAdapter(
  mutate?: (inspection: BuildArtifactInspection) => BuildArtifactInspection,
  inspectWorkspace?: BuildOutputValidationAdapter["inspectWorkspace"],
): BuildOutputValidationAdapter {
  return {
    inspect({ artifact: inspected, contract }) {
      const inspection: BuildArtifactInspection = {
        exists: true,
        sha256: inspected.sha256,
        sizeBytes: inspected.sizeBytes,
        ...(contract.validation === "structured" ? {
          structured: { validatorRef: contract.validatorRef!, valid: true },
        } : {}),
        ...(contract.validation === "reviewed-command" ? {
          reviewedCommand: {
            validatorRef: contract.validatorRef!,
            approved: true,
            exitCode: 0,
            evidenceSha256: inspected.sha256,
          },
        } : {}),
      };
      return mutate ? mutate(inspection) : inspection;
    },
    ...(inspectWorkspace === undefined ? {} : { inspectWorkspace }),
  };
}

function workspaceInspection(
  compiled: ReturnType<typeof compileBuildPlan>,
  state: GraphExecutionState,
  targetWorktreeNodeId: string,
  overrides: Partial<BuildWorkspaceInspection> = {},
): BuildWorkspaceInspection {
  const target = compiled.plan.nodes.find(({ id }) => id === targetWorktreeNodeId)!;
  return {
    schemaVersion: 1,
    ownership: ownerships(compiled, state, targetWorktreeNodeId)[0]!,
    changedPaths: [...target.writeSet],
    stagedPaths: [],
    ...overrides,
  };
}

function sideEffectEvent(
  state: GraphExecutionState,
  nodeId: string,
  phase: "intent" | "result",
  idempotencyKey: string,
): GraphEvent {
  return {
    schemaVersion: 1,
    kind: phase === "intent" ? "side-effect-intent" : "side-effect-result",
    sequence: state.lastAppliedEventSequence + 1,
    eventId: `build-effect-${state.lastAppliedEventSequence + 1}`,
    requestRef: createHash("sha256").update(idempotencyKey).digest("hex"),
    runId: state.runId,
    graphId: state.graphId,
    graphVersion: state.graphVersion,
    graphDigest: state.graphDigest,
    planVersion: state.planVersion,
    nodeId,
    priorStatus: "running",
    nextStatus: "running",
    attempt: state.nodeStates[nodeId]!.attempts,
    timestamp: now,
    artifactRefs: [],
    sideEffect: phase === "intent"
      ? { phase, idempotencyKey, class: "write" }
      : { phase, idempotencyKey, class: "write", outcome: "failed" },
  };
}

function event(
  state: GraphExecutionState,
  nodeId: string,
  nextStatus: GraphEvent["nextStatus"],
  refs: ArtifactReference[] = [],
): GraphEvent {
  const priorStatus = state.nodeStates[nodeId]!.status;
  return {
    schemaVersion: 1,
    kind: "node-status",
    sequence: state.lastAppliedEventSequence + 1,
    eventId: `build-event-${state.lastAppliedEventSequence + 1}`,
    runId: state.runId,
    graphId: state.graphId,
    graphVersion: state.graphVersion,
    graphDigest: state.graphDigest,
    planVersion: state.planVersion,
    nodeId,
    priorStatus,
    nextStatus,
    attempt: nextStatus === "running" ? state.nodeStates[nodeId]!.attempts + 1 : state.nodeStates[nodeId]!.attempts,
    timestamp: now,
    artifactRefs: refs,
    ...(refs.length > 0
      ? { validatorResult: { status: "passed" as const, contracts: refs.map(({ contract }) => contract) } }
      : {}),
  };
}

function execute(
  compiled: ReturnType<typeof compileBuildPlan>,
  state: GraphExecutionState,
  nodeId: string,
): GraphExecutionState {
  const running = start(compiled, state, nodeId);
  const refs = compiled.plan.nodes.find((candidate) => candidate.id === nodeId)!.outputContracts
    .map(({ id }) => artifact(running, nodeId, id));
  return applySchedulerEvent(compiled.graph, running, event(running, nodeId, "executed", refs), compiled.schedulerMetadata);
}

function start(
  compiled: ReturnType<typeof compileBuildPlan>,
  state: GraphExecutionState,
  nodeId: string,
): GraphExecutionState {
  return applySchedulerEvent(compiled.graph, state, event(state, nodeId, "running"), compiled.schedulerMetadata);
}

function readyImplementers() {
  const value = executionState();
  value.state = execute(value.compiled, value.state, "inspect");
  value.state = execute(value.compiled, value.state, "design");
  return value;
}

describe("BUILD DAG dispatch", () => {
  it("uses deterministic ready order and keeps parallel writes disabled without every trusted gate", () => {
    const { compiled, state } = readyImplementers();

    const denied = planBuildDispatch(compiled, state, {
      now,
      unattended: false,
      allowParallelWrites: false,
      trustRepositoryCheckout: false,
      worktreeOwnerships: [],
    });
    expect(denied.dispatch.map(({ nodeId }) => nodeId)).toEqual([]);
    expect(denied.blocked).toEqual([
      { nodeId: "implement-a", code: "worktree-not-owned" },
      { nodeId: "implement-b", code: "worktree-not-owned" },
    ]);

    const missingTrust = planBuildDispatch(compiled, state, {
      now,
      unattended: false,
      allowParallelWrites: true,
      trustRepositoryCheckout: false,
      worktreeOwnerships: ownerships(compiled, state, "implement-a", "implement-b"),
    });
    expect(missingTrust.dispatch).toEqual([]);
    expect(missingTrust.blocked.every(({ code }) => code === "checkout-trust-required")).toBe(true);
  });

  it("dispatches non-conflicting isolated writes together only after trusted ownership", () => {
    const { compiled, state } = readyImplementers();
    const result = planBuildDispatch(compiled, state, {
      now,
      unattended: false,
      allowParallelWrites: true,
      trustRepositoryCheckout: true,
      worktreeOwnerships: ownerships(compiled, state, "implement-b", "implement-a"),
    });

    expect(result.dispatch.map(({ nodeId }) => nodeId)).toEqual(["implement-a", "implement-b"]);
    expect(result.dispatch.every(({ workspace }) => workspace === "isolated-worktree")).toBe(true);
    expect(result.dispatch.every(({ idempotencyKey }) => /^[a-f0-9]{64}$/.test(idempotencyKey))).toBe(true);
    expect(result.blocked).toEqual([]);
  });

  it("binds ownership to run, plan identity, base, and active cleanup state", () => {
    const { compiled, state } = readyImplementers();
    const valid = ownerships(compiled, state, "implement-a")[0]!;
    for (const forged of [
      { ...valid, runId: "another-run" },
      { ...valid, planVersion: valid.planVersion + 1 },
      { ...valid, planHash: "f".repeat(64) },
      { ...valid, baseSha: "not-a-sha" },
      { ...valid, reconciled: false },
      { ...valid, cleanupStatus: "released" },
    ]) {
      expect(() => planBuildDispatch(compiled, state, {
        now,
        unattended: false,
        allowParallelWrites: false,
        trustRepositoryCheckout: true,
        worktreeOwnerships: [forged] as BuildWorktreeOwnershipProof[],
      })).toThrow(/ownership.*identity/i);
    }
  });

  it("dispatches independent validators inside their candidate worktrees", () => {
    const { compiled, state: initial } = readyImplementers();
    let state = execute(compiled, initial, "implement-a");
    state = execute(compiled, state, "implement-b");
    const result = planBuildDispatch(compiled, state, {
      now,
      unattended: false,
      allowParallelWrites: true,
      trustRepositoryCheckout: true,
      worktreeOwnerships: ownerships(compiled, state, "implement-a", "implement-b"),
    });

    expect(result.dispatch).toMatchObject([
      { nodeId: "validate-a", targetWorktreeNodeId: "implement-a" },
      { nodeId: "validate-b", targetWorktreeNodeId: "implement-b" },
    ]);
    expect(result.dispatch.every(({ worktreeOwnershipId }) => /^[a-f0-9]{64}$/.test(worktreeOwnershipId ?? ""))).toBe(true);
  });

  it("serializes otherwise-safe isolated writers when parallel writes are not trusted", () => {
    const { compiled, state } = readyImplementers();
    const result = planBuildDispatch(compiled, state, {
      now,
      unattended: false,
      allowParallelWrites: false,
      trustRepositoryCheckout: true,
      worktreeOwnerships: ownerships(compiled, state, "implement-a", "implement-b"),
    });

    expect(result.dispatch.map(({ nodeId }) => nodeId)).toEqual(["implement-a"]);
    expect(result.blocked).toContainEqual({ nodeId: "implement-b", code: "parallel-write-disabled" });
  });

  it("binds a persisted retry idempotency key to the exact worktree ownership", () => {
    const value = readyImplementers();
    const originalOwnership = ownerships(value.compiled, value.state, "implement-a")[0]!;
    const first = planBuildDispatch(value.compiled, value.state, {
      now,
      unattended: false,
      allowParallelWrites: false,
      trustRepositoryCheckout: true,
      worktreeOwnerships: [originalOwnership],
    }).dispatch[0]!.idempotencyKey;
    value.state = start(value.compiled, value.state, "implement-a");
    value.state = applySchedulerEvent(
      value.compiled.graph,
      value.state,
      sideEffectEvent(value.state, "implement-a", "intent", first),
      value.compiled.schedulerMetadata,
    );
    value.state = applySchedulerEvent(
      value.compiled.graph,
      value.state,
      sideEffectEvent(value.state, "implement-a", "result", first),
      value.compiled.schedulerMetadata,
    );
    value.state = applySchedulerEvent(value.compiled.graph, value.state, {
      ...event(value.state, "implement-a", "failed_retryable"),
      errorCategory: "transient",
    }, value.compiled.schedulerMetadata);
    value.state = applySchedulerEvent(
      value.compiled.graph,
      value.state,
      event(value.state, "implement-a", "ready"),
      value.compiled.schedulerMetadata,
    );

    const retry = planBuildDispatch(value.compiled, value.state, {
      now,
      unattended: false,
      allowParallelWrites: false,
      trustRepositoryCheckout: true,
      worktreeOwnerships: [originalOwnership],
    }).dispatch[0]!.idempotencyKey;
    expect(retry).toBe(first);

    const replacementOwnership: BuildWorktreeOwnershipProof = {
      ...originalOwnership,
      intentId: createHash("sha256").update("replacement-worktree").digest("hex"),
      baseSha: "c".repeat(40),
    };
    expect(() => planBuildDispatch(value.compiled, value.state, {
      now,
      unattended: false,
      allowParallelWrites: false,
      trustRepositoryCheckout: true,
      worktreeOwnerships: [replacementOwnership],
    })).toThrow(/idempotency|ownership|worktree/i);
  });

  it("rejects scheduler state from a different immutable BUILD plan version", () => {
    const { compiled } = executionState();
    const mismatched = createGraphExecutionState(compiled.graph, {
      runId: "build-run-1",
      now,
      planVersion: compiled.plan.planVersion + 1,
      metadata: compiled.schedulerMetadata,
      limits: { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} },
    });

    expect(() => planBuildDispatch(compiled, mismatched, {
      now,
      unattended: false,
      allowParallelWrites: false,
      trustRepositoryCheckout: false,
      worktreeOwnerships: [],
    })).toThrow(/immutable BUILD plan version/i);
  });

  it("rejects non-canonical or accessor-backed dispatch policy without evaluating accessors", () => {
    const { compiled, state } = readyImplementers();
    expect(() => planBuildDispatch(compiled, state, {
      now: "2026-07-22T00:00:00Z",
      unattended: false,
      allowParallelWrites: false,
      trustRepositoryCheckout: true,
      worktreeOwnerships: ownerships(compiled, state, "implement-a"),
    })).toThrow(/ISO timestamp/i);

    let accessed = false;
    const proof = ownerships(compiled, state, "implement-a")[0]!;
    const owned = [proof];
    Object.defineProperty(owned, "0", {
      enumerable: true,
      get: () => {
        accessed = true;
        return proof;
      },
    });
    expect(() => planBuildDispatch(compiled, state, {
      now,
      unattended: false,
      allowParallelWrites: false,
      trustRepositoryCheckout: true,
      worktreeOwnerships: owned,
    })).toThrow(/array/i);
    expect(accessed).toBe(false);

    class HostileOwnerships extends Array<BuildWorktreeOwnershipProof> {}
    const hostileOwned = new HostileOwnerships(proof);
    expect(() => planBuildDispatch(compiled, state, {
      now,
      unattended: false,
      allowParallelWrites: false,
      trustRepositoryCheckout: true,
      worktreeOwnerships: hostileOwned,
    })).toThrow(/array/i);
  });

  it("respects frozen graph concurrency and step ceilings across the whole proposed batch", () => {
    const { compiled, state } = readyImplementers();
    // The scheduler fingerprints frozen limits; create a fresh state with the
    // constrained policy instead of mutating authority in place.
    const constrained = createGraphExecutionState(compiled.graph, {
      runId: state.runId,
      now,
      planVersion: state.planVersion,
      metadata: compiled.schedulerMetadata,
      limits: { ...DEFAULT_EXECUTION_LIMITS, maxConcurrency: 1, maxGraphSteps: 3, backEdgeBudgets: {} },
    });
    let progressed = execute(compiled, constrained, "inspect");
    progressed = execute(compiled, progressed, "design");

    const result = planBuildDispatch(compiled, progressed, {
      now,
      unattended: false,
      allowParallelWrites: true,
      trustRepositoryCheckout: true,
      worktreeOwnerships: ownerships(compiled, progressed, "implement-a", "implement-b"),
    });
    expect(result.dispatch.map(({ nodeId }) => nodeId)).toEqual(["implement-a"]);
    expect(result.blocked).toContainEqual({ nodeId: "implement-b", code: "concurrency-limit" });
  });

  it("blocks conflicting logical locks and serializes shared-workspace mutation", () => {
    const input = plan();
    for (const id of ["implement-a", "implement-b"]) {
      input.nodes.find((candidate) => candidate.id === id)!.resourceLocks.push({
        kind: "logical",
        value: "generated-schema",
        mode: "exclusive",
      });
    }
    const { compiled, state } = executionState(input);
    let ready = execute(compiled, state, "inspect");
    ready = execute(compiled, ready, "design");
    const locked = planBuildDispatch(compiled, ready, {
      now,
      unattended: false,
      allowParallelWrites: true,
      trustRepositoryCheckout: true,
      worktreeOwnerships: ownerships(compiled, ready, "implement-a", "implement-b"),
    });
    expect(locked.dispatch.map(({ nodeId }) => nodeId)).toEqual(["implement-a"]);
    expect(locked.blocked).toContainEqual({ nodeId: "implement-b", code: "resource-conflict" });

    const sharedPlan = plan();
    sharedPlan.nodes.find(({ id }) => id === "implement-a")!.workspace = "shared";
    const sharedValidation = sharedPlan.nodes.find(({ id }) => id === "validate-a")!;
    sharedValidation.workspace = "shared";
    delete sharedValidation.targetWorktreeNodeId;
    const shared = executionState(sharedPlan);
    shared.state = execute(shared.compiled, shared.state, "inspect");
    shared.state = execute(shared.compiled, shared.state, "design");
    const serialized = planBuildDispatch(shared.compiled, shared.state, {
      now,
      unattended: false,
      allowParallelWrites: true,
      trustRepositoryCheckout: true,
      worktreeOwnerships: ownerships(shared.compiled, shared.state, "implement-b"),
    });
    expect(serialized.dispatch.map(({ nodeId }) => nodeId)).toEqual(["implement-a"]);
    expect(serialized.blocked).toContainEqual({ nodeId: "implement-b", code: "shared-workspace-busy" });
  });

  it("never dispatches the integration handler and requires human review", () => {
    const { compiled, state: initial } = readyImplementers();
    let state = execute(compiled, initial, "implement-a");
    state = execute(compiled, state, "implement-b");
    state = execute(compiled, state, "validate-a");
    state = execute(compiled, state, "validate-b");

    const result = planBuildDispatch(compiled, state, {
      now,
      unattended: false,
      allowParallelWrites: true,
      trustRepositoryCheckout: true,
      worktreeOwnerships: [],
    });
    expect(result.dispatch).toEqual([]);
    expect(result.humanIntegrationNodeId).toBe("integrate");
    expect(result.blocked).toEqual([{ nodeId: "integrate", code: "human-integration-required" }]);
  });
});

describe("BUILD output contracts", () => {
  it("fails closed when isolated output completion omits trusted workspace inspection", () => {
    const value = readyImplementers();
    value.state = start(value.compiled, value.state, "implement-a");
    const reference = artifact(value.state, "implement-a", "patch-a");
    let artifactInspected = false;
    const adapter = validationAdapter((inspection) => {
      artifactInspected = true;
      return inspection;
    });

    expect(() => validateBuildNodeOutputs(value.compiled, value.state, "implement-a", [{
      contractId: "patch-a",
      validation: "sha256",
      artifact: reference,
    }], adapter)).toThrow(/workspace.*inspection|inspection.*workspace/i);
    expect(artifactInspected).toBe(false);
  });

  it("returns canonical artifact references only after every declared validator passes", () => {
    const value = readyImplementers();
    value.state = start(value.compiled, value.state, "implement-a");
    const reference = artifact(value.state, "implement-a", "patch-a");
    const validated = validateBuildNodeOutputs(value.compiled, value.state, "implement-a", [{
      contractId: "patch-a",
      validation: "sha256",
      artifact: reference,
    }], validationAdapter(undefined, () => workspaceInspection(value.compiled, value.state, "implement-a")));
    expect(validated).toEqual([reference]);
    expect(Object.isFrozen(validated[0])).toBe(true);
  });

  it("rejects missing, duplicate, failed, wrong-policy, cross-node, and undeclared output evidence", () => {
    const value = readyImplementers();
    value.state = start(value.compiled, value.state, "implement-a");
    const { compiled, state } = value;
    const reference = artifact(state, "implement-a", "patch-a");
    const valid = {
      contractId: "patch-a",
      validation: "sha256" as const,
      artifact: reference,
    };
    const adapter = validationAdapter(undefined, () => workspaceInspection(compiled, state, "implement-a"));

    expect(() => validateBuildNodeOutputs(compiled, state, "implement-a", [], adapter)).toThrow(/exactly match/i);
    expect(() => validateBuildNodeOutputs(compiled, state, "implement-a", [valid, valid], adapter)).toThrow(/duplicate/i);
    expect(() => validateBuildNodeOutputs(compiled, state, "implement-a", [{ ...valid, status: "passed" }], adapter))
      .toThrow(/unsupported fields/i);
    expect(() => validateBuildNodeOutputs(compiled, state, "implement-a", [{ ...valid, validation: "exists" }], adapter))
      .toThrow(/validation policy/i);
    expect(() => validateBuildNodeOutputs(compiled, state, "implement-a", [{
      ...valid,
      artifact: { ...reference, nodeId: "implement-b" },
    }], adapter)).toThrow(/artifact identity/i);
    expect(() => validateBuildNodeOutputs(compiled, state, "implement-a", [{
      ...valid,
      contractId: "undeclared",
      artifact: { ...reference, contract: "undeclared" },
    }], adapter)).toThrow(/exactly match/i);
  });

  it("rejects non-canonical artifact paths, oversized artifacts, and accessors without evaluating them", () => {
    const value = readyImplementers();
    value.state = start(value.compiled, value.state, "implement-a");
    const { compiled, state } = value;
    const reference = artifact(state, "implement-a", "patch-a");
    const observe = (candidate: ArtifactReference) => [{
      contractId: "patch-a",
      validation: "sha256" as const,
      artifact: candidate,
    }];
    const adapter = validationAdapter(undefined, () => workspaceInspection(compiled, state, "implement-a"));

    expect(() => validateBuildNodeOutputs(compiled, state, "implement-a", observe({
      ...reference,
      path: `${reference.path}\\payload`,
    }), adapter)).toThrow(/artifact identity/i);
    expect(() => validateBuildNodeOutputs(compiled, state, "implement-a", observe({
      ...reference,
      sizeBytes: 64 * 1024 * 1024 + 1,
    }), adapter)).toThrow(/artifact identity/i);

    let accessed = false;
    const accessorArtifact = { ...reference };
    Object.defineProperty(accessorArtifact, "sha256", {
      enumerable: true,
      get: () => {
        accessed = true;
        return "a".repeat(64);
      },
    });
    expect(() => validateBuildNodeOutputs(
      compiled,
      state,
      "implement-a",
      observe(accessorArtifact),
      adapter,
    )).toThrow(/plain object/i);
    expect(accessed).toBe(false);
  });

  it("does not let an inspection adapter mutate validated artifact identity", () => {
    const value = readyImplementers();
    value.state = start(value.compiled, value.state, "implement-a");
    const reference = artifact(value.state, "implement-a", "patch-a");
    const malicious: BuildOutputValidationAdapter = {
      inspect({ artifact: inspected }) {
        (inspected as { path: string }).path = `nodes/${value.state.planVersion}/implement-a/forged.json`;
        return {
          exists: true,
          sha256: inspected.sha256,
          sizeBytes: inspected.sizeBytes,
        };
      },
      inspectWorkspace: () => workspaceInspection(value.compiled, value.state, "implement-a"),
    };

    expect(() => validateBuildNodeOutputs(value.compiled, value.state, "implement-a", [{
      contractId: "patch-a",
      validation: "sha256",
      artifact: reference,
    }], malicious)).toThrow();
    expect(reference.path).toBe(`nodes/${value.state.planVersion}/implement-a/patch-a.json`);
  });

  it("rejects staged, undeclared, and wrong-target workspace inspection evidence", () => {
    const value = readyImplementers();
    value.state = start(value.compiled, value.state, "implement-a");
    const reference = artifact(value.state, "implement-a", "patch-a");
    const observations = [{ contractId: "patch-a", validation: "sha256" as const, artifact: reference }];
    const inspect = (inspection: BuildWorkspaceInspection) => validationAdapter(undefined, () => inspection);

    expect(() => validateBuildNodeOutputs(value.compiled, value.state, "implement-a", observations, inspect(
      workspaceInspection(value.compiled, value.state, "implement-a", { stagedPaths: ["src/a.ts"] }),
    ))).toThrow(/staged/i);
    expect(() => validateBuildNodeOutputs(value.compiled, value.state, "implement-a", observations, inspect(
      workspaceInspection(value.compiled, value.state, "implement-a", { changedPaths: ["src/escape.ts"] }),
    ))).toThrow(/undeclared write/i);
    expect(() => validateBuildNodeOutputs(value.compiled, value.state, "implement-a", observations, inspect(
      workspaceInspection(value.compiled, value.state, "implement-a", {
        ownership: ownerships(value.compiled, value.state, "implement-b")[0]!,
      }),
    ))).toThrow(/wrong implement node/i);
  });

  it("reconciles and inspects an isolated validator's targeted candidate after its command passes", () => {
    const value = readyImplementers();
    value.state = execute(value.compiled, value.state, "implement-a");
    value.state = start(value.compiled, value.state, "validate-a");
    const reference = artifact(value.state, "validate-a", "verification-a");
    let target: string | undefined;

    expect(validateBuildNodeOutputs(value.compiled, value.state, "validate-a", [{
      contractId: "verification-a",
      validation: "reviewed-command",
      artifact: reference,
    }], validationAdapter(undefined, (input) => {
      target = input.targetWorktreeNodeId;
      return workspaceInspection(value.compiled, value.state, input.targetWorktreeNodeId);
    }))).toEqual([reference]);
    expect(target).toBe("implement-a");
  });

  it("rejects forged hashes, missing bytes, malformed structured output, and unapproved commands", () => {
    const implementation = readyImplementers();
    implementation.state = start(implementation.compiled, implementation.state, "implement-a");
    const patchRef = artifact(implementation.state, "implement-a", "patch-a");
    const patchObservation = [{ contractId: "patch-a", validation: "sha256" as const, artifact: patchRef }];
    expect(() => validateBuildNodeOutputs(
      implementation.compiled,
      implementation.state,
      "implement-a",
      patchObservation,
      validationAdapter(
        (inspection) => ({ ...inspection, sha256: "f".repeat(64) }),
        () => workspaceInspection(implementation.compiled, implementation.state, "implement-a"),
      ),
    )).toThrow(/inspected bytes.*artifact identity/i);
    expect(() => validateBuildNodeOutputs(
      implementation.compiled,
      implementation.state,
      "implement-a",
      patchObservation,
      validationAdapter(
        (inspection) => ({ ...inspection, exists: false }),
        () => workspaceInspection(implementation.compiled, implementation.state, "implement-a"),
      ),
    )).toThrow(/inspected bytes.*artifact identity/i);

    const design = executionState();
    design.state = execute(design.compiled, design.state, "inspect");
    design.state = start(design.compiled, design.state, "design");
    const designRef = artifact(design.state, "design", "design");
    expect(() => validateBuildNodeOutputs(design.compiled, design.state, "design", [{
      contractId: "design",
      validation: "structured",
      artifact: designRef,
    }], validationAdapter((inspection) => ({
      ...inspection,
      structured: { ...inspection.structured!, valid: false },
    })))).toThrow(/structured validator/i);

    const validation = readyImplementers();
    validation.state = execute(validation.compiled, validation.state, "implement-a");
    validation.state = start(validation.compiled, validation.state, "validate-a");
    const commandRef = artifact(validation.state, "validate-a", "verification-a");
    expect(() => validateBuildNodeOutputs(validation.compiled, validation.state, "validate-a", [{
      contractId: "verification-a",
      validation: "reviewed-command",
      artifact: commandRef,
    }], validationAdapter(
      (inspection) => ({
        ...inspection,
        reviewedCommand: { ...inspection.reviewedCommand!, approved: false, exitCode: 1 },
      }),
      () => workspaceInspection(validation.compiled, validation.state, "implement-a"),
    ))).toThrow(/reviewed command/i);
  });
});
