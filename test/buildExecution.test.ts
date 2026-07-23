import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compileBuildPlan, type BuildNode, type BuildPlan } from "../src/core/buildPlan.js";
import {
  BUILD_EFFECT_ORDINAL,
  assertHumanIntegrationDecision,
  buildEffectReceiptSha256,
  buildEffectIdentity,
  createBuildHumanIntegrationAction,
  createBuildHumanIntegrationResultEvent,
  createBuildHumanWaitEvent,
  planBuildNodeStarts,
  planRunningBuildActions,
  type BuildDispatchCheckpoint,
  type BuildExecutionPolicy,
} from "../src/core/buildExecution.js";
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
    id: "runtime-build",
    planVersion: 1,
    summary: "Run bounded reads, isolated candidates, validation, and an explicit integration gate.",
    entry: "inspect-a",
    exit: "integrate",
    nodes: [
      node("inspect-a", { priority: 10, outputContracts: [{ id: "inventory-a", kind: "artifact", validation: "sha256" }] }),
      node("inspect-b", {
        priority: 9,
        inputContracts: ["inventory-a"],
        outputContracts: [{ id: "inventory-b", kind: "artifact", validation: "sha256" }],
      }),
      node("implement-a", {
        handler: "implement",
        inputContracts: ["inventory-a", "inventory-b"],
        outputContracts: [{ id: "patch-a", kind: "file-set", validation: "sha256" }],
        toolPolicy: "declared-writes",
        sideEffect: "write",
        workspace: "isolated-worktree",
        idempotency: "keyed",
        resourceLocks: [{ kind: "path", value: "src/a.ts", mode: "exclusive" }],
        writeSet: ["src/a.ts"],
      }),
      node("implement-b", {
        handler: "implement",
        inputContracts: ["inventory-a", "inventory-b"],
        outputContracts: [{ id: "patch-b", kind: "file-set", validation: "sha256" }],
        toolPolicy: "declared-writes",
        sideEffect: "write",
        workspace: "isolated-worktree",
        idempotency: "keyed",
        resourceLocks: [{ kind: "path", value: "src/b.ts", mode: "exclusive" }],
        writeSet: ["src/b.ts"],
      }),
      node("validate-a", {
        handler: "validate",
        inputContracts: ["patch-a"],
        outputContracts: [{ id: "validated-a", kind: "evidence", validation: "reviewed-command", validatorRef: "test-command" }],
        toolPolicy: "reviewed-validation",
        workspace: "isolated-worktree",
        targetWorktreeNodeId: "implement-a",
      }),
      node("validate-b", {
        handler: "validate",
        inputContracts: ["patch-b"],
        outputContracts: [{ id: "validated-b", kind: "evidence", validation: "reviewed-command", validatorRef: "test-command" }],
        toolPolicy: "reviewed-validation",
        workspace: "isolated-worktree",
        targetWorktreeNodeId: "implement-b",
      }),
      node("integrate", {
        handler: "integrate",
        inputContracts: ["validated-a", "validated-b"],
        outputContracts: [{ id: "integration-decision", kind: "evidence", validation: "human-review", validatorRef: "integration-gate" }],
        toolPolicy: "human-integration",
        sideEffect: "external",
        idempotency: "none",
      }),
    ],
    dependencies: [
      { from: "inspect-a", to: "inspect-b", contracts: ["inventory-a"] },
      { from: "inspect-a", to: "implement-a", contracts: ["inventory-a"] },
      { from: "inspect-a", to: "implement-b", contracts: ["inventory-a"] },
      { from: "inspect-b", to: "implement-a", contracts: ["inventory-b"] },
      { from: "inspect-b", to: "implement-b", contracts: ["inventory-b"] },
      { from: "implement-a", to: "validate-a", contracts: ["patch-a"] },
      { from: "implement-b", to: "validate-b", contracts: ["patch-b"] },
      { from: "validate-a", to: "integrate", contracts: ["validated-a"] },
      { from: "validate-b", to: "integrate", contracts: ["validated-b"] },
    ],
    joins: [
      { nodeId: "implement-a", mode: "all_of" },
      { nodeId: "implement-b", mode: "all_of" },
      { nodeId: "integrate", mode: "all_of" },
    ],
  };
}

