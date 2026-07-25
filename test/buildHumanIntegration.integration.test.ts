import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileBuildPlan, type BuildNode, type BuildPlan } from "../src/core/buildPlan.js";
import { DEFAULT_EXECUTION_LIMITS } from "../src/core/scheduler.js";
import { acquireRunLease, createRun } from "../src/lifecycle/artifacts.js";
import { writeImmutableBuildPlan } from "../src/lifecycle/buildArtifacts.js";
import { runBuildCoordinator } from "../src/lifecycle/buildCoordinator.js";
import {
  acquireBuildGraphExecutionLease,
  initializeBuildGraphExecution,
} from "../src/lifecycle/buildGraphExecution.js";
import {
  completeBuildHumanIntegration,
  prepareBuildHumanIntegrationReview,
} from "../src/lifecycle/buildHumanIntegration.js";
import { createPiBuildCoordinatorAdapter } from "../src/lifecycle/piBuildCoordinatorAdapter.js";
import { createLocalGitRunner } from "../src/lifecycle/worktreeExecution.js";
import type { BuildWorkerAdapter } from "../src/runtime/buildWorker.js";

const now = "2026-07-22T00:00:00.000Z";
const ownerToken = "human-integration-owner";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("trusted BUILD human integration", () => {
  it("records an already-committed manual integration without merging or cleaning candidates", async () => {
    const fixture = await reachHumanGate();
    const review = prepareBuildHumanIntegrationReview(fixture.run.paths, fixture.compiled, fixture.waiting.state, {
      owner: fixture.owner,
      repositoryRoot: fixture.repositoryRoot,
      git: fixture.git,
      now: () => now,
    });
    expect(review.candidates).toMatchObject([{
      nodeId: "implement-a",
      changedPaths: ["src/a.ts"],
      validationArtifactSha256: [expect.stringMatching(/^[a-f0-9]{64}$/)],
    }]);
    expect(fixture.runReviewedCommand).toHaveBeenCalledWith("true", expect.objectContaining({
      cwd: review.candidates[0]!.worktreePath,
    }));
    const validatorArtifact = readFileSync(
      join(fixture.run.paths.root, "nodes", "1", "validate-a", "attempt-1", "validated-a.json"),
      "utf8",
    );
    expect(validatorArtifact).not.toContain("sensitive test output");
    expect(validatorArtifact).toContain("stdoutSha256");
    const candidatePath = review.candidates[0]!.worktreePath;
    writeFileSync(join(fixture.repositoryRoot, "src", "a.ts"), readFileSync(join(candidatePath, "src", "a.ts")));
    git(fixture.repositoryRoot, "add", "src/a.ts");
    git(fixture.repositoryRoot, "commit", "-m", "integrate candidate manually");

    await expect(completeBuildHumanIntegration(
      fixture.run.paths,
      fixture.compiled,
      fixture.waiting.state,
      { decision: "integrated", selectedCandidateNodeIds: ["implement-a"], confirmedByUser: true },
      {
        owner: fixture.owner,
        graphOwner: fixture.graphOwner,
        repositoryRoot: fixture.repositoryRoot,
        git: fixture.git,
        now: () => now,
        failAt() {
          throw new Error("simulated crash after human effect result");
        },
      },
    )).rejects.toThrow(/simulated crash/i);
    const recoveredState = initializeBuildGraphExecution(fixture.run.paths, fixture.compiled, {
      owner: fixture.owner,
      graphOwner: fixture.graphOwner,
      now,
      pid: process.pid,
      limits: fixture.options.limits,
    });
    const completed = await completeBuildHumanIntegration(
      fixture.run.paths,
      fixture.compiled,
      recoveredState,
      { decision: "integrated", selectedCandidateNodeIds: ["implement-a"], confirmedByUser: true },
      {
        owner: fixture.owner,
        graphOwner: fixture.graphOwner,
        repositoryRoot: fixture.repositoryRoot,
        git: fixture.git,
        now: () => now,
      },
    );
    expect(completed.state.nodeStates.integrate).toMatchObject({ status: "executed" });
    expect(completed.decision.mainWorkspaceHeadBefore).not.toBe(completed.decision.mainWorkspaceHeadAfter);
    expect(existsSync(candidatePath)).toBe(true);
    expect(git(fixture.repositoryRoot, "worktree", "list", "--porcelain")).toContain(candidatePath);

    const final = await runBuildCoordinator(fixture.run.paths, fixture.compiled, fixture.adapter, fixture.options);
    expect(final.status).toBe("completed");
    expect(final.state.nodeStates["build-complete"]?.status).toBe("executed");
    expect(existsSync(candidatePath)).toBe(true);
  }, 20_000);

  it("records a decline only while the main workspace still matches the captured gate", async () => {
    const fixture = await reachHumanGate();
    const review = prepareBuildHumanIntegrationReview(fixture.run.paths, fixture.compiled, fixture.waiting.state, {
      owner: fixture.owner,
      repositoryRoot: fixture.repositoryRoot,
      git: fixture.git,
      now: () => now,
    });
    const mainHead = git(fixture.repositoryRoot, "rev-parse", "HEAD");
    const completed = await completeBuildHumanIntegration(
      fixture.run.paths,
      fixture.compiled,
      fixture.waiting.state,
      { decision: "declined", selectedCandidateNodeIds: [], confirmedByUser: true },
      {
        owner: fixture.owner,
        graphOwner: fixture.graphOwner,
        repositoryRoot: fixture.repositoryRoot,
        git: fixture.git,
        now: () => now,
      },
    );
    expect(completed.state.nodeStates.integrate?.status).toBe("cancelled");
    expect(git(fixture.repositoryRoot, "rev-parse", "HEAD")).toBe(mainHead);
    expect(existsSync(review.candidates[0]!.worktreePath)).toBe(true);
  }, 20_000);

  it("rejects an unknown reviewed-command validator before executing its command", async () => {
    const fixture = createFixture({ validatorAllowed: false });
    await expect(runBuildCoordinator(fixture.run.paths, fixture.compiled, fixture.adapter, fixture.options))
      .rejects.toThrow(/unrecognized reviewed-command validator/i);
    expect(fixture.runReviewedCommand).not.toHaveBeenCalled();
  }, 20_000);

  it("rejects a successful implementer receipt when trusted Git finds no edit", async () => {
    const fixture = createFixture({ mutateCandidate: false });
    await expect(runBuildCoordinator(fixture.run.paths, fixture.compiled, fixture.adapter, fixture.options))
      .rejects.toThrow(/no authoritative workspace edits/i);
  }, 20_000);
});

