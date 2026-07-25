import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileLegacySequentialBuildPlan, renderBuildPlanMarkdown } from "../src/core/buildPlan.js";
import { compileGraph, type GraphDefinition } from "../src/core/graph.js";
import {
  DEFAULT_EXECUTION_LIMITS,
  createGraphExecutionState,
  type GraphEvent,
} from "../src/core/scheduler.js";
import type { RunPaths } from "../src/lifecycle/artifacts.js";
import {
  approveAndActivateLifecycleRecoverySuccessor,
  authenticateLifecycleRecoveryEnvelope,
  completeLifecycleRecoveryAction,
  createLifecycleRecoveryEnvelope,
  currentLifecycleRecoveryState,
  latestLifecycleRecoveryDecision,
  recordLifecycleRecoveryDiagnosis,
  recordLifecycleRecoverySuccessorArtifacts,
  registerLifecycleRecoveryOccurrence,
  startLifecycleRecoveryAction,
  validateLifecycleRecoveryEnvelope,
} from "../src/lifecycle/recoveryExecution.js";
import {
  acquireGraphCheckpointLease,
  checkpointGraphEvent,
  createGraphCheckpointPaths,
  releaseGraphCheckpointLease,
  writeGraphMutationArtifact,
  writeGraphSnapshot,
  writeImmutableGraphCheckpoint,
} from "../src/runtime/graphCheckpoint.js";

const temporaryDirectories: string[] = [];
const now = "2026-07-24T00:00:00.000Z";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lifecycle-recovery-"));
  temporaryDirectories.push(root);
  const graphDefinition: GraphDefinition = {
    schemaVersion: 1,
    id: "lifecycle-recovery-test",
    version: "1.0.0",
    kind: "state-machine",
    entry: "verifying",
    nodes: [
      {
        id: "verifying",
        handler: "verify",
        sideEffect: "none",
        inputContracts: [],
        outputContracts: ["verdict"],
        timeoutMs: 1_000,
        retryBudget: 1,
      },
      {
        id: "debugging",
        handler: "debug",
        sideEffect: "none",
        inputContracts: ["verdict"],
        outputContracts: [],
        terminal: true,
        timeoutMs: 1_000,
        retryBudget: 0,
      },
    ],
    edges: [{ from: "verifying", to: "debugging", event: "verdict" }],
  };
  const graph = compileGraph(graphDefinition);
  const graphPaths = createGraphCheckpointPaths(root);
  const paths = {
    ...graphPaths,
    spec: join(root, "spec.md"),
    plan: join(root, "plan.md"),
    debug: join(root, "debug.md"),
    journal: join(root, "journal.md"),
    routing: join(root, "routing.jsonl"),
    evidence: join(root, "evidence.json"),
  } satisfies RunPaths;
  const owner = acquireGraphCheckpointLease(paths, "lifecycle-recovery-test", {
    now,
    pid: process.pid,
    nonce: "lifecycle-recovery-test-nonce",
  });
  const genesis = createGraphExecutionState(graph, {
    runId: "lifecycle-recovery-run",
    now,
    planVersion: 1,
    limits: { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} },
  });
  writeImmutableGraphCheckpoint(paths, graph, {}, genesis, { owner });
  writeGraphSnapshot(paths, graph, genesis, { owner, tempId: "genesis" });
  const event: GraphEvent = {
    schemaVersion: 1,
    kind: "node-status",
    sequence: 1,
    eventId: "enter-verifying",
    runId: genesis.runId,
    graphId: genesis.graphId,
    graphVersion: genesis.graphVersion,
    graphDigest: genesis.graphDigest,
    planVersion: 1,
    nodeId: "verifying",
    priorStatus: "ready",
    nextStatus: "running",
    attempt: 1,
    timestamp: now,
    artifactRefs: [],
  };
  const state = checkpointGraphEvent({
    graph,
    paths,
    state: genesis,
    event,
    owner,
    tempId: "entered",
  });
  return { graph, paths, owner, state };
}

function mutation(paths: RunPaths, owner: ReturnType<typeof acquireGraphCheckpointLease>, value: unknown) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  const digest = createHash("sha256").update(bytes).digest("hex");
  return writeGraphMutationArtifact(paths, { owner, mutationId: digest, bytes });
}