function readFanOutPlan(): BuildPlan {
  return {
    schemaVersion: 1,
    id: "read-fan-out",
    planVersion: 1,
    summary: "Inspect once, run two independent read-only analyses, and join their evidence.",
    entry: "root",
    exit: "join",
    nodes: [
      node("root", { outputContracts: [{ id: "root-output", kind: "artifact", validation: "sha256" }] }),
      node("read-a", {
        inputContracts: ["root-output"],
        outputContracts: [{ id: "read-a-output", kind: "artifact", validation: "sha256" }],
      }),
      node("read-b", {
        inputContracts: ["root-output"],
        outputContracts: [{ id: "read-b-output", kind: "artifact", validation: "sha256" }],
      }),
      node("join", {
        handler: "design",
        inputContracts: ["read-a-output", "read-b-output"],
        outputContracts: [{ id: "joined-output", kind: "artifact", validation: "sha256" }],
      }),
    ],
    dependencies: [
      { from: "root", to: "read-a", contracts: ["root-output"] },
      { from: "root", to: "read-b", contracts: ["root-output"] },
      { from: "read-a", to: "join", contracts: ["read-a-output"] },
      { from: "read-b", to: "join", contracts: ["read-b-output"] },
    ],
    joins: [{ nodeId: "join", mode: "all_of" }],
  };
}

function setup(): { compiled: ReturnType<typeof compileBuildPlan>; state: GraphExecutionState } {
  const compiled = compileBuildPlan(plan());
  return {
    compiled,
    state: createGraphExecutionState(compiled.graph, {
      runId: "build-run-1",
      now,
      planVersion: 1,
      metadata: compiled.schedulerMetadata,
      limits: { ...DEFAULT_EXECUTION_LIMITS, maxConcurrency: 2, backEdgeBudgets: {} },
    }),
  };
}

function policy(overrides: Partial<BuildExecutionPolicy> = {}): BuildExecutionPolicy {
  return {
    now,
    unattended: false,
    maxReadOnlyFanOut: 2,
    allowParallelWrites: false,
    allowWorktreeCreation: false,
    trustRepositoryCheckout: false,
    ...overrides,
  };
}

function statusEvent(
  state: GraphExecutionState,
  nodeId: string,
  nextStatus: GraphEvent["nextStatus"],
  artifactRefs: ArtifactReference[] = [],
): GraphEvent {
  return {
    schemaVersion: 1,
    kind: "node-status",
    sequence: state.lastAppliedEventSequence + 1,
    eventId: `event-${state.lastAppliedEventSequence + 1}`,
    runId: state.runId,
    graphId: state.graphId,
    graphVersion: state.graphVersion,
    graphDigest: state.graphDigest,
    planVersion: state.planVersion,
    nodeId,
    priorStatus: state.nodeStates[nodeId]!.status,
    nextStatus,
    attempt: nextStatus === "running" ? state.nodeStates[nodeId]!.attempts + 1 : state.nodeStates[nodeId]!.attempts,
    timestamp: now,
    artifactRefs,
    ...(artifactRefs.length === 0 ? {} : {
      validatorResult: { status: "passed" as const, contracts: artifactRefs.map(({ contract }) => contract) },
    }),
  };
}

function succeededCheckpoint(
  action: Readonly<ReturnType<typeof createBuildHumanIntegrationAction>>,
  receipt: unknown,
): BuildDispatchCheckpoint {
  const { kind: _kind, ...effect } = action;
  return {
    ...effect,
    schemaVersion: 1,
    status: "succeeded",
    resultRef: buildEffectReceiptSha256(action, receipt),
    recordedAt: now,
  };
}

function trustedIntegrationReceipt(
  decision: Readonly<Record<string, unknown>>,
  evidence?: Readonly<ArtifactReference>,
) {
  return {
    schemaVersion: 1 as const,
    kind: "trusted-human-integration" as const,
    decisionRef: createHash("sha256").update(stableJson(decision)).digest("hex"),
    confirmationRef: "d".repeat(64),
    inspectedBy: "trusted-runtime-git" as const,
    candidateEvidence: ["implement-a", "implement-b"].map((nodeId, index) => ({
      nodeId,
      ownershipReceiptHash: `${index + 1}`.repeat(64),
      candidateHead: `${index + 1}`.repeat(40),
      diffSha256: `${index + 3}`.repeat(64),
      validationArtifactSha256: ["a".repeat(64)],
    })),
    mainWorkspaceInspection: {
      headBefore: decision.mainWorkspaceHeadBefore,
      headAfter: decision.mainWorkspaceHeadAfter,
      statusBeforeSha256: "6".repeat(64),
      statusAfterSha256: "7".repeat(64),
      conflictCheckSha256: "8".repeat(64),
    },
    ...(evidence === undefined ? {} : { artifactRef: evidence }),
    recordedAt: decision.recordedAt,
  };
}

