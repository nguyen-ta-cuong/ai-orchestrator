import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileLegacySequentialBuildPlan } from "../src/core/buildPlan.js";
import { DEFAULT_EXECUTION_LIMITS } from "../src/core/scheduler.js";
import { acquireRunLease, createRun } from "../src/lifecycle/artifacts.js";
import { writeImmutableBuildPlan } from "../src/lifecycle/buildArtifacts.js";
import { runBuildCoordinator } from "../src/lifecycle/buildCoordinator.js";
import { acquireBuildGraphExecutionLease } from "../src/lifecycle/buildGraphExecution.js";
import { createPiBuildCoordinatorAdapter } from "../src/lifecycle/piBuildCoordinatorAdapter.js";
import type { GitRunner } from "../src/lifecycle/worktreeExecution.js";
import type { BuildWorkerAdapter } from "../src/runtime/buildWorker.js";

const now = "2026-07-22T00:00:00.000Z";
const ownerToken = "pi-build-adapter-owner";
const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("production Pi BUILD coordinator adapter", () => {
  it("keeps worker authority outside the model and emits trusted canonical validator artifacts", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-build-adapter-")));
    tempDirs.push(cwd);
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src", "change.ts"), "export const changed = true;\n");
    const candidateRoot = join(cwd, ".ai-orchestrator", "build-worktrees");
    mkdirSync(candidateRoot, { recursive: true });
    const run = createRun(cwd, ".ai-orchestrator/runs", "pi adapter");
    const owner = acquireRunLease(run.paths, ownerToken);
    const graphOwner = acquireBuildGraphExecutionLease(run.paths, owner, { now, pid: process.pid });
    const compiled = compileLegacySequentialBuildPlan("Implement the approved change.", 1, ["src"]);
    writeImmutableBuildPlan(run.paths, compiled, { owner });
    const invoke = vi.fn<BuildWorkerAdapter["invoke"]>(async (request) => {
      writeFileSync(join(cwd, "src", "change.ts"), "export const changed = 'by worker';\n");
      return {
        schemaVersion: 1,
        requestRef: request.requestRef,
        outcome: "succeeded",
        worker: { provider: "test", model: "coder" },
        claimedOutputPaths: request.declaredOutputContracts.map(({ id }) =>
          `nodes/${request.planVersion}/${request.nodeId}/attempt-${request.attempt}/${id}.json`),
        outputPayloads: [],
        summary: "Implemented the assigned node.",
        usage: { inputTokens: 20, outputTokens: 10, observedUsd: 0.001 },
        completedAt: now,
      };
    });
    const worker: BuildWorkerAdapter = { invoke, reconcile: vi.fn(async () => undefined) };
    const git: GitRunner = {
      run: vi.fn((args) => ({
        code: 0,
        stdout: args.includes("--others") && !args.includes("--ignored") ? "src/change.ts\0" : "",
        stderr: "",
      })),
    };
    const adapterOptions = {
      compiled,
      paths: run.paths,
      owner,
      repositoryRoot: cwd,
      candidateRoot,
      git,
      worker,
      now: () => now,
      unattended: false,
      budgetForNode: () => ({ estimatedCostUsd: 0.01, observedCostUsd: 0, inputTokens: 100, outputTokens: 100 }),
      runReviewedCommand: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      validateReviewedCommands: () => false,
      allowWorktreeCreation: false,
      trustRepositoryCheckout: false,
    } as const;
    const coordinatorOptions = {
      owner,
      graphOwner,
      pid: process.pid,
      now: () => now,
      limits: { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} },
      policy: {
        unattended: false,
        maxReadOnlyFanOut: 2,
        allowParallelWrites: false,
        allowWorktreeCreation: false,
        trustRepositoryCheckout: false,
      },
      maxActionConcurrency: 2,
      routingDecisionId: "build-route-1",
      isProcessAlive: () => true,
    } as const;
    const firstAdapter = createPiBuildCoordinatorAdapter(adapterOptions);
    await expect(runBuildCoordinator(run.paths, compiled, {
      ...firstAdapter,
      onActionSettled(action) {
        if (action.purpose === "worker") throw new Error("simulated crash after durable worker receipt");
      },
    }, coordinatorOptions)).rejects.toThrow(/simulated crash/i);
    expect(invoke).toHaveBeenCalledOnce();

    const adapter = createPiBuildCoordinatorAdapter(adapterOptions);
    const result = await runBuildCoordinator(run.paths, compiled, adapter, coordinatorOptions);

    expect(result.status).toBe("completed");
    expect(invoke).toHaveBeenCalledOnce();
    expect(result.state.nodeStates["legacy-build"]?.outputRefs).toMatchObject([{
      contract: "legacy-build-output",
      path: expect.stringMatching(/^nodes\/1\/legacy-build\/[a-f0-9]{64}-[a-f0-9]{64}\.artifact$/),
    }]);
    expect(result.state.guard).toMatchObject({
      modelCallsInFlight: 0,
      providerCallsInFlight: 0,
      observedCostUsd: 0.001,
      inputTokens: 20,
      outputTokens: 10,
    });
  }, 40_000);

  it("does not let a maker claim a pre-existing shared-workspace change as its own edit", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-build-preexisting-")));
    tempDirs.push(cwd);
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src", "preexisting.ts"), "export const preexisting = true;\n");
    const candidateRoot = join(cwd, ".ai-orchestrator", "build-worktrees");
    mkdirSync(candidateRoot, { recursive: true });
    const run = createRun(cwd, ".ai-orchestrator/runs", "pre-existing change");
    const owner = acquireRunLease(run.paths, ownerToken);
    const graphOwner = acquireBuildGraphExecutionLease(run.paths, owner, { now, pid: process.pid });
    const compiled = compileLegacySequentialBuildPlan("Implement the approved change.", 1, ["src"]);
    writeImmutableBuildPlan(run.paths, compiled, { owner });
    const worker: BuildWorkerAdapter = {
      invoke: vi.fn(async (request) => ({
        schemaVersion: 1,
        requestRef: request.requestRef,
        outcome: "succeeded",
        worker: { provider: "test", model: "coder" },
        claimedOutputPaths: request.declaredOutputContracts.map(({ id }) =>
          `nodes/${request.planVersion}/${request.nodeId}/attempt-${request.attempt}/${id}.json`),
        outputPayloads: [],
        summary: "Claimed success without editing.",
        usage: { inputTokens: 20, outputTokens: 10, observedUsd: 0.001 },
        completedAt: now,
      })),
      reconcile: vi.fn(async () => undefined),
    };
    const git: GitRunner = {
      run: vi.fn((args) => ({
        code: 0,
        stdout: args.includes("--others") && !args.includes("--ignored") ? "src/preexisting.ts\0" : "",
        stderr: "",
      })),
    };
    const adapter = createPiBuildCoordinatorAdapter({
      compiled,
      paths: run.paths,
      owner,
      repositoryRoot: cwd,
      candidateRoot,
      git,
      worker,
      now: () => now,
      unattended: false,
      budgetForNode: () => ({ estimatedCostUsd: 0.01, observedCostUsd: 0, inputTokens: 100, outputTokens: 100 }),
      runReviewedCommand: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      validateReviewedCommands: () => false,
      allowWorktreeCreation: false,
      trustRepositoryCheckout: false,
    });

    await expect(runBuildCoordinator(run.paths, compiled, adapter, {
      owner,
      graphOwner,
      pid: process.pid,
      now: () => now,
      limits: { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} },
      policy: {
        unattended: false,
        maxReadOnlyFanOut: 2,
        allowParallelWrites: false,
        allowWorktreeCreation: false,
        trustRepositoryCheckout: false,
      },
      maxActionConcurrency: 2,
      routingDecisionId: "build-route-1",
      isProcessAlive: () => true,
    })).rejects.toThrow(/did not change its declared workspace state/i);
  }, 20_000);
});