async function reachHumanGate() {
  const fixture = createFixture();
  const waiting = await runBuildCoordinator(fixture.run.paths, fixture.compiled, fixture.adapter, fixture.options);
  expect(waiting.status).toBe("waiting-human");
  return { ...fixture, waiting };
}

function createFixture(overrides: Readonly<{ mutateCandidate?: boolean; validatorAllowed?: boolean }> = {}) {
  const repositoryRoot = realpathSync(mkdtempSync(join(tmpdir(), "build-human-integration-")));
  temporaryDirectories.push(repositoryRoot);
  git(repositoryRoot, "init");
  git(repositoryRoot, "config", "user.name", "Build Test");
  git(repositoryRoot, "config", "user.email", "build-test@example.invalid");
  mkdirSync(join(repositoryRoot, "src"));
  writeFileSync(join(repositoryRoot, ".gitignore"), ".ai-orchestrator/\n");
  writeFileSync(join(repositoryRoot, "src", "a.ts"), "export const value = 1;\n");
  git(repositoryRoot, "add", ".gitignore", "src/a.ts");
  git(repositoryRoot, "commit", "-m", "fixture");

  const run = createRun(repositoryRoot, ".ai-orchestrator/runs", "human integration");
  const owner = acquireRunLease(run.paths, ownerToken);
  const graphOwner = acquireBuildGraphExecutionLease(run.paths, owner, { now, pid: process.pid });
  const compiled = compileBuildPlan(plan());
  writeImmutableBuildPlan(run.paths, compiled, { owner });
  const candidateRoot = join(run.paths.root, "build", "worktrees");
  mkdirSync(candidateRoot, { recursive: true });
  const localGit = createLocalGitRunner();
  const invoke = vi.fn<BuildWorkerAdapter["invoke"]>(async (request) => {
    if (request.workspace.kind !== "owned-worktree") throw new Error("test implementer requires its owned worktree");
    if (overrides.mutateCandidate !== false) {
      writeFileSync(join(request.workspace.worktreePath, "src", "a.ts"), "export const value = 2;\n");
    }
    return {
      schemaVersion: 1,
      requestRef: request.requestRef,
      outcome: "succeeded",
      worker: { provider: "test", model: "implementer" },
      claimedOutputPaths: request.declaredOutputContracts.map(({ id }) =>
        `nodes/${request.planVersion}/${request.nodeId}/attempt-${request.attempt}/${id}.json`),
      outputPayloads: [],
      summary: "Implemented the isolated candidate.",
      usage: { inputTokens: 10, outputTokens: 5, observedUsd: 0.001 },
      completedAt: now,
    };
  });
  const worker: BuildWorkerAdapter = { invoke, reconcile: async () => undefined };
  const runReviewedCommand = vi.fn(async () => ({ code: 0, stdout: "sensitive test output", stderr: "" }));
  const adapter = createPiBuildCoordinatorAdapter({
    compiled,
    paths: run.paths,
    owner,
    repositoryRoot,
    candidateRoot,
    git: localGit,
    worker,
    now: () => now,
    unattended: false,
    budgetForNode: () => ({ estimatedCostUsd: 0.01, observedCostUsd: 0, inputTokens: 100, outputTokens: 100 }),
    runReviewedCommand,
    validateReviewedCommands: ({ validatorRef }) => overrides.validatorAllowed !== false && validatorRef === "verification-commands",
    allowWorktreeCreation: true,
    trustRepositoryCheckout: true,
  });
  const options = {
    owner,
    graphOwner,
    pid: process.pid,
    now: () => now,
    limits: { ...DEFAULT_EXECUTION_LIMITS, maxConcurrency: 2, maxModelConcurrency: 2, maxProviderConcurrency: 2, backEdgeBudgets: {} },
    policy: {
      unattended: false,
      maxReadOnlyFanOut: 2,
      allowParallelWrites: true,
      allowWorktreeCreation: true,
      trustRepositoryCheckout: true,
    },
    maxActionConcurrency: 2,
    routingDecisionId: "build-route-1",
    isProcessAlive: () => true,
  } as const;
  return {
    repositoryRoot,
    run,
    compiled,
    owner,
    graphOwner,
    git: localGit,
    adapter,
    options,
    runReviewedCommand,
  };
}

