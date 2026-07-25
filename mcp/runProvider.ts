import { randomUUID } from "node:crypto";
import { loadConfig, type OrchestratorConfig } from "../src/core/config.js";
import { classifyMcpProviderFailure } from "./failureCodes.js";
import {
  completeMcpJudge,
  completeMcpPlan,
  type McpCompletionExecutor,
} from "./routedCompletion.js";
import {
  mcpRunJudgeRoutingDecisionSchema,
  mcpRunPlanRoutingDecisionSchema,
  mcpRunPlanTextSchema,
  type McpRunResponse,
} from "./runProtocol.js";
import type { McpRunProvider } from "./runService.js";
import { mergeTaskFeatures, resolveMcpRoute, type McpRoutingMetadata } from "./routing.js";

type RunRoutingDecision = McpRunResponse["routing"][number];
type RunRoutingStage = RunRoutingDecision["stage"];
type PlanRoutingDecision = Extract<RunRoutingDecision, { stage: "plan" }>;
type JudgeRoutingDecision = Extract<RunRoutingDecision, { stage: "fast-judge" }>;

export interface CreateRoutedMcpRunProviderOptions {
  loadConfig?: () => OrchestratorConfig;
  complete?: McpCompletionExecutor;
  createDecisionId?: (stage: RunRoutingStage) => string;
}

/** Bridge the durable run service to the same trusted routing/completion path as compatibility tools. */
export function createRoutedMcpRunProvider(
  cwd = process.cwd(),
  options: CreateRoutedMcpRunProviderOptions = {},
): McpRunProvider {
  const configForCall = options.loadConfig ?? (() => loadConfig(cwd, { ignoreProjectMcpProviders: true }));
  const createDecisionId = options.createDecisionId ?? ((stage: RunRoutingStage) => `${stage}-${randomUUID()}`);

  return {
    preflight: (input) => {
      const config = configForCall();
      const route = resolveMcpRoute({
        config,
        stage: "fast-judge",
        role: "judge",
        task: mergeTaskFeatures(
          JSON.stringify({ task: input.task, repoContext: input.repoContext ?? null }),
          input.taskFeatures,
        ),
        coderIdentity: input.coderIdentity,
      });
      return {
        ...(route.builder?.family === undefined ? {} : { coderFamily: route.builder.family }),
        requireDifferentCheckerFamily: route.familySeparationRequired,
      };
    },

    plan: async (input) => {
      const config = configForCall();
      const routingDecisionId = createDecisionId("plan");
      const completion = await completeMcpPlan({
        config,
        routingDecisionId,
        task: input.task,
        ...(input.repoContext === undefined ? {} : { repoContext: input.repoContext }),
        ...(input.previousPlan === undefined ? {} : { previousPlan: input.previousPlan }),
        ...(input.judgeReports === undefined ? {} : { judgeReports: input.judgeReports }),
        ...(input.diff === undefined ? {} : { diffSummary: input.diff }),
        ...(input.userFeedback === undefined ? {} : { trustedRevisionFeedback: input.userFeedback }),
        ...(input.taskFeatures === undefined ? {} : { taskFeatures: input.taskFeatures }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        beforeAttempt: input.beforeAttempt,
        afterAttempt: input.afterAttempt,
        ...(options.complete === undefined ? {} : { complete: options.complete }),
      });
      return {
        plan: mcpRunPlanTextSchema.parse(completion.plan),
        routing: runRoutingDecision("plan", completion.routing),
      };
    },

    judge: async (input) => {
      const config = configForCall();
      const routingDecisionId = createDecisionId("fast-judge");
      const completion = await completeMcpJudge({
        config,
        routingDecisionId,
        task: input.task,
        plan: input.plan,
        diff: input.diff,
        ...(input.testOutput === undefined ? {} : { testOutput: input.testOutput }),
        coderIdentity: input.coderIdentity,
        ...(input.taskFeatures === undefined ? {} : { taskFeatures: input.taskFeatures }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        beforeAttempt: input.beforeAttempt,
        afterAttempt: input.afterAttempt,
        ...(options.complete === undefined ? {} : { complete: options.complete }),
      });
      return {
        ...completion.verdict,
        routing: runRoutingDecision("fast-judge", completion.routing),
      };
    },
  };
}

function runRoutingDecision(
  stage: "plan",
  routing: McpRoutingMetadata,
): PlanRoutingDecision;
function runRoutingDecision(
  stage: "fast-judge",
  routing: McpRoutingMetadata,
): JudgeRoutingDecision;
function runRoutingDecision(
  stage: RunRoutingStage,
  routing: McpRoutingMetadata,
): RunRoutingDecision {
  if (!routing.decision) throw new Error(`Missing frozen routing decision for ${stage}`);
  const decision = {
    decisionId: routing.decision.decisionId,
    stage,
    selectedIndex: routing.selectedIndex,
    selectedIdentity: routing.selectedIdentity,
    thinking: routing.thinking,
    policyVersion: routing.policyVersion,
    policyDigest: routing.decision.policyDigest,
    configDigest: routing.decision.configDigest,
    candidatesDigest: routing.decision.candidatesDigest,
    fallbackHistory: routing.fallbackHistory.map(({ identity, reason }) => ({
      identity,
      failureCode: classifyMcpProviderFailure(reason),
    })),
  };
  return stage === "plan"
    ? mcpRunPlanRoutingDecisionSchema.parse(decision)
    : mcpRunJudgeRoutingDecisionSchema.parse(decision);
}
