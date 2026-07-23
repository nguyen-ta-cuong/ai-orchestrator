import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileLegacySequentialBuildPlan } from "../src/core/buildPlan.js";
import { DEFAULT_EXECUTION_LIMITS } from "../src/core/scheduler.js";
import { acquireRunLease, createRun } from "../src/lifecycle/artifacts.js";
import { writeImmutableBuildPlan } from "../src/lifecycle/buildArtifacts.js";
import { runBuildCoordinator, type BuildCoordinatorAdapter } from "../src/lifecycle/buildCoordinator.js";

const now = "2026-07-22T00:00:00.000Z";
const owner = "coordinator-owner";
const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("durable BUILD coordinator", () => {
  it("executes the sequential fallback through guarded worker, validator, exact seal, and graph completion", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "build-coordinator-"));
    tempDirs.push(cwd);
    mkdirSync(join(cwd, "src"));
    const run = createRun(cwd, ".ai-orchestrator/runs", "coordinator");
    acquireRunLease(run.paths, owner);
    const compiled = compileLegacySequentialBuildPlan("Implement the approved change.", 1, ["src"]);
    writeImmutableBuildPlan(run.paths, compiled, { owner });
    const execute = vi.fn<BuildCoordinatorAdapter["execute"]>(async (action, context) => {
      if (action.purpose === "worker") {
        expect(context?.workerBudgetReservation?.effectRequestRef).toBe(action.requestRef);
        return {
          outcome: "succeeded" as const,
          recordedAt: now,
          receipt: { schemaVersion: 1, kind: "worker-output" },
        };
      }
      expect(action.purpose).toBe("validator");
      const bytes = "validated output\n";
      const relativePath = "nodes/1/legacy-build/legacy-build-output.txt";
      mkdirSync(join(run.paths.root, "nodes", "1", "legacy-build"), { recursive: true });
      writeFileSync(join(run.paths.root, ...relativePath.split("/")), bytes);
      return {
        outcome: "succeeded" as const,
        recordedAt: now,
        receipt: {
          schemaVersion: 1,
          kind: "validated-build-outputs",
          artifactRefs: [{
            planVersion: 1,
            nodeId: "legacy-build",
            contract: "legacy-build-output",
            path: relativePath,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            sizeBytes: Buffer.byteLength(bytes),
          }],
        },
      };
    });
    const adapter: BuildCoordinatorAdapter = {
      workspaceForNode: () => ({ kind: "shared" }),
      workerBudgetEstimates: () => ({
        unattended: false,
        estimatedCostUsd: 0.01,
        observedCostUsd: 0,
        inputTokens: 100,
        outputTokens: 100,
      }),
      workerUsage: () => ({
        estimatedCostUsd: 0.01,
        observedCostUsd: 0.005,
        inputTokens: 80,
        outputTokens: 40,
      }),
      execute,
      reconcile: vi.fn(async () => undefined),
    };

    const result = await runBuildCoordinator(run.paths, compiled, adapter, {
      owner,
      pid: 123,
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
      isProcessAlive: () => true,
    });

    expect(result.status).toBe("completed");
    expect(result.state.nodeStates["legacy-build"]).toMatchObject({ status: "executed", attempts: 1 });
    expect(result.state.nodeStates["build-complete"]?.status).toBe("executed");
    expect(result.state.guard).toMatchObject({ modelCallsInFlight: 0, providerCallsInFlight: 0 });
    expect(execute.mock.calls.map(([action]) => action.purpose)).toEqual(["worker", "validator"]);
  });

  it("rejects a worker-budget adapter that downgrades the unattended policy", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "build-coordinator-budget-policy-"));
    tempDirs.push(cwd);
    mkdirSync(join(cwd, "src"));
    const run = createRun(cwd, ".ai-orchestrator/runs", "coordinator-budget-policy");
    acquireRunLease(run.paths, owner);
    const compiled = compileLegacySequentialBuildPlan("Implement the approved change.", 1, ["src"]);
    writeImmutableBuildPlan(run.paths, compiled, { owner });
    const adapter: BuildCoordinatorAdapter = {
      workspaceForNode: () => ({ kind: "shared" }),
      workerBudgetEstimates: () => ({
        unattended: false,
        estimatedCostUsd: 0.01,
        observedCostUsd: 0,
        inputTokens: 100,
        outputTokens: 100,
      }),
      execute: vi.fn(),
      reconcile: vi.fn(async () => undefined),
    };

    await expect(runBuildCoordinator(run.paths, compiled, adapter, {
      owner,
      pid: 123,
      now: () => now,
      limits: { ...DEFAULT_EXECUTION_LIMITS, backEdgeBudgets: {} },
      policy: {
        unattended: true,
        maxReadOnlyFanOut: 2,
        allowParallelWrites: false,
        allowWorktreeCreation: false,
        trustRepositoryCheckout: false,
      },
      maxActionConcurrency: 2,
      isProcessAlive: () => true,
    })).rejects.toThrow("must preserve the coordinator unattended policy");
  });

  it("reconstructs the outer worker reservation before reconciling a crash-era inner intent", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "build-coordinator-reconcile-"));
    tempDirs.push(cwd);
    mkdirSync(join(cwd, "src"));
    const run = createRun(cwd, ".ai-orchestrator/runs", "coordinator-reconcile");
    acquireRunLease(run.paths, owner);
    const compiled = compileLegacySequentialBuildPlan("Implement the approved change.", 1, ["src"]);
    writeImmutableBuildPlan(run.paths, compiled, { owner });
    const estimates = {
      unattended: false,
      estimatedCostUsd: 0.01,
      observedCostUsd: 0,
      inputTokens: 100,
      outputTokens: 100,
    } as const;
    const options = {
      owner,
      pid: 123,
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
      isProcessAlive: () => true,
    } as const;
    const crashedAdapter: BuildCoordinatorAdapter = {
      workspaceForNode: () => ({ kind: "shared" }),
      workerBudgetEstimates: () => estimates,
      execute: vi.fn(async () => {
        throw new Error("simulated crash after durable inner intent");
      }),
      reconcile: vi.fn(async () => undefined),
    };

    await expect(runBuildCoordinator(run.paths, compiled, crashedAdapter, options))
      .rejects.toThrow("simulated crash after durable inner intent");

    const reconcile = vi.fn<BuildCoordinatorAdapter["reconcile"]>(async (action, context) => {
      expect(action).toMatchObject({ kind: "reconcile-unknown", purpose: "worker" });
      expect(context?.workerBudgetReservation?.effectRequestRef).toBe(action.requestRef);
      return {
        outcome: "succeeded" as const,
        recordedAt: now,
        receipt: { schemaVersion: 1, kind: "worker-output" },
      };
    });
    const resumedAdapter: BuildCoordinatorAdapter = {
      workspaceForNode: () => ({ kind: "shared" }),
      workerBudgetEstimates: () => estimates,
      workerUsage: () => ({ observedCostUsd: 0.005, inputTokens: 80, outputTokens: 40 }),
      execute: vi.fn(async (action) => {
        expect(action.purpose).toBe("validator");
        const bytes = "reconciled output\n";
        const relativePath = "nodes/1/legacy-build/legacy-build-output.txt";
        mkdirSync(join(run.paths.root, "nodes", "1", "legacy-build"), { recursive: true });
        writeFileSync(join(run.paths.root, ...relativePath.split("/")), bytes);
        return {
          outcome: "succeeded" as const,
          recordedAt: now,
          receipt: {
            schemaVersion: 1,
            kind: "validated-build-outputs",
            artifactRefs: [{
              planVersion: 1,
              nodeId: "legacy-build",
              contract: "legacy-build-output",
              path: relativePath,
              sha256: createHash("sha256").update(bytes).digest("hex"),
              sizeBytes: Buffer.byteLength(bytes),
            }],
          },
        };
      }),
      reconcile,
    };

    const result = await runBuildCoordinator(run.paths, compiled, resumedAdapter, options);

    expect(result.status).toBe("completed");
    expect(reconcile).toHaveBeenCalledOnce();
    expect(result.state.guard).toMatchObject({ modelCallsInFlight: 0, providerCallsInFlight: 0 });
  });
});