function plan(): BuildPlan {
  return {
    schemaVersion: 1,
    id: "human-integration-build",
    planVersion: 1,
    summary: "Implement and independently validate one isolated candidate before explicit integration.",
    entry: "implement-a",
    exit: "integrate",
    nodes: [
      node("implement-a", {
        handler: "implement",
        outputContracts: [{ id: "patch-a", kind: "file-set", validation: "sha256" }],
        toolPolicy: "declared-writes",
        sideEffect: "write",
        workspace: "isolated-worktree",
        idempotency: "keyed",
        resourceLocks: [{ kind: "path", value: "src/a.ts", mode: "exclusive" }],
        writeSet: ["src/a.ts"],
      }),
      node("validate-a", {
        handler: "validate",
        inputContracts: ["patch-a"],
        outputContracts: [{ id: "validated-a", kind: "evidence", validation: "reviewed-command", validatorRef: "verification-commands" }],
        verificationCommands: ["true"],
        toolPolicy: "reviewed-validation",
        workspace: "isolated-worktree",
        targetWorktreeNodeId: "implement-a",
      }),
      node("integrate", {
        handler: "integrate",
        inputContracts: ["validated-a"],
        outputContracts: [{ id: "integration-decision", kind: "evidence", validation: "human-review", validatorRef: "candidate-integration-gate" }],
        toolPolicy: "human-integration",
        sideEffect: "external",
        idempotency: "none",
      }),
    ],
    dependencies: [
      { from: "implement-a", to: "validate-a", contracts: ["patch-a"] },
      { from: "validate-a", to: "integrate", contracts: ["validated-a"] },
    ],
    joins: [],
  };
}

function node(id: string, overrides: Partial<BuildNode>): BuildNode {
  return {
    id,
    handler: "inspect",
    priority: 0,
    objective: `Complete ${id}.`,
    instructions: [`Perform ${id}.`],
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
    timeoutMs: 10_000,
    ...overrides,
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
