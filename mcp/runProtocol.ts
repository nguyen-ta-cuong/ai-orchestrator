import { z } from "zod/v3";
import { FAILURE_CATEGORIES } from "../src/core/recovery.js";
import { MCP_PROVIDER_DEFINITE_FAILURE_CODES } from "./failureCodes.js";

const MCP_RUN_TEXT_MAX = 2_000_000;
const MCP_RUN_REPORT_TEXT_MAX = 50_000;
export const MCP_RUN_ROUTING_MAX = 100;

const boundedText = z.string().max(MCP_RUN_TEXT_MAX);
const boundedNonEmptyText = boundedText.trim().min(1);
const boundedReportText = z.string().max(MCP_RUN_REPORT_TEXT_MAX);
const boundedNonEmptyReportText = boundedReportText.trim().min(1);
const safeRevision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const mcpRunPlanTextSchema = boundedNonEmptyText;

export const mcpRunIdSchema = z.string()
  .regex(/^mrun_[A-Za-z0-9_-]{22,86}$/)
  .describe("Opaque server-generated run identifier.");

export const mcpRequestIdSchema = z.string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  .describe("Client-generated idempotency key. Reuse it only when retrying the identical mutation.");

const coderIdentitySchema = z.string()
  .trim()
  .regex(/^[^/\s]+\/\S+$/)
  .max(500)
  .describe("Declared Cursor coder identity in canonical provider/model form.");

export const mcpTaskFeaturesSchema = z.object({
  contextTokens: z.number().int().min(1).max(10_000_000),
  expectedOutputTokens: z.number().int().min(1).max(1_000_000),
  requiredInput: z.array(z.enum(["text", "image"])).max(2),
  risk: z.enum(["low", "medium", "high"]),
  workKind: z.enum(["feature", "bug-fix", "refactor", "migration", "test-only", "documentation", "configuration", "release", "unknown"]),
  fileCount: z.number().int().min(0).max(1_000_000),
  languages: z.array(z.string().trim().min(1).max(200)).max(256),
  riskSignals: z.array(z.string().trim().min(1).max(500)).max(256),
  failureSignals: z.array(z.string().trim().min(1).max(500)).max(256),
}).strict();

export const mcpRunStartInputSchema = z.object({
  requestId: mcpRequestIdSchema,
  task: boundedNonEmptyText.describe("Implementation task for the server-owned orchestration run."),
  repoContext: boundedText.optional().describe("Bounded repository context collected by the Cursor client."),
  coderIdentity: coderIdentitySchema,
  taskFeatures: mcpTaskFeaturesSchema.optional(),
}).strict();

export const mcpRunGetInputSchema = z.object({
  runId: mcpRunIdSchema,
}).strict();

export const mcpRunClientEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("plan_approved") }).strict(),
  z.object({
    type: z.literal("plan_revision_requested"),
    feedback: boundedNonEmptyReportText,
  }).strict(),
  z.object({
    type: z.literal("code_result_submitted"),
    diff: boundedNonEmptyText,
    testOutput: boundedText.optional(),
  }).strict(),
  z.object({
    type: z.literal("cancelled"),
    reason: boundedReportText.optional(),
  }).strict(),
]);

export const mcpRunAdvanceInputSchema = z.object({
  requestId: mcpRequestIdSchema,
  runId: mcpRunIdSchema,
  expectedRevision: safeRevision,
  event: mcpRunClientEventSchema,
}).strict();

export const mcpRunCancelInputSchema = z.object({
  requestId: mcpRequestIdSchema,
  runId: mcpRunIdSchema,
  expectedRevision: safeRevision,
  reason: boundedReportText.optional(),
}).strict();

export const mcpRunRecoverInputSchema = z.object({
  requestId: mcpRequestIdSchema,
  runId: mcpRunIdSchema,
  expectedRevision: safeRevision,
}).strict();

export const mcpRunRoutingDecisionSchema = z.object({
  decisionId: z.string().regex(/^[A-Za-z0-9._:@/-]{1,128}$/),
  stage: z.enum(["plan", "fast-judge"]),
  selectedIndex: z.number().int().min(0).max(99),
  selectedIdentity: z.object({
    provider: z.string().trim().min(1).max(200),
    model: z.string().trim().min(1).max(500),
    family: z.string().trim().min(1).max(500).optional(),
  }).strict(),
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  policyVersion: z.string().trim().min(1).max(256),
  policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  configDigest: z.string().regex(/^[a-f0-9]{64}$/),
  candidatesDigest: z.string().regex(/^[a-f0-9]{64}$/),
  fallbackHistory: z.array(z.object({
    identity: z.string().trim().min(1).max(700),
    failureCode: z.enum(MCP_PROVIDER_DEFINITE_FAILURE_CODES),
  }).strict()).max(100),
}).strict();

export const mcpRunPlanRoutingDecisionSchema = mcpRunRoutingDecisionSchema.extend({
  stage: z.literal("plan"),
}).strict();

export const mcpRunJudgeRoutingDecisionSchema = mcpRunRoutingDecisionSchema.extend({
  stage: z.literal("fast-judge"),
}).strict();

