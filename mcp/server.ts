import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v3";
import { loadConfig, loopConfigFrom } from "../src/core/config.js";
import { nextPhase, type OrchestratorState } from "../src/core/loop.js";
import { completeMcpJudge, completeMcpPlan, type JudgeJson } from "./routedCompletion.js";
import { mergeTaskFeatures, resolveMcpRoute } from "./routing.js";
import {
  mcpRunAdvanceInputSchema,
  mcpRunCancelInputSchema,
  mcpRunGetInputSchema,
  mcpRunResponseSchema,
  mcpRunStartInputSchema,
  mcpRunToolResult,
  unavailableMcpRunAdapter,
  type McpRunAdapter,
} from "./runProtocol.js";

const MCP_TEXT_MAX = 2_000_000;
const MCP_REPORT_TEXT_MAX = 50_000;
const boundedText = z.string().max(MCP_TEXT_MAX);
const boundedNonEmptyText = boundedText.trim().min(1);
const boundedReportText = z.string().max(MCP_REPORT_TEXT_MAX);
const boundedNonEmptyReportText = boundedReportText.trim().min(1);

const judgeReportInputSchema = z.object({
  verdict: z.enum(["approve", "reject"]),
  reasons: boundedNonEmptyReportText,
  requiredFixes: boundedReportText.optional(),
});

const taskFeaturesSchema = z.object({
  contextTokens: z.number().int().min(1).max(10_000_000),
  expectedOutputTokens: z.number().int().min(1).max(1_000_000),
  requiredInput: z.array(z.enum(["text", "image"])).max(2),
  risk: z.enum(["low", "medium", "high"]),
  workKind: z.enum(["feature", "bug-fix", "refactor", "migration", "test-only", "documentation", "configuration", "release", "unknown"]),
  fileCount: z.number().int().min(0).max(1_000_000),
  languages: z.array(z.string().trim().min(1).max(200)).max(256),
  riskSignals: z.array(z.string().trim().min(1).max(500)).max(256),
  failureSignals: z.array(z.string().trim().min(1).max(500)).max(256),
});

const routingMetadataSchema = z.object({
  selectedIdentity: z.object({ provider: z.string(), model: z.string(), family: z.string().optional() }),
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  policyVersion: z.string(),
  score: z.object({ total: z.number(), breakdown: z.array(z.object({ name: z.string(), value: z.number(), detail: z.string() })) }).nullable(),
  fallbackHistory: z.array(z.object({ identity: z.string(), reason: z.string() })),
  separation: z.object({ required: z.boolean(), satisfied: z.boolean(), builderIdentity: z.string().optional(), reason: z.string() }),
  legacyFallback: z.boolean(),
});

const planInputSchema = {
  task: boundedNonEmptyText.describe("Implementation task to plan."),
  repoContext: boundedText.optional().describe("Repository context gathered by the client."),
  previousPlan: boundedNonEmptyText.optional().describe("Previous plan when re-planning after judge rejections."),
  judgeReports: z.union([boundedNonEmptyText, z.array(judgeReportInputSchema).max(20)]).optional().describe("Accumulated judge feedback to address during re-planning, either as text or structured reports."),
  diffSummary: boundedNonEmptyText.optional().describe("Summary or full text of the failed diff when re-planning."),
  taskFeatures: taskFeaturesSchema.optional().describe("Optional structured routing features; conservative features are derived when omitted."),
};

const judgeInputSchema = {
  task: boundedNonEmptyText.describe("Original user task being implemented."),
  plan: boundedNonEmptyText.describe("User-approved implementation plan currently being judged."),
  diff: boundedNonEmptyText.describe("Client-collected git diff and staged diff. The MCP server does not read the filesystem."),
  testOutput: boundedText.optional().describe("Client-collected relevant test command output, if tests were run."),
  iteration: z.number().int().min(1).describe("Total coding pass number being judged now. First judge call uses 1; use nextIteration returned by the prior judge call thereafter."),
  consecutiveRejections: z.number().int().min(0).describe("Consecutive rejection count before this verdict. First judge call uses 0; use nextConsecutiveRejections returned by the prior judge call thereafter."),
  coderIdentity: z.string().trim().regex(/^[^/\s]+\/\S+$/).max(500).describe("Required provider/model identity of the coder for maker/checker separation."),
  taskFeatures: taskFeaturesSchema.optional(),
};