describe("lifecycle versioned recovery execution", () => {
  it("authenticates a typed local repair and its exact action intent/result", () => {
    const { graph, paths, owner, state } = fixture();
    let envelope = createLifecycleRecoveryEnvelope({
      paths,
      owner,
      graph,
      schedulerState: state,
      failurePhase: "verifying",
      activePlanVersion: 1,
      activePlanBytes: Buffer.from("# Approved plan\n", "utf8"),
      attempt: 1,
      contractId: "verify-verdict",
      evidenceBytes: Buffer.from('{"verdict":"reject"}\n', "utf8"),
    });
    expect(currentLifecycleRecoveryState(envelope).status).toBe("waiting-diagnosis");

    envelope = recordLifecycleRecoveryDiagnosis(paths, owner, envelope, {
      rootCauseCategory: "implementation-defect",
      confidence: "high",
      repairScope: ["src/example.ts"],
      validationRequirements: ["verification-commands"],
      topologyAssessment: "preserve",
      diagnosisBytes: Buffer.from("# Diagnosis\nLocal defect.\n", "utf8"),
    });
    expect(latestLifecycleRecoveryDecision(envelope)).toMatchObject({
      action: "repair",
      targetPlanVersion: 1,
    });
    expect(envelope.action).toMatchObject({ action: "repair", status: "pending" });

    const intentRef = mutation(paths, owner, { kind: "repair-intent" });
    envelope = startLifecycleRecoveryAction(envelope, intentRef.sha256, intentRef);
    const resultRef = mutation(paths, owner, { kind: "repair-result", outcome: "succeeded" });
    envelope = completeLifecycleRecoveryAction(envelope, intentRef.sha256, resultRef);
    expect(envelope.action).toMatchObject({ status: "completed", requestRef: intentRef.sha256 });
    expect(authenticateLifecycleRecoveryEnvelope(paths, graph, state, envelope)).toEqual(envelope);

    const forged = structuredClone(envelope);
    forged.action!.resultRef = { ...forged.action!.resultRef!, sha256: "f".repeat(64) };
    expect(() => validateLifecycleRecoveryEnvelope(forged)).toThrow(/path does not match its hash/i);
    expect(releaseGraphCheckpointLease(paths, owner)).toBe(true);
  });

  it("materializes, approves, and activates exactly plan N plus one", () => {
    const { graph, paths, owner, state } = fixture();
    let envelope = createLifecycleRecoveryEnvelope({
      paths,
      owner,
      graph,
      schedulerState: state,
      failurePhase: "verifying",
      activePlanVersion: 1,
      activePlanBytes: Buffer.from("# Approved plan\n", "utf8"),
      attempt: 1,
      contractId: "verify-verdict",
      evidenceBytes: Buffer.from('{"verdict":"reject"}\n', "utf8"),
    });
    envelope = recordLifecycleRecoveryDiagnosis(paths, owner, envelope, {
      rootCauseCategory: "missing-dependency",
      confidence: "high",
      repairScope: [],
      validationRequirements: ["verification-commands"],
      topologyAssessment: "structural",
      diagnosisBytes: Buffer.from("# Diagnosis\nThe plan is missing a dependency.\n", "utf8"),
    });
    expect(currentLifecycleRecoveryState(envelope).status).toBe("waiting-successor-artifact");

    const successor = compileLegacySequentialBuildPlan("Implement the successor.", 2, ["src"]);
    envelope = recordLifecycleRecoverySuccessorArtifacts(
      paths,
      owner,
      envelope,
      successor,
      Buffer.from(renderBuildPlanMarkdown(successor), "utf8"),
    );
    expect(currentLifecycleRecoveryState(envelope).status).toBe("waiting-successor-approval");
    envelope = approveAndActivateLifecycleRecoverySuccessor(
      paths,
      owner,
      envelope,
      Buffer.from('{"approved":true,"kind":"human"}\n', "utf8"),
    );
    expect(currentLifecycleRecoveryState(envelope)).toMatchObject({
      status: "released",
      approvedPlanVersion: 2,
      successor: { status: "activated", targetPlanVersion: 2 },
    });
    expect(authenticateLifecycleRecoveryEnvelope(paths, graph, state, envelope)).toEqual(envelope);
    expect(releaseGraphCheckpointLease(paths, owner)).toBe(true);
  });

  it("appends a scheduler-anchored occurrence without resetting consumed repair authority", () => {
    const { graph, paths, owner, state } = fixture();
    const planBytes = Buffer.from("# Approved plan\n", "utf8");
    let envelope = createLifecycleRecoveryEnvelope({
      paths,
      owner,
      graph,
      schedulerState: state,
      failurePhase: "verifying",
      activePlanVersion: 1,
      activePlanBytes: planBytes,
      attempt: 1,
      contractId: "verify-verdict",
      evidenceBytes: Buffer.from('{"verdict":"reject","occurrence":1}\n', "utf8"),
    });
    envelope = recordLifecycleRecoveryDiagnosis(paths, owner, envelope, {
      rootCauseCategory: "implementation-defect",
      confidence: "high",
      repairScope: ["src/example.ts"],
      validationRequirements: ["verification-commands"],
      topologyAssessment: "preserve",
      diagnosisBytes: Buffer.from("# Diagnosis\nLocal defect.\n", "utf8"),
    });
    const intentRef = mutation(paths, owner, { kind: "repair-intent" });
    envelope = startLifecycleRecoveryAction(envelope, intentRef.sha256, intentRef);
    const resultRef = mutation(paths, owner, { kind: "repair-result", outcome: "succeeded" });
    envelope = completeLifecycleRecoveryAction(envelope, intentRef.sha256, resultRef);

    let retried = checkpointGraphEvent({
      graph,
      paths,
      state,
      owner,
      tempId: "retry-failed",
      event: {
        schemaVersion: 1,
        kind: "node-status",
        sequence: 2,
        eventId: "verifying-failed-retryable",
        runId: state.runId,
        graphId: state.graphId,
        graphVersion: state.graphVersion,
        graphDigest: state.graphDigest,
        planVersion: 1,
        nodeId: "verifying",
        priorStatus: "running",
        nextStatus: "failed_retryable",
        attempt: 1,
        timestamp: "2026-07-24T00:00:01.000Z",
        errorCategory: "validator-rejected",
        artifactRefs: [],
      },
    });
    retried = checkpointGraphEvent({
      graph,
      paths,
      state: retried,
      owner,
      tempId: "retry-ready",
      event: {
        schemaVersion: 1,
        kind: "node-status",
        sequence: 3,
        eventId: "verifying-retry-ready",
        runId: retried.runId,
        graphId: retried.graphId,
        graphVersion: retried.graphVersion,
        graphDigest: retried.graphDigest,
        planVersion: 1,
        nodeId: "verifying",
        priorStatus: "failed_retryable",
        nextStatus: "ready",
        attempt: 1,
        timestamp: "2026-07-24T00:00:02.000Z",
        artifactRefs: [],
      },
    });
    retried = checkpointGraphEvent({
      graph,
      paths,
      state: retried,
      owner,
      tempId: "retry-running",
      event: {
        schemaVersion: 1,
        kind: "node-status",
        sequence: 4,
        eventId: "verifying-retry-running",
        runId: retried.runId,
        graphId: retried.graphId,
        graphVersion: retried.graphVersion,
        graphDigest: retried.graphDigest,
        planVersion: 1,
        nodeId: "verifying",
        priorStatus: "ready",
        nextStatus: "running",
        attempt: 2,
        timestamp: "2026-07-24T00:00:03.000Z",
        artifactRefs: [],
      },
    });
    envelope = registerLifecycleRecoveryOccurrence({
      paths,
      owner,
      graph,
      schedulerState: retried,
      envelope,
      failurePhase: "verifying",
      activePlanVersion: 1,
      activePlanBytes: planBytes,
      attempt: 2,
      contractId: "verify-verdict",
      evidenceBytes: Buffer.from('{"verdict":"reject","occurrence":2}\n', "utf8"),
    });
    expect(envelope).toMatchObject({
      occurrenceBindings: [{}, {}],
      actionHistory: [{ action: "repair", status: "completed" }],
    });
    expect(currentLifecycleRecoveryState(envelope)).toMatchObject({
      status: "waiting-diagnosis",
      consumed: ["repair"],
      remaining: { repair: 0 },
    });
    envelope = recordLifecycleRecoveryDiagnosis(paths, owner, envelope, {
      rootCauseCategory: "implementation-defect",
      confidence: "high",
      repairScope: ["src/example.ts"],
      validationRequirements: ["verification-commands"],
      topologyAssessment: "preserve",
      diagnosisBytes: Buffer.from("# Diagnosis\nThe same local defect remains.\n", "utf8"),
    });
    expect(latestLifecycleRecoveryDecision(envelope)).toMatchObject({
      action: "fail",
      reason: "recovery-level-consumed",
    });
    expect(authenticateLifecycleRecoveryEnvelope(paths, graph, retried, envelope)).toEqual(envelope);
    expect(releaseGraphCheckpointLease(paths, owner)).toBe(true);
  });
});