function executeNode(
  compiled: ReturnType<typeof compileBuildPlan>,
  state: GraphExecutionState,
  nodeId: string,
): GraphExecutionState {
  const running = applySchedulerEvent(
    compiled.graph,
    state,
    statusEvent(state, nodeId, "running"),
    compiled.schedulerMetadata,
  );
  const artifactRefs = compiled.plan.nodes.find(({ id }) => id === nodeId)!.outputContracts.map(({ id }) => ({
    planVersion: running.planVersion,
    nodeId,
    contract: id,
    path: `nodes/${running.planVersion}/${nodeId}/${id}.json`,
    sha256: "a".repeat(64),
    sizeBytes: 1,
  }));
  return applySchedulerEvent(
    compiled.graph,
    running,
    statusEvent(running, nodeId, "executed", artifactRefs),
    compiled.schedulerMetadata,
  );
}

describe("BUILD execution identities", () => {
  it("binds every purpose and ordinal to the immutable plan, attempt, and workspace ownership", () => {
    const base = {
      runId: "build-run-1",
      planVersion: 3,
      planHash: "a".repeat(64),
      nodeId: "implement-a",
      visit: 2,
      attempt: 1,
      purpose: "worker" as const,
      ordinal: BUILD_EFFECT_ORDINAL.worker,
      workspace: {
        kind: "owned-worktree" as const,
        intentId: "b".repeat(64),
        runId: "build-run-1",
        planVersion: 3,
        planHash: "a".repeat(64),
        ownerNodeId: "implement-a",
        baseSha: "c".repeat(40),
        worktreePath: "/tmp/build-run-1-v3-implement-a",
        ownershipReceiptHash: "d".repeat(64),
      },
    };
    const identity = buildEffectIdentity(base);

    expect(identity.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
    expect(identity.requestRef).toBe(createHash("sha256").update(identity.idempotencyKey).digest("hex"));
    expect(buildEffectIdentity({ ...base, purpose: "validator", ordinal: BUILD_EFFECT_ORDINAL.validator }).idempotencyKey)
      .not.toBe(identity.idempotencyKey);
    expect(buildEffectIdentity({ ...base, workspace: { ...base.workspace, intentId: "e".repeat(64) } }).idempotencyKey)
      .not.toBe(identity.idempotencyKey);
    expect(buildEffectIdentity({ ...base, workspace: { ...base.workspace, worktreePath: "/tmp/other" } }).idempotencyKey)
      .not.toBe(identity.idempotencyKey);
    expect(() => buildEffectIdentity({ ...base, ordinal: 99 })).toThrow(/ordinal.*purpose/i);
  });
});

describe("BUILD start selection and running actions", () => {
  it("selects ready nodes without pretending worktree ownership already exists", () => {
    const { compiled, state } = setup();
    const selected = planBuildNodeStarts(compiled, state, policy());
    expect(selected.start.map(({ nodeId }) => nodeId)).toEqual(["inspect-a"]);

    const running = applySchedulerEvent(compiled.graph, state, statusEvent(state, "inspect-a", "running"), compiled.schedulerMetadata);
    const actions = planRunningBuildActions(compiled, running, policy(), []);
    expect(actions).toMatchObject([{
      kind: "invoke-worker",
      nodeId: "inspect-a",
      purpose: "worker",
      ordinal: BUILD_EFFECT_ORDINAL.worker,
      workspace: { kind: "shared" },
    }]);
  });

  it("materializes an isolated worktree before worker invocation and never repeats an unknown effect", () => {
    const selected = setup();
    let state = executeNode(selected.compiled, selected.state, "inspect-a");
    state = executeNode(selected.compiled, state, "inspect-b");
    const { compiled } = selected;
    state = applySchedulerEvent(
      compiled.graph,
      state,
      statusEvent(state, "implement-a", "running"),
      compiled.schedulerMetadata,
    );
    const trusted = policy({ allowWorktreeCreation: true, trustRepositoryCheckout: true });
    const workspace = {
      kind: "planned-worktree" as const,
      intentId: "b".repeat(64),
      runId: state.runId,
      planVersion: state.planVersion,
      planHash: compiled.hash,
      ownerNodeId: "implement-a",
      baseSha: "c".repeat(40),
      worktreePath: "/tmp/build-run-1-v1-implement-a",
    };

    expect(planRunningBuildActions(compiled, state, trusted, [], { "implement-a": workspace }))
      .toMatchObject([{ kind: "materialize-worktree", purpose: "worktree", ordinal: 1 }]);

    const identity = buildEffectIdentity({
      runId: state.runId,
      planVersion: state.planVersion,
      planHash: compiled.hash,
      nodeId: "implement-a",
      visit: 1,
      attempt: 1,
      purpose: "worktree",
      ordinal: 1,
      workspace,
    });
    const unknown: BuildDispatchCheckpoint = {
      ...identity,
      schemaVersion: 1,
      status: "unknown",
      recordedAt: now,
    };
    expect(planRunningBuildActions(compiled, state, trusted, [unknown], { "implement-a": workspace }))
      .toMatchObject([{ kind: "reconcile-unknown", purpose: "worktree", ordinal: 1 }]);

    const forgedOwnership = {
      ...workspace,
      kind: "owned-worktree" as const,
      ownershipReceiptHash: "d".repeat(64),
    };
    expect(() => planRunningBuildActions(compiled, state, trusted, [], { "implement-a": forgedOwnership }))
      .toThrow(/ownership before.*durable worktree receipt/i);

    const succeeded: BuildDispatchCheckpoint = {
      ...identity,
      schemaVersion: 1,
      status: "succeeded",
      resultRef: forgedOwnership.ownershipReceiptHash,
      recordedAt: now,
    };
    expect(planRunningBuildActions(compiled, state, trusted, [succeeded], { "implement-a": forgedOwnership }))
      .toMatchObject([{ kind: "invoke-worker", purpose: "worker", workspace: forgedOwnership }]);
  });

  it("binds an isolated validator to the exact producing node workspace authority", () => {
    const selected = setup();
    let state = executeNode(selected.compiled, selected.state, "inspect-a");
    state = executeNode(selected.compiled, state, "inspect-b");
    state = executeNode(selected.compiled, state, "implement-a");
    const { compiled } = selected;
    state = applySchedulerEvent(
      compiled.graph,
      state,
      statusEvent(state, "validate-a", "running"),
      compiled.schedulerMetadata,
    );
    const owned = {
      kind: "owned-worktree" as const,
      intentId: "b".repeat(64),
      runId: state.runId,
      planVersion: state.planVersion,
      planHash: compiled.hash,
      ownerNodeId: "implement-a",
      baseSha: "c".repeat(40),
      worktreePath: "/tmp/build-run-1-v1-implement-a",
      ownershipReceiptHash: "d".repeat(64),
    };

    expect(planRunningBuildActions(compiled, state, policy(), [], { "validate-a": owned }))
      .toMatchObject([{ kind: "validate-outputs", workspace: owned }]);
    expect(() => planRunningBuildActions(compiled, state, policy(), [], {
      "validate-a": { ...owned, ownerNodeId: "implement-b" },
    })).toThrow(/target.*implement-a|authority.*implement-a/i);
    expect(() => planRunningBuildActions(compiled, state, policy(), [], {
      "validate-a": { ...owned, runId: "other-run" },
    })).toThrow(/run.*plan|authority/i);
  });

  it("keeps isolated writers sequential by default and permits bounded disjoint fan-out only with every gate", () => {
    const selected = setup();
    let state = executeNode(selected.compiled, selected.state, "inspect-a");
    state = executeNode(selected.compiled, state, "inspect-b");
    const { compiled } = selected;

    expect(planBuildNodeStarts(compiled, state, policy({ allowWorktreeCreation: true, trustRepositoryCheckout: true })).start)
      .toHaveLength(1);
    expect(planBuildNodeStarts(compiled, state, policy({
      allowParallelWrites: true,
      allowWorktreeCreation: true,
      trustRepositoryCheckout: true,
    })).start.map(({ nodeId }) => nodeId)).toEqual(["implement-a", "implement-b"]);
  });

  it("bounds independent read-only fan-out below the global concurrency ceiling", () => {
    const compiled = compileBuildPlan(readFanOutPlan());
    let state = createGraphExecutionState(compiled.graph, {
      runId: "read-fan-out-run",
      now,
      planVersion: 1,
      metadata: compiled.schedulerMetadata,
      limits: { ...DEFAULT_EXECUTION_LIMITS, maxConcurrency: 4, backEdgeBudgets: {} },
    });
    state = executeNode(compiled, state, "root");

    const bounded = planBuildNodeStarts(compiled, state, policy({ maxReadOnlyFanOut: 1 }));
    expect(bounded.start.map(({ nodeId }) => nodeId)).toEqual(["read-a"]);
    expect(bounded.blocked).toContainEqual({ nodeId: "read-b", code: "read-only-fanout-limit" });
    expect(planBuildNodeStarts(compiled, state, policy({ maxReadOnlyFanOut: 2 })).start.map(({ nodeId }) => nodeId))
      .toEqual(["read-a", "read-b"]);
  });
});

describe("human integration", () => {
  it("requires an exact interactive decision and proof of main-workspace integration", () => {
    const { compiled, state } = setup();
    const decision = {
      schemaVersion: 1 as const,
      runId: state.runId,
      planVersion: state.planVersion,
      planHash: compiled.hash,
      nodeId: "integrate",
      decision: "integrated" as const,
      selectedCandidateNodeIds: ["implement-a"],
      mainWorkspaceHeadBefore: "a".repeat(40),
      mainWorkspaceHeadAfter: "b".repeat(40),
      mainWorkspaceIntegrated: true as const,
      confirmedByUser: true as const,
      recordedAt: now,
    };
    expect(assertHumanIntegrationDecision(compiled, state, decision)).toEqual(decision);
    expect(() => assertHumanIntegrationDecision(compiled, state, { ...decision, confirmedByUser: false }))
      .toThrow(/confirmed/i);
    expect(() => assertHumanIntegrationDecision(compiled, state, {
      ...decision,
      mainWorkspaceIntegrated: false,
      mainWorkspaceHeadAfter: decision.mainWorkspaceHeadBefore,
    })).toThrow(/integration/i);
    expect(assertHumanIntegrationDecision(compiled, state, {
      ...decision,
      decision: "declined",
      selectedCandidateNodeIds: [],
      mainWorkspaceIntegrated: false,
      mainWorkspaceHeadAfter: decision.mainWorkspaceHeadBefore,
    })).toMatchObject({ decision: "declined", mainWorkspaceIntegrated: false });
  });

  it("enters an explicit human wait and only completes from exact integration evidence", () => {
    const setupValue = setup();
    const { compiled } = setupValue;
    let state = setupValue.state;
    for (const nodeId of ["inspect-a", "inspect-b", "implement-a", "implement-b", "validate-a", "validate-b"]) {
      state = executeNode(compiled, state, nodeId);
    }
    expect(state.nodeStates.integrate?.status).toBe("ready");

    const waitingEvent = createBuildHumanWaitEvent(compiled, state, "integrate", {
      now,
      unattended: false,
      eventId: "wait-integrate",
    });
    state = applySchedulerEvent(compiled.graph, state, waitingEvent, compiled.schedulerMetadata);
    expect(state.nodeStates.integrate?.status).toBe("waiting_human");
    const integrationAction = createBuildHumanIntegrationAction(compiled, state, "integrate");
    expect(integrationAction).toMatchObject({
      kind: "record-human-integration",
      purpose: "human-integration",
      ordinal: BUILD_EFFECT_ORDINAL["human-integration"],
    });

    const decision = {
      schemaVersion: 1 as const,
      runId: state.runId,
      planVersion: state.planVersion,
      planHash: compiled.hash,
      nodeId: "integrate",
      decision: "integrated" as const,
      selectedCandidateNodeIds: ["implement-a"],
      mainWorkspaceHeadBefore: "a".repeat(40),
      mainWorkspaceHeadAfter: "b".repeat(40),
      mainWorkspaceIntegrated: true as const,
      confirmedByUser: true as const,
      recordedAt: now,
    };
    const evidence: ArtifactReference = {
      planVersion: state.planVersion,
      nodeId: "integrate",
      contract: "integration-decision",
      path: `nodes/${state.planVersion}/integrate/integration-decision.json`,
      sha256: "c".repeat(64),
      sizeBytes: 1,
    };
    const receipt = trustedIntegrationReceipt(decision, evidence);
    const integrationCheckpoint = succeededCheckpoint(integrationAction, receipt);
    expect(() => createBuildHumanIntegrationResultEvent(compiled, state, decision, {
      ...evidence,
      path: "../forged.json",
    }, receipt, integrationCheckpoint, "integration-result-forged")).toThrow(/evidence identity/i);
    expect(() => createBuildHumanIntegrationResultEvent(
      compiled,
      state,
      decision,
      evidence,
      { ...receipt, confirmationRef: "f".repeat(64) },
      integrationCheckpoint,
      "integration-result-self-attested",
    )).toThrow(/durable human-integration receipt/i);
    expect(() => createBuildHumanIntegrationResultEvent(
      compiled,
      state,
      decision,
      evidence,
      receipt,
      { ...integrationCheckpoint, status: "intent-recorded", resultRef: undefined },
      "integration-result-unsettled",
    )).toThrow(/durable human-integration receipt/i);

    const completed = createBuildHumanIntegrationResultEvent(
      compiled,
      state,
      decision,
      evidence,
      receipt,
      integrationCheckpoint,
      "integration-result",
    );
    state = applySchedulerEvent(compiled.graph, state, completed, compiled.schedulerMetadata);
    expect(state.nodeStates.integrate).toMatchObject({ status: "executed", outputRefs: [evidence] });
  });

  it("cancels a declined integration and honors the scheduler human-wait deny gate", () => {
    const setupValue = setup();
    const { compiled } = setupValue;
    let state = setupValue.state;
    for (const nodeId of ["inspect-a", "inspect-b", "implement-a", "implement-b", "validate-a", "validate-b"]) {
      state = executeNode(compiled, state, nodeId);
    }
    const deniedState = createGraphExecutionState(compiled.graph, {
      runId: "build-run-denied",
      now,
      planVersion: 1,
      metadata: compiled.schedulerMetadata,
      limits: { ...DEFAULT_EXECUTION_LIMITS, maxConcurrency: 2, humanWait: "deny", backEdgeBudgets: {} },
    });
    let deniedReady = deniedState;
    for (const nodeId of ["inspect-a", "inspect-b", "implement-a", "implement-b", "validate-a", "validate-b"]) {
      deniedReady = executeNode(compiled, deniedReady, nodeId);
    }
    expect(() => createBuildHumanWaitEvent(compiled, deniedReady, "integrate", {
      now,
      unattended: false,
      eventId: "wait-denied",
    })).toThrow(/human-wait-denied|disabled/i);

    state = applySchedulerEvent(compiled.graph, state, createBuildHumanWaitEvent(compiled, state, "integrate", {
      now,
      unattended: false,
      eventId: "wait-decline",
    }), compiled.schedulerMetadata);
    const decision = {
      schemaVersion: 1,
      runId: state.runId,
      planVersion: state.planVersion,
      planHash: compiled.hash,
      nodeId: "integrate",
      decision: "declined",
      selectedCandidateNodeIds: [],
      mainWorkspaceHeadBefore: "a".repeat(40),
      mainWorkspaceHeadAfter: "a".repeat(40),
      mainWorkspaceIntegrated: false,
      confirmedByUser: true,
      recordedAt: now,
    } as const;
    const receipt = trustedIntegrationReceipt(decision);
    const integrationCheckpoint = succeededCheckpoint(createBuildHumanIntegrationAction(compiled, state, "integrate"), receipt);
    const declined = createBuildHumanIntegrationResultEvent(
      compiled,
      state,
      decision,
      undefined,
      receipt,
      integrationCheckpoint,
      "integration-declined",
    );
    state = applySchedulerEvent(compiled.graph, state, declined, compiled.schedulerMetadata);
    expect(state.nodeStates.integrate?.status).toBe("cancelled");
  });
});

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