const judgeOutputSchema = {
  verdict: z.enum(["approve", "reject"]).describe("Judge verdict for the current implementation."),
  reasons: z.string().min(1).describe("Concrete verdict rationale."),
  requiredFixes: z.string().min(1).optional().describe("Concrete required fixes. Present only when verdict is reject."),
  nextAction: z.enum(["retry_coding", "replan", "done", "stop_failed"]).describe("Next loop action computed by the core state machine."),
  nextIteration: z.number().int().min(1).describe("Iteration value the client must use on the next judge call, if any."),
  nextConsecutiveRejections: z.number().int().min(0).describe("Consecutive rejection value the client must use on the next judge call, if any."),
  routing: routingMetadataSchema,
};

type NextAction = "retry_coding" | "replan" | "done" | "stop_failed";

interface JudgeDecision {
  nextAction: NextAction;
  nextIteration: number;
  nextConsecutiveRejections: number;
}

const packageVersion = readPackageVersion();

export interface CreateServerOptions {
  runAdapter?: McpRunAdapter;
}

export { judgeMcpPrompt, parseJudgeJson } from "./routedCompletion.js";

export function createServer(cwd = process.cwd(), options: CreateServerOptions = {}): McpServer {
  const runAdapter = options.runAdapter ?? unavailableMcpRunAdapter;
  const server = new McpServer(
    { name: "ai-orchestrator", version: packageVersion },
    {
      instructions:
        "Use orchestrator_plan before non-trivial implementation work, wait for user approval, then use orchestrator_judge after coding with diff and test output.",
    },
  );

  server.server.onerror = (error) => {
    console.error("[ai-orchestrator-mcp] protocol error", error);
  };

  server.registerTool(
    "orchestrator_plan",
    {
      title: "Create orchestrator implementation plan",
      description: "Call the configured planner model to produce an implementation plan or revised plan.",
      inputSchema: planInputSchema,
      outputSchema: { plan: z.string().min(1), routing: routingMetadataSchema },
    },
    async ({ task, repoContext, previousPlan, judgeReports, diffSummary, taskFeatures }, extra) => {
      const config = loadMcpConfig(cwd);
      if (!previousPlan && (judgeReports !== undefined || diffSummary !== undefined)) {
        throw new Error("previousPlan is required when supplying judgeReports or diffSummary for re-planning");
      }
      const completion = await completeMcpPlan({
        config,
        task,
        ...(repoContext === undefined ? {} : { repoContext }),
        ...(previousPlan === undefined ? {} : { previousPlan }),
        ...(judgeReports === undefined ? {} : { judgeReports }),
        ...(diffSummary === undefined ? {} : { diffSummary }),
        ...(taskFeatures === undefined ? {} : { taskFeatures }),
        signal: extra.signal,
      });
      const reminder = `Present this plan to the user for approval before implementing (loop policy: max ${config.loop.maxCoderIterations} coder iterations, escalate to re-plan after ${config.loop.plannerEscalationAfterRejections} consecutive rejections).`;
      return {
        structuredContent: completion,
        content: [
          { type: "text", text: completion.plan },
          { type: "text", text: reminder },
          { type: "text", text: JSON.stringify({ routing: completion.routing }, null, 2) },
        ],
      };
    },
  );

  server.registerTool(
    "orchestrator_judge",
    {
      title: "Judge orchestrator implementation",
      description: "Call the configured judge model on a client-supplied diff and test output, returning a verdict, next action, and next judge-call counters.",
      inputSchema: judgeInputSchema,
      outputSchema: judgeOutputSchema,
    },
    async ({ task, plan, diff, testOutput, iteration, consecutiveRejections, coderIdentity, taskFeatures }, extra) => {
      const config = loadMcpConfig(cwd);
      validateJudgeCounters({ iteration, consecutiveRejections, config });
      const completion = await completeMcpJudge({
        config, task, plan, diff,
        ...(testOutput === undefined ? {} : { testOutput }),
        coderIdentity,
        ...(taskFeatures === undefined ? {} : { taskFeatures }),
        signal: extra.signal,
      });
      const verdict = completion.verdict;
      const decision = computeJudgeDecision({
        task,
        plan,
        iteration,
        consecutiveRejections,
        verdict,
        config,
      });
      const result = { ...verdict, ...decision, routing: completion.routing };
      return {
        structuredContent: result,
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "orchestrator_models",
    {
      title: "Preview trusted MCP model routing",
      description: "Rank the trusted user MCP catalog without invoking any model or exposing provider secrets.",
      inputSchema: {
        stage: z.enum(["plan", "fast-judge"]),
        task: boundedNonEmptyText,
        taskFeatures: taskFeaturesSchema.optional(),
        coderIdentity: z.string().trim().regex(/^[^/\s]+\/\S+$/).max(500).optional(),
      },
      outputSchema: {
        stage: z.enum(["plan", "fast-judge"]),
        policyVersion: z.string(),
        legacyFallback: z.boolean(),
        separation: routingMetadataSchema.shape.separation,
        eligible: z.array(z.object({ identity: z.string(), thinking: routingMetadataSchema.shape.thinking, score: z.number().nullable(), scoreBreakdown: z.array(z.object({ name: z.string(), value: z.number(), detail: z.string() })) })),
        excluded: z.array(z.object({ identity: z.string(), code: z.string(), detail: z.string() })),
      },
    },
    async ({ stage, task, taskFeatures, coderIdentity }) => {
      const config = loadMcpConfig(cwd);
      const route = resolveMcpRoute({
        config,
        stage,
        role: stage === "plan" ? "planner" : "judge",
        task: mergeTaskFeatures(task, taskFeatures),
        coderIdentity,
        preview: true,
      });
      const preview = {
        stage,
        policyVersion: route.policyVersion,
        legacyFallback: route.legacyFallback,
        separation: route.separation,
        eligible: route.candidates.map((candidate, index) => ({
          identity: `${candidate.provider}/${candidate.model}`,
          thinking: candidate.thinking,
          score: route.ranked[index]?.score ?? null,
          scoreBreakdown: route.ranked[index]?.scoreBreakdown ?? [],
        })),
        excluded: route.excluded.map((candidate) => ({
          identity: `${candidate.identity.provider}/${candidate.identity.model}`,
          code: candidate.code,
          detail: candidate.detail,
        })),
      };
      return { structuredContent: preview, content: [{ type: "text", text: JSON.stringify(preview, null, 2) }] };
    },
  );

  server.registerTool(
    "orchestrator_run_start",
    {
      title: "Start a durable orchestrator run",
      description: "Create a server-owned Plan → Code → Judge run. The returned plan always requires explicit approval.",
      inputSchema: mcpRunStartInputSchema,
      outputSchema: mcpRunResponseSchema,
    },
    async (input, extra) => mcpRunToolResult(await runAdapter.start(input, extra.signal)),
  );

  server.registerTool(
    "orchestrator_run_get",
    {
      title: "Inspect a durable orchestrator run",
      description: "Read the current non-sensitive status, revision, plan, and permitted client events for a run.",
      inputSchema: mcpRunGetInputSchema,
      outputSchema: mcpRunResponseSchema,
    },
    async (input, extra) => mcpRunToolResult(await runAdapter.get(input, extra.signal)),
  );

  server.registerTool(
    "orchestrator_run_advance",
    {
      title: "Advance a durable orchestrator run",
      description: "Apply one permitted client observation using optimistic concurrency and a client idempotency key.",
      inputSchema: mcpRunAdvanceInputSchema,
      outputSchema: mcpRunResponseSchema,
    },
    async (input, extra) => mcpRunToolResult(await runAdapter.advance(input, extra.signal)),
  );

  server.registerTool(
    "orchestrator_run_cancel",
    {
      title: "Cancel a durable orchestrator run",
      description: "Cancel an active run at the expected revision while retaining its evidence for inspection.",
      inputSchema: mcpRunCancelInputSchema,
      outputSchema: mcpRunResponseSchema,
    },
    async (input, extra) => mcpRunToolResult(await runAdapter.cancel(input, extra.signal)),
  );

  return server;
}

export async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  transport.onerror = (error) => {
    console.error("[ai-orchestrator-mcp] transport error", error);
  };
  await server.connect(transport);
}

function loadMcpConfig(cwd: string): ReturnType<typeof loadConfig> {
  return loadConfig(cwd, { ignoreProjectMcpProviders: true });
}

function validateJudgeCounters(input: {
  iteration: number;
  consecutiveRejections: number;
  config: ReturnType<typeof loadConfig>;
}): void {
  if (input.iteration > input.config.loop.maxCoderIterations) {
    throw new Error(
      `Invalid iteration ${input.iteration}; loop.maxCoderIterations is ${input.config.loop.maxCoderIterations}`,
    );
  }
  if (input.consecutiveRejections >= input.iteration) {
    throw new Error(
      `Invalid consecutiveRejections ${input.consecutiveRejections}; it must be less than iteration ${input.iteration}`,
    );
  }
  if (input.consecutiveRejections >= input.config.loop.plannerEscalationAfterRejections) {
    throw new Error(
      `Invalid consecutiveRejections ${input.consecutiveRejections}; planner escalation should have occurred at ${input.config.loop.plannerEscalationAfterRejections}`,
    );
  }
}

function computeJudgeDecision(input: {
  task: string;
  plan: string;
  iteration: number;
  consecutiveRejections: number;
  verdict: JudgeJson;
  config: ReturnType<typeof loadConfig>;
}): JudgeDecision {
  const state: OrchestratorState = {
    phase: "judging",
    task: input.task,
    plan: input.plan,
    coderIterations: input.iteration,
    consecutiveRejections: input.consecutiveRejections,
    judgeReports: [],
    yolo: input.config.approval.requirePlanApproval === false,
  };
  const verdictEvent = input.verdict.verdict === "reject"
    ? {
        type: "verdict" as const,
        verdict: "reject" as const,
        reasons: input.verdict.reasons,
        requiredFixes: input.verdict.requiredFixes,
      }
    : { type: "verdict" as const, verdict: "approve" as const, reasons: input.verdict.reasons };
  const next = nextPhase(state, verdictEvent, loopConfigFrom(input.config));
  const nextAction = (() => {
    switch (next.phase) {
      case "coding":
        return "retry_coding";
      case "replanning":
        return "replan";
      case "done":
        return "done";
      case "failed":
        return "stop_failed";
      default:
        throw new Error(`Unexpected next phase after judge verdict: ${next.phase}`);
    }
  })();

  return {
    nextAction,
    nextIteration: next.phase === "coding" || next.phase === "replanning" ? next.coderIterations + 1 : next.coderIterations,
    nextConsecutiveRejections: next.consecutiveRejections,
  };
}

function readPackageVersion(): string {
  for (const candidate of ["../package.json", "../../package.json"]) {
    try {
      const packageJson = JSON.parse(readFileSync(new URL(candidate, import.meta.url), "utf8")) as { version?: unknown };
      if (typeof packageJson.version === "string" && packageJson.version.length > 0) {
        return packageJson.version;
      }
    } catch {
      // Try the next source/dist-relative location.
    }
  }
  return "0.0.0";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