export const mcpRunApproveVerdictSchema = z.object({
  verdict: z.literal("approve"),
  reasons: boundedNonEmptyReportText,
}).strict();

export const mcpRunRejectVerdictSchema = z.object({
  verdict: z.literal("reject"),
  reasons: boundedNonEmptyReportText,
  requiredFixes: boundedNonEmptyReportText,
}).strict();

export const mcpRunVerdictSchema = z.discriminatedUnion("verdict", [
  mcpRunApproveVerdictSchema,
  mcpRunRejectVerdictSchema,
]);

const budgetValuesSchema = z.record(z.string().trim().min(1).max(100), z.number().finite().min(0).nullable());

export const mcpRunResponseSchema = z.object({
  outcome: z.enum(["started", "current", "advanced", "cancelled", "conflict"]),
  runId: mcpRunIdSchema,
  revision: safeRevision,
  status: z.enum(["active", "done", "failed", "cancelled", "blocked"]),
  currentNode: z.enum(["idle", "planning", "awaiting_approval", "coding", "judging", "replanning", "done", "failed"]),
  requiredAction: z.enum(["approve_or_revise_plan", "implement_and_submit_code", "inspect_run", "none"]),
  permittedEvents: z.array(z.enum(["plan_approved", "plan_revision_requested", "code_result_submitted", "cancelled"])).max(4),
  plan: mcpRunPlanTextSchema.optional(),
  lastVerdict: mcpRunVerdictSchema.optional(),
  routing: z.array(mcpRunRoutingDecisionSchema).max(MCP_RUN_ROUTING_MAX),
  progress: z.object({
    coderIterations: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    consecutiveRejections: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    planVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  }).strict(),
  limits: budgetValuesSchema,
  remaining: budgetValuesSchema,
  recovery: z.object({
    failureFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum([
      "active", "waiting-diagnosis", "waiting-configuration", "waiting-authorization", "waiting-policy",
      "waiting-side-effect-review", "waiting-successor-artifact", "waiting-successor-approval",
      "ready-successor-activation", "released", "failed",
    ]),
    action: z.enum(["retry", "repair", "replan", "pause", "fail"]).optional(),
    reason: z.enum([
      "transient-failure", "local-defect", "structural-defect", "diagnosis-required", "unknown-after-diagnosis",
      "configuration-change-required", "human-authorization-required", "policy-change-required",
      "side-effect-review-required", "global-budget-exhausted", "retry-exhausted", "repair-exhausted",
      "replan-exhausted", "recovery-level-consumed", "recovery-level-skipped",
    ]).optional(),
    sourcePlanVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    targetPlanVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    remaining: z.object({ retry: z.number().int().min(0).max(1), repair: z.number().int().min(0).max(1), replan: z.number().int().min(0).max(1) }).strict(),
    executionStatus: z.enum(["awaiting-client", "executing-provider", "completed"]).optional(),
    directive: z.object({
      rootCauseCategory: z.enum(FAILURE_CATEGORIES),
      confidence: z.enum(["low", "medium", "high"]),
      repairScope: z.array(z.string().max(4_096)).max(256),
      validationRequirements: z.array(z.string().max(256)).max(256),
      topologyAssessment: z.enum(["preserve", "structural"]),
    }).strict().optional(),
  }).strict().optional(),
  conflict: z.object({
    expectedRevision: safeRevision,
    currentRevision: safeRevision,
  }).strict().optional(),
  message: boundedReportText.optional(),
}).strict();

export type McpRunStartInput = z.infer<typeof mcpRunStartInputSchema>;
export type McpRunGetInput = z.infer<typeof mcpRunGetInputSchema>;
export type McpRunAdvanceInput = z.infer<typeof mcpRunAdvanceInputSchema>;
export type McpRunCancelInput = z.infer<typeof mcpRunCancelInputSchema>;
export type McpRunRecoverInput = z.infer<typeof mcpRunRecoverInputSchema>;
export type McpRunClientEvent = z.infer<typeof mcpRunClientEventSchema>;
export type McpRunResponse = z.infer<typeof mcpRunResponseSchema>;

export interface McpRunAdapter {
  start(input: McpRunStartInput, signal?: AbortSignal): Promise<McpRunResponse>;
  get(input: McpRunGetInput, signal?: AbortSignal): Promise<McpRunResponse>;
  advance(input: McpRunAdvanceInput, signal?: AbortSignal): Promise<McpRunResponse>;
  cancel(input: McpRunCancelInput, signal?: AbortSignal): Promise<McpRunResponse>;
  recover?(input: McpRunRecoverInput, signal?: AbortSignal): Promise<McpRunResponse>;
}

export function mcpRunToolResult(response: McpRunResponse): {
  structuredContent: McpRunResponse;
  content: [{ type: "text"; text: string }];
} {
  const validated = mcpRunResponseSchema.parse(response);
  return {
    structuredContent: validated,
    content: [{ type: "text", text: JSON.stringify(validated, null, 2) }],
  };
}

export const unavailableMcpRunAdapter: McpRunAdapter = {
  start: unavailable,
  get: unavailable,
  advance: unavailable,
  cancel: unavailable,
  recover: unavailable,
};

async function unavailable(): Promise<never> {
  throw new Error("Stateful MCP run storage is not available yet");
}
