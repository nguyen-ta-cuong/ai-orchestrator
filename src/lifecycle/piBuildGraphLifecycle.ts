import type { ModelRegistry, ThinkingLevel } from "@earendil-works/pi-coding-agent";
import type { CompiledBuildPlan } from "../core/buildPlan.js";
import type { BuildExecutionPolicy } from "../core/buildExecution.js";
import type { ExecutionLimits } from "../core/scheduler.js";
import type { GraphCheckpointLease } from "../runtime/graphCheckpoint.js";
import { createPiBuildWorkerAdapter, type PiBuildModel, type PiNestedSessionFactory } from "../runtime/piBuildWorker.js";
import type { RunPaths } from "./artifacts.js";
import {
  runBuildCoordinator,
  type BuildCoordinatorResult,
  type BuildWorkerBudgetEstimates,
} from "./buildCoordinator.js";
import {
  createPiBuildCoordinatorAdapter,
  type PiBuildCoordinatorRuntimeOptions,
  type ReviewedCommandResult,
} from "./piBuildCoordinatorAdapter.js";
import { createLocalGitRunner, type GitRunner } from "./worktreeExecution.js";

export interface ExecutePiBuildGraphLifecycleOptions {
  compiled: Readonly<CompiledBuildPlan>;
  paths: RunPaths;
  owner: Readonly<GraphCheckpointLease>;
  graphOwner: Readonly<GraphCheckpointLease>;
  repositoryRoot: string;
  candidateRoot: string;
  protectedWorkspacePaths: readonly string[];
  model: Readonly<PiBuildModel>;
  thinkingLevel: ThinkingLevel;
  modelRegistry: ModelRegistry;
  family?: string;
  now(): string;
  pid: number;
  limits: Readonly<ExecutionLimits>;
  policy: Omit<BuildExecutionPolicy, "now">;
  maxActionConcurrency: number;
  routingDecisionId: string;
  budgetForNode(nodeId: string): Readonly<Omit<BuildWorkerBudgetEstimates, "unattended">>;
  runReviewedCommand(
    command: string,
    options: Readonly<{ cwd: string; timeoutMs: number; signal?: AbortSignal }>,
  ): Promise<ReviewedCommandResult>;
  validateReviewedCommands: PiBuildCoordinatorRuntimeOptions["validateReviewedCommands"];
  validateStructuredOutput?: PiBuildCoordinatorRuntimeOptions["validateStructuredOutput"];
  sessionFactory?: Readonly<PiNestedSessionFactory>;
  git?: Readonly<GitRunner>;
  signal?: AbortSignal;
  isProcessAlive?(pid: number): boolean;
}

/** Compose the supported production Pi BUILD stack. The outer lifecycle owns
 * the selected model and lease; nested workers reuse those exact trusted
 * objects while the coordinator alone owns durable graph/artifact mutation. */
export async function executeBuildGraphLifecycle(
  options: Readonly<ExecutePiBuildGraphLifecycleOptions>,
): Promise<BuildCoordinatorResult> {
  const maximumNodeTimeout = Math.max(...options.compiled.plan.nodes.map(({ timeoutMs }) => timeoutMs));
  const git = options.git ?? createLocalGitRunner({ timeoutMs: maximumNodeTimeout });
  const worker = createPiBuildWorkerAdapter({
    repositoryRoot: options.repositoryRoot,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    modelRegistry: options.modelRegistry,
    now: options.now,
    protectedWorkspacePaths: options.protectedWorkspacePaths,
    ...(options.family === undefined ? {} : { family: options.family }),
    ...(options.sessionFactory === undefined ? {} : { sessionFactory: options.sessionFactory }),
  });
  const adapter = createPiBuildCoordinatorAdapter({
    compiled: options.compiled,
    paths: options.paths,
    owner: options.owner,
    repositoryRoot: options.repositoryRoot,
    candidateRoot: options.candidateRoot,
    git,
    worker,
    now: options.now,
    unattended: options.policy.unattended,
    budgetForNode: options.budgetForNode,
    runReviewedCommand: options.runReviewedCommand,
    validateReviewedCommands: options.validateReviewedCommands,
    ...(options.validateStructuredOutput === undefined ? {} : {
      validateStructuredOutput: options.validateStructuredOutput,
    }),
    allowWorktreeCreation: options.policy.allowWorktreeCreation,
    trustRepositoryCheckout: options.policy.trustRepositoryCheckout,
  });
  return runBuildCoordinator(options.paths, options.compiled, adapter, {
    owner: options.owner,
    graphOwner: options.graphOwner,
    pid: options.pid,
    now: options.now,
    limits: options.limits,
    policy: options.policy,
    maxActionConcurrency: options.maxActionConcurrency,
    routingDecisionId: options.routingDecisionId,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.isProcessAlive === undefined ? {} : { isProcessAlive: options.isProcessAlive }),
  });
}
