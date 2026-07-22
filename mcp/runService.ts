import { createHash, randomBytes } from "node:crypto";
import { z } from "zod/v3";
import {
  createIdleState,
  nextPhase,
  type JudgeReport,
  type LoopConfig,
  type OrchestratorState,
} from "../src/core/loop.js";
import {
  MCP_RUN_ROUTING_MAX,
  mcpRunApproveVerdictSchema,
  mcpRunAdvanceInputSchema,
  mcpRunCancelInputSchema,
  mcpRunGetInputSchema,
  mcpRunIdSchema,
  mcpRunJudgeRoutingDecisionSchema,
  mcpRunPlanRoutingDecisionSchema,
  mcpRunPlanTextSchema,
  mcpRunRejectVerdictSchema,
  mcpRunResponseSchema,
  mcpRunStartInputSchema,
  type McpRunAdapter,
  type McpRunClientEvent,
  type McpRunResponse,
  type McpRunStartInput,
} from "./runProtocol.js";
import type { RoutedCompletionAttempt, RoutedCompletionAttemptResult } from "./llm.js";
import { MCP_PROVIDER_FAILURE_CODES } from "./failureCodes.js";

type RunRoutingDecision = McpRunResponse["routing"][number];
type PlanRoutingDecision = z.infer<typeof mcpRunPlanRoutingDecisionSchema>;
type JudgeRoutingDecision = z.infer<typeof mcpRunJudgeRoutingDecisionSchema>;
type RunVerdict = NonNullable<McpRunResponse["lastVerdict"]>;
type RunOutcome = McpRunResponse["outcome"];
type RunStatus = McpRunResponse["status"];

const planProviderResultSchema = z.object({
  plan: mcpRunPlanTextSchema,
  routing: mcpRunPlanRoutingDecisionSchema,
}).strict();

const judgeProviderResultSchema = z.discriminatedUnion("verdict", [
  mcpRunApproveVerdictSchema.extend({ routing: mcpRunJudgeRoutingDecisionSchema }).strict(),
  mcpRunRejectVerdictSchema.extend({ routing: mcpRunJudgeRoutingDecisionSchema }).strict(),
]);

const preflightResultSchema = z.object({
  coderFamily: z.string().trim().min(1).max(500).optional(),
  requireDifferentCheckerFamily: z.boolean(),
}).strict();

const providerAttemptSchema = z.object({
  attempt: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  identity: z.object({
    provider: z.string().trim().min(1).max(200),
    model: z.string().trim().min(1).max(500),
    family: z.string().trim().min(1).max(500).optional(),
  }).strict(),
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  requestedOutputTokens: z.number().int().min(1).max(1_000_000).optional(),
  estimatedCostUsd: z.number().finite().min(0).optional(),
}).strict();

const providerAttemptResultSchema = z.discriminatedUnion("outcome", [
  providerAttemptSchema.extend({ outcome: z.literal("succeeded") }).strict(),
  providerAttemptSchema.extend({
    outcome: z.literal("failed"),
    failureCode: z.enum(MCP_PROVIDER_FAILURE_CODES),
  }).strict(),
]);

class ProviderCheckpointError extends Error {
  constructor() {
    super("Provider outcome checkpoint failed; the result is uncertain and requires recovery");
    this.name = "ProviderCheckpointError";
  }
}

interface ProviderEffectBase {
  kind: "plan" | "judge";
  ordinal: number;
}

export type ProviderEffect = ProviderEffectBase & (
  | { phase: "prepared" }
  | { phase: "attempting"; attempt: RoutedCompletionAttempt }
  | { phase: "attempted"; result: Extract<RoutedCompletionAttemptResult, { outcome: "failed" }> }
  | { phase: "awaiting_output_commit"; attempt: RoutedCompletionAttempt }
);

export interface McpRunPreflightRequest {
  task: string;
  repoContext?: string;
  coderIdentity: string;
  taskFeatures?: McpRunStartInput["taskFeatures"];
}

export interface McpRunPlanRequest {
  task: string;
  repoContext?: string;
  taskFeatures?: McpRunStartInput["taskFeatures"];
  previousPlan?: string;
  userFeedback?: string;
  judgeReports?: JudgeReport[];
  diff?: string;
  signal?: AbortSignal;
  beforeAttempt: (attempt: RoutedCompletionAttempt) => void | Promise<void>;
  afterAttempt: (result: RoutedCompletionAttemptResult) => void | Promise<void>;
}

export interface McpRunJudgeRequest {
  task: string;
  plan: string;
  diff: string;
  testOutput?: string;
  coderIdentity: string;
  taskFeatures?: McpRunStartInput["taskFeatures"];
  iteration: number;
  consecutiveRejections: number;
  signal?: AbortSignal;
  beforeAttempt: (attempt: RoutedCompletionAttempt) => void | Promise<void>;
  afterAttempt: (result: RoutedCompletionAttemptResult) => void | Promise<void>;
}

export interface McpRunProvider {
  /**
   * Resolve trusted checker eligibility without a provider/network call.
   * This is synchronous because start invokes it before run authority exists.
   */
  preflight(input: McpRunPreflightRequest): {
    coderFamily?: string;
    requireDifferentCheckerFamily: boolean;
  };
  plan(input: McpRunPlanRequest): Promise<{ plan: string; routing: PlanRoutingDecision }>;
  judge(input: McpRunJudgeRequest): Promise<RunVerdict & { routing: JudgeRoutingDecision }>;
}

/**
 * Durable state needed by the service. A disk adapter may encode the large
 * payload fields as artifact references; request records below never contain
 * raw task, prompt, diff, test, or provider-output text.
 */
export interface McpRunRecord {
  runId: string;
  revision: number;
  status: Exclude<RunStatus, "blocked">;
  state: OrchestratorState;
  repoContext?: string;
  coderIdentity: string;
  coderFamily?: string;
  requireDifferentCheckerFamily: boolean;
  taskFeatures?: McpRunStartInput["taskFeatures"];
  loop: LoopConfig;
  planVersion: number;
  routing: RunRoutingDecision[];
  lastVerdict?: RunVerdict;
  terminalMessage?: string;
  pendingProviderIntent: boolean;
  providerAttempts: number;
  maxProviderCalls: number;
  cancelledCheckpoint?: OrchestratorState;
}

export type McpRunRecordDraft = Omit<McpRunRecord, "revision">;

interface McpRunRequestBase {
  requestRef: string;
  requestHash: string;
}

export type McpRunRequestUpdate =
  | (McpRunRequestBase & { state: "pending"; effect: ProviderEffect })
  | (McpRunRequestBase & { state: "settled"; outcome: RunOutcome });

export type McpRunRequestRecord =
  | (Extract<McpRunRequestUpdate, { state: "pending" }> & {
    runId: string;
    reservedRevision: number;
  })
  | (Extract<McpRunRequestUpdate, { state: "settled" }> & {
    runId: string;
    checkpoint: McpRunCheckpointReference;
  });

export interface McpRunCheckpointReference {
  runId: string;
  revision: number;
}

export interface McpRunStartTransaction {
  getRequest(): Promise<McpRunRequestRecord | undefined>;
  /** Atomically create the run, reserve the provider intent, and assign a revision. */
  reserve(draft: McpRunRecordDraft, request: Extract<McpRunRequestUpdate, { state: "pending" }>): Promise<McpRunRecord>;
  /** Atomically CAS the run, update the request record, and assign a revision. */
  compareAndSwap(
    expectedRevision: number,
    draft: McpRunRecordDraft,
    request: McpRunRequestUpdate,
  ): Promise<McpRunRecord | undefined>;
}

export interface McpRunTransaction {
  get(): Promise<McpRunRecord | undefined>;
  getRequest(requestRef: string): Promise<McpRunRequestRecord | undefined>;
  /** Atomically CAS the run, update the request record, and assign a revision. */
  compareAndSwap(
    expectedRevision: number,
    draft: McpRunRecordDraft,
    request: McpRunRequestUpdate,
  ): Promise<McpRunRecord | undefined>;
}

/**
 * The callback runs under a repository lease. Each transaction write must be
 * durable before it resolves; the repository, not this service, is the sole
 * authority that assigns monotonically increasing per-run revisions.
 */
export interface McpRunRepository {
  withStartLease<T>(requestRef: string, work: (transaction: McpRunStartTransaction) => Promise<T>): Promise<T>;
  withRunLease<T>(runId: string, work: (transaction: McpRunTransaction) => Promise<T>): Promise<T>;
  get(runId: string): Promise<McpRunRecord | undefined>;
  getCheckpoint(reference: McpRunCheckpointReference): Promise<McpRunRecord | undefined>;
}

export interface CreateMcpRunServiceOptions {
  repository: McpRunRepository;
  provider: McpRunProvider;
  loop: LoopConfig;
  createRunId?: () => string;
  maxProviderCalls?: number;
  /** Test/recovery hook executed after provider return and before settlement. */
  afterProviderResult?: (context: { runId: string; effect: ProviderEffect }) => void | Promise<void>;
}

export function createMcpRunService(options: CreateMcpRunServiceOptions): McpRunAdapter {
  const loop: LoopConfig = { ...options.loop, requirePlanApproval: true };
  // Exercise the shared validator now rather than after the first provider call.
  nextPhase(createIdleState(), { type: "start", task: "validate", yolo: false }, loop);
  const createRunId = options.createRunId ?? defaultRunId;
  const maxProviderCalls = options.maxProviderCalls ?? 100;
  if (!Number.isInteger(maxProviderCalls) || maxProviderCalls < 1) {
    throw new Error("maxProviderCalls must be a positive integer");
  }

  return {
    start: async (unparsed, signal) => {
      const input = mcpRunStartInputSchema.parse(unparsed);
      const identity = requestIdentity("start", input.requestId, input);
      return options.repository.withStartLease(identity.requestRef, async (transaction) => {
        const previous = await transaction.getRequest();
        if (previous) return replayRequest(previous, identity.requestHash, options.repository);

        const preflight = preflightResultSchema.parse(options.provider.preflight({
          task: input.task,
          ...(input.repoContext === undefined ? {} : { repoContext: input.repoContext }),
          coderIdentity: input.coderIdentity,
          ...(input.taskFeatures === undefined ? {} : { taskFeatures: structuredClone(input.taskFeatures) }),
        }));
        const runId = mcpRunIdSchema.parse(createRunId());
        const planning = nextPhase(createIdleState(), { type: "start", task: input.task, yolo: false }, loop);
        const effect: ProviderEffect = { kind: "plan", ordinal: 1, phase: "prepared" };
        const initialDraft: McpRunRecordDraft = {
          runId,
          status: "active",
          state: planning,
          ...(input.repoContext === undefined ? {} : { repoContext: input.repoContext }),
          coderIdentity: input.coderIdentity,
          ...(preflight.coderFamily === undefined ? {} : { coderFamily: preflight.coderFamily }),
          requireDifferentCheckerFamily: preflight.requireDifferentCheckerFamily,
          ...(input.taskFeatures === undefined ? {} : { taskFeatures: structuredClone(input.taskFeatures) }),
          loop: structuredClone(loop),
          planVersion: 1,
          routing: [],
          pendingProviderIntent: true,
          providerAttempts: 0,
          maxProviderCalls,
        };
        assertProspectiveResponse(initialDraft, 0, "current");
        const reserved = await transaction.reserve(
          initialDraft,
          pendingRequest(identity, effect),
        );

        const tracker = providerAttemptTracker(transaction, reserved, identity, effect);
        const providerResult = await callPlanProvider(options.provider, planRequest(reserved, tracker, { signal }));
        if (!providerResult.ok) {
          return settleProviderFailure(transaction, tracker.current(), identity, "started");
        }
        if (!tracker.canCommitReturnedResult()) {
          return settleProviderFailure(transaction, tracker.current(), identity, "started");
        }
        const completion = providerResult.value;
        await options.afterProviderResult?.({ runId, effect });
        const providerCheckpoint = tracker.current();
        const withPlan = nextPhase(providerCheckpoint.state, { type: "plan_produced", plan: completion.plan }, loop);
        const settled = await compareAndSwapValidated(
          transaction,
          providerCheckpoint.revision,
          draftFrom(providerCheckpoint, {
            state: withPlan,
            routing: [...providerCheckpoint.routing, completion.routing],
            pendingProviderIntent: false,
          }),
          settledRequest(identity, "started"),
          "started",
        );
        return responseFor(requireCommitted(settled, "settling PLAN start"), "started");
      });
    },

    get: async (unparsed) => {
      const input = mcpRunGetInputSchema.parse(unparsed);
      const record = await requireRun(options.repository, input.runId);
      return responseFor(record, "current");
    },

    advance: async (unparsed, signal) => {
      const input = mcpRunAdvanceInputSchema.parse(unparsed);
      const identity = requestIdentity("advance", input.requestId, input);
      return options.repository.withRunLease(input.runId, async (transaction) => {
        const replay = await transaction.getRequest(identity.requestRef);
        if (replay) return replayRequest(replay, identity.requestHash, options.repository);

        const current = await requireTransactionRun(transaction, input.runId);
        if (current.revision !== input.expectedRevision) {
          return conflictResponse(current, input.expectedRevision);
        }
        if (current.pendingProviderIntent && input.event.type !== "cancelled") return responseFor(current, "current");
        assertMutable(current);

        switch (input.event.type) {
          case "plan_approved":
            return approvePlan(transaction, current, identity, loop);
          case "plan_revision_requested":
            return revisePlan(transaction, current, input.event.feedback, identity, loop, options, signal);
          case "code_result_submitted":
            return submitCode(transaction, current, input.event, identity, loop, options, signal);
          case "cancelled":
            return cancelRun(transaction, current, input.event.reason, identity);
          default:
            return assertNever(input.event);
        }
      });
    },

    cancel: async (unparsed) => {
      const input = mcpRunCancelInputSchema.parse(unparsed);
      const identity = requestIdentity("cancel", input.requestId, input);
      return options.repository.withRunLease(input.runId, async (transaction) => {
        const replay = await transaction.getRequest(identity.requestRef);
        if (replay) return replayRequest(replay, identity.requestHash, options.repository);

        const current = await requireTransactionRun(transaction, input.runId);
        if (current.revision !== input.expectedRevision) {
          return conflictResponse(current, input.expectedRevision);
        }
        assertMutable(current);
        return cancelRun(transaction, current, input.reason, identity);
      });
    },
  };
}

interface RequestIdentity {
  requestRef: string;
  requestHash: string;
}

async function approvePlan(
  transaction: McpRunTransaction,
  current: McpRunRecord,
  identity: RequestIdentity,
  loop: LoopConfig,
): Promise<McpRunResponse> {
  assertPhase(current, "awaiting_approval", "plan_approved");
  const state = nextPhase(current.state, { type: "plan_approved" }, loop);
  const committed = await compareAndSwapValidated(
    transaction,
    current.revision,
    draftFrom(current, { state }),
    settledRequest(identity, "advanced"),
    "advanced",
  );
  return responseFor(requireCommitted(committed, "approving plan"), "advanced");
}

async function revisePlan(
  transaction: McpRunTransaction,
  current: McpRunRecord,
  feedback: string,
  identity: RequestIdentity,
  loop: LoopConfig,
  options: CreateMcpRunServiceOptions,
  signal?: AbortSignal,
): Promise<McpRunResponse> {
  assertPhase(current, "awaiting_approval", "plan_revision_requested");
  assertRoutingCapacity(current);
  const planning = nextPhase(current.state, { type: "plan_rejected_by_user" }, loop);
  const effect: ProviderEffect = { kind: "plan", ordinal: 1, phase: "prepared" };
  const reserved = await compareAndSwapValidated(
    transaction,
    current.revision,
    draftFrom(current, { state: planning, pendingProviderIntent: true }),
    pendingRequest(identity, effect),
    "current",
  );
  const intent = requireCommitted(reserved, "reserving PLAN revision intent");
  const tracker = providerAttemptTracker(transaction, intent, identity, effect);
  const providerResult = await callPlanProvider(options.provider, planRequest(intent, tracker, {
    previousPlan: current.state.plan,
    userFeedback: feedback,
    judgeReports: intent.state.judgeReports,
    signal,
  }));
  if (!providerResult.ok) return settleProviderFailure(transaction, tracker.current(), identity, "advanced");
  if (!tracker.canCommitReturnedResult()) {
    return settleProviderFailure(transaction, tracker.current(), identity, "advanced");
  }
  const completion = providerResult.value;
  await options.afterProviderResult?.({ runId: current.runId, effect });
  const providerCheckpoint = tracker.current();
  const withPlan = nextPhase(providerCheckpoint.state, { type: "plan_produced", plan: completion.plan }, loop);
  const committed = await compareAndSwapValidated(
    transaction,
    providerCheckpoint.revision,
    draftFrom(providerCheckpoint, {
      state: withPlan,
      planVersion: current.planVersion + 1,
      routing: [...providerCheckpoint.routing, completion.routing],
      pendingProviderIntent: false,
    }),
    settledRequest(identity, "advanced"),
    "advanced",
  );
  return responseFor(requireCommitted(committed, "settling revised PLAN"), "advanced");
}

async function submitCode(
  transaction: McpRunTransaction,
  current: McpRunRecord,
  event: Extract<McpRunClientEvent, { type: "code_result_submitted" }>,
  identity: RequestIdentity,
  loop: LoopConfig,
  options: CreateMcpRunServiceOptions,
  signal?: AbortSignal,
): Promise<McpRunResponse> {
  assertPhase(current, "coding", "code_result_submitted");
  assertRoutingCapacity(current);
  const judging = nextPhase(current.state, { type: "code_produced" }, loop);
  const judgeEffect: ProviderEffect = { kind: "judge", ordinal: 1, phase: "prepared" };
  const reserved = await compareAndSwapValidated(
    transaction,
    current.revision,
    draftFrom(current, { state: judging, pendingProviderIntent: true }),
    pendingRequest(identity, judgeEffect),
    "current",
  );
  const intent = requireCommitted(reserved, "reserving JUDGE intent");
  if (!intent.state.plan) throw new Error("Cannot judge a run without an approved plan");
  const judgeTracker = providerAttemptTracker(transaction, intent, identity, judgeEffect);
  const providerResult = await callJudgeProvider(options.provider, {
    task: intent.state.task,
    plan: intent.state.plan,
    diff: event.diff,
    ...(event.testOutput === undefined ? {} : { testOutput: event.testOutput }),
    coderIdentity: intent.coderIdentity,
    ...(intent.taskFeatures === undefined ? {} : { taskFeatures: structuredClone(intent.taskFeatures) }),
    iteration: intent.state.coderIterations,
    consecutiveRejections: intent.state.consecutiveRejections,
    ...(signal === undefined ? {} : { signal }),
    beforeAttempt: judgeTracker.beforeAttempt,
    afterAttempt: judgeTracker.afterAttempt,
  });
  if (!providerResult.ok) return settleProviderFailure(transaction, judgeTracker.current(), identity, "advanced");
  if (!judgeTracker.canCommitReturnedResult()) {
    return settleProviderFailure(transaction, judgeTracker.current(), identity, "advanced");
  }
  const verdict = providerResult.value;
  const judgeCheckpoint = judgeTracker.current();
  if (!checkerEvidenceIsValid(judgeCheckpoint, verdict.routing)) {
    return settleProviderFailure(transaction, judgeCheckpoint, identity, "advanced");
  }
  await options.afterProviderResult?.({ runId: current.runId, effect: judgeEffect });

  const verdictEvent = verdict.verdict === "reject"
    ? { type: "verdict" as const, verdict: "reject" as const, reasons: verdict.reasons, requiredFixes: verdict.requiredFixes }
    : { type: "verdict" as const, verdict: "approve" as const, reasons: verdict.reasons };
  const judged = nextPhase(judgeCheckpoint.state, verdictEvent, loop);
  const lastVerdict: RunVerdict = verdict.verdict === "reject"
    ? { verdict: "reject", reasons: verdict.reasons, requiredFixes: verdict.requiredFixes }
    : { verdict: "approve", reasons: verdict.reasons };
  const afterJudge = draftFrom(judgeCheckpoint, {
    state: judged,
    status: statusFor(judged),
    routing: [...judgeCheckpoint.routing, verdict.routing],
    lastVerdict,
    terminalMessage: judged.phase === "failed" ? "Maximum coder iterations reached; the run failed closed." : undefined,
  });

  if (judged.phase !== "replanning") {
    const committed = await compareAndSwapValidated(
      transaction,
      judgeCheckpoint.revision,
      { ...afterJudge, pendingProviderIntent: false },
      settledRequest(identity, "advanced"),
      "advanced",
    );
    return responseFor(requireCommitted(committed, "settling JUDGE result"), "advanced");
  }

  if (afterJudge.routing.length >= MCP_RUN_ROUTING_MAX) {
    return settleRoutingLimitAfterJudge(transaction, judgeCheckpoint.revision, afterJudge, identity);
  }

  const planEffect: ProviderEffect = { kind: "plan", ordinal: 2, phase: "prepared" };
  const replanIntent = await compareAndSwapValidated(
    transaction,
    judgeCheckpoint.revision,
    { ...afterJudge, pendingProviderIntent: true },
    pendingRequest(identity, planEffect),
    "current",
  );
  const replanning = requireCommitted(replanIntent, "reserving re-PLAN intent");
  const planTracker = providerAttemptTracker(transaction, replanning, identity, planEffect);
  const planResult = await callPlanProvider(options.provider, planRequest(replanning, planTracker, {
    previousPlan: current.state.plan,
    judgeReports: judged.judgeReports,
    diff: event.diff,
    signal,
  }));
  if (!planResult.ok) return settleProviderFailure(transaction, planTracker.current(), identity, "advanced");
  if (!planTracker.canCommitReturnedResult()) {
    return settleProviderFailure(transaction, planTracker.current(), identity, "advanced");
  }
  const completion = planResult.value;
  await options.afterProviderResult?.({ runId: current.runId, effect: planEffect });
  const planCheckpoint = planTracker.current();
  const withPlan = nextPhase(planCheckpoint.state, { type: "plan_produced", plan: completion.plan }, loop);
  const committed = await compareAndSwapValidated(
    transaction,
    planCheckpoint.revision,
    draftFrom(planCheckpoint, {
      state: withPlan,
      status: "active",
      planVersion: current.planVersion + 1,
      routing: [...planCheckpoint.routing, completion.routing],
      pendingProviderIntent: false,
    }),
    settledRequest(identity, "advanced"),
    "advanced",
  );
  return responseFor(requireCommitted(committed, "settling re-PLAN result"), "advanced");
}

async function cancelRun(
  transaction: McpRunTransaction,
  current: McpRunRecord,
  reason: string | undefined,
  identity: RequestIdentity,
): Promise<McpRunResponse> {
  const cancelledCheckpoint = structuredClone(current.state);
  const state = nextPhase(current.state, { type: "cancelled" }, current.loop);
  const committed = await compareAndSwapValidated(
    transaction,
    current.revision,
    draftFrom(current, {
      state,
      status: "cancelled",
      cancelledCheckpoint,
      terminalMessage: reason?.trim() || "Run cancelled by the client.",
      pendingProviderIntent: false,
    }),
    settledRequest(identity, "cancelled"),
    "cancelled",
  );
  return responseFor(requireCommitted(committed, "cancelling run"), "cancelled");
}

type ProviderCallResult<T> = { ok: true; value: T } | { ok: false };

async function callPlanProvider(
  provider: McpRunProvider,
  request: McpRunPlanRequest,
): Promise<ProviderCallResult<z.infer<typeof planProviderResultSchema>>> {
  try {
    return { ok: true, value: planProviderResultSchema.parse(await provider.plan(request)) };
  } catch (error) {
    if (error instanceof ProviderCheckpointError) throw error;
    return { ok: false };
  }
}

async function callJudgeProvider(
  provider: McpRunProvider,
  request: McpRunJudgeRequest,
): Promise<ProviderCallResult<z.infer<typeof judgeProviderResultSchema>>> {
  try {
    return { ok: true, value: judgeProviderResultSchema.parse(await provider.judge(request)) };
  } catch (error) {
    if (error instanceof ProviderCheckpointError) throw error;
    return { ok: false };
  }
}

async function settleProviderFailure(
  transaction: Pick<McpRunTransaction, "compareAndSwap">,
  intent: McpRunRecord,
  identity: RequestIdentity,
  outcome: RunOutcome,
): Promise<McpRunResponse> {
  const state = nextPhase(intent.state, { type: "provider_failed" }, intent.loop);
  const committed = await compareAndSwapValidated(
    transaction,
    intent.revision,
    draftFrom(intent, {
      state,
      status: "failed",
      terminalMessage: "Provider failed before producing an accepted result; the run failed closed.",
      pendingProviderIntent: false,
    }),
    settledRequest(identity, outcome),
    outcome,
  );
  return responseFor(requireCommitted(committed, "settling provider failure"), outcome);
}

async function settleRoutingLimitAfterJudge(
  transaction: Pick<McpRunTransaction, "compareAndSwap">,
  expectedRevision: number,
  afterJudge: McpRunRecordDraft,
  identity: RequestIdentity,
): Promise<McpRunResponse> {
  const state = nextPhase(afterJudge.state, { type: "provider_failed" }, afterJudge.loop);
  const committed = await compareAndSwapValidated(
    transaction,
    expectedRevision,
    {
      ...afterJudge,
      state,
      status: "failed",
      terminalMessage: "Routing decision limit exhausted before re-plan; the run failed closed.",
      pendingProviderIntent: false,
    },
    settledRequest(identity, "advanced"),
    "advanced",
  );
  return responseFor(requireCommitted(committed, "settling routing-limit failure"), "advanced");
}

function checkerEvidenceIsValid(record: McpRunRecord, routing: RunRoutingDecision): boolean {
  const checkerIdentity = `${routing.selectedIdentity.provider}/${routing.selectedIdentity.model}`;
  if (checkerIdentity === record.coderIdentity) return false;
  if (!record.requireDifferentCheckerFamily) return true;
  return record.coderFamily !== undefined
    && routing.selectedIdentity.family !== undefined
    && record.coderFamily !== routing.selectedIdentity.family;
}

function assertRoutingCapacity(record: Pick<McpRunRecord, "routing">): void {
  if (record.routing.length >= MCP_RUN_ROUTING_MAX) {
    throw new Error(`Routing decision limit of ${MCP_RUN_ROUTING_MAX} has been reached`);
  }
}

function planRequest(
  record: McpRunRecord,
  tracker: ProviderAttemptTracker,
  extra: Pick<McpRunPlanRequest, "previousPlan" | "userFeedback" | "judgeReports" | "diff" | "signal"> = {},
): McpRunPlanRequest {
  return {
    task: record.state.task,
    ...(record.repoContext === undefined ? {} : { repoContext: record.repoContext }),
    ...(record.taskFeatures === undefined ? {} : { taskFeatures: structuredClone(record.taskFeatures) }),
    ...(extra.previousPlan === undefined ? {} : { previousPlan: extra.previousPlan }),
    ...(extra.userFeedback === undefined ? {} : { userFeedback: extra.userFeedback }),
    ...(extra.judgeReports === undefined ? {} : { judgeReports: structuredClone(extra.judgeReports) }),
    ...(extra.diff === undefined ? {} : { diff: extra.diff }),
    ...(extra.signal === undefined ? {} : { signal: extra.signal }),
    beforeAttempt: tracker.beforeAttempt,
    afterAttempt: tracker.afterAttempt,
  };
}

interface ProviderAttemptTracker {
  beforeAttempt: (attempt: RoutedCompletionAttempt) => Promise<void>;
  afterAttempt: (result: RoutedCompletionAttemptResult) => Promise<void>;
  current: () => McpRunRecord;
  canCommitReturnedResult: () => boolean;
}

function providerAttemptTracker(
  transaction: Pick<McpRunTransaction, "compareAndSwap">,
  initial: McpRunRecord,
  identity: RequestIdentity,
  effect: ProviderEffectBase,
): ProviderAttemptTracker {
  let checkpoint = initial;
  let activeAttempt: RoutedCompletionAttempt | undefined;
  let lastOutcome: RoutedCompletionAttemptResult["outcome"] | undefined;
  let checkpointFailure: ProviderCheckpointError | undefined;
  let nextAttempt = 1;

  return {
    beforeAttempt: async (unparsed) => {
      const attempt = providerAttemptSchema.parse(unparsed);
      if (activeAttempt) throw new Error("A provider attempt is already active");
      if (attempt.attempt !== nextAttempt) throw new Error(`Provider attempt must be numbered ${nextAttempt}`);
      if (checkpoint.providerAttempts >= checkpoint.maxProviderCalls) {
        throw new Error("Provider call limit exhausted");
      }
      const attempting: ProviderEffect = { ...effect, phase: "attempting", attempt };
      try {
        const committed = await compareAndSwapValidated(
          transaction,
          checkpoint.revision,
          draftFrom(checkpoint, { providerAttempts: checkpoint.providerAttempts + 1 }),
          pendingRequest(identity, attempting),
          "current",
        );
        checkpoint = requireCommitted(committed, "reserving provider attempt");
      } catch {
        checkpointFailure = new ProviderCheckpointError();
        throw checkpointFailure;
      }
      activeAttempt = attempt;
      lastOutcome = undefined;
    },
    afterAttempt: async (unparsed) => {
      let result: RoutedCompletionAttemptResult;
      try {
        result = providerAttemptResultSchema.parse(unparsed);
        if (!activeAttempt || !sameAttempt(activeAttempt, result)) {
          throw new Error("Provider attempt result does not match its durable reservation");
        }
        // A successful network return is not durable success until the output
        // itself is committed with the run transition. Before that boundary,
        // restart recovery must remain blocked and must never infer a result.
        const attempted: ProviderEffect = result.outcome === "failed"
          ? { ...effect, phase: "attempted", result }
          : {
              ...effect,
              phase: "awaiting_output_commit",
              attempt: attemptWithoutOutcome(result),
            };
        const committed = await compareAndSwapValidated(
          transaction,
          checkpoint.revision,
          draftFrom(checkpoint, {}),
          pendingRequest(identity, attempted),
          "current",
        );
        checkpoint = requireCommitted(committed, "settling provider attempt evidence");
      } catch {
        checkpointFailure = new ProviderCheckpointError();
        throw checkpointFailure;
      }
      activeAttempt = undefined;
      lastOutcome = result.outcome;
      nextAttempt += 1;
    },
    current: () => checkpoint,
    canCommitReturnedResult: () => {
      if (checkpointFailure) throw checkpointFailure;
      return activeAttempt === undefined && lastOutcome === "succeeded";
    },
  };
}

function sameAttempt(left: RoutedCompletionAttempt, right: RoutedCompletionAttempt): boolean {
  return left.attempt === right.attempt
    && left.identity.provider === right.identity.provider
    && left.identity.model === right.identity.model
    && left.identity.family === right.identity.family
    && left.thinking === right.thinking
    && left.requestedOutputTokens === right.requestedOutputTokens
    && left.estimatedCostUsd === right.estimatedCostUsd;
}

function attemptWithoutOutcome(result: Extract<RoutedCompletionAttemptResult, { outcome: "succeeded" }>): RoutedCompletionAttempt {
  const { outcome: _outcome, ...attempt } = result;
  return attempt;
}

function responseFor(record: McpRunRecord, outcome: RunOutcome): McpRunResponse {
  const loop = record.loop;
  const blocked = record.pendingProviderIntent;
  const visibleState = record.status === "cancelled" && record.cancelledCheckpoint
    ? record.cancelledCheckpoint
    : record.state;
  const status: RunStatus = blocked ? "blocked" : record.status;
  const requiredAction: McpRunResponse["requiredAction"] = blocked
    ? "inspect_run"
    : record.status !== "active"
      ? "none"
      : visibleState.phase === "awaiting_approval"
        ? "approve_or_revise_plan"
        : visibleState.phase === "coding"
          ? "implement_and_submit_code"
          : "none";
  const permittedEvents: McpRunResponse["permittedEvents"] = blocked
    ? []
    : record.status !== "active"
      ? []
      : visibleState.phase === "awaiting_approval"
        ? ["plan_approved", "plan_revision_requested", "cancelled"]
        : visibleState.phase === "coding"
          ? ["code_result_submitted", "cancelled"]
          : [];
  const response: McpRunResponse = {
    outcome: blocked ? "current" : outcome,
    runId: record.runId,
    revision: record.revision,
    status,
    currentNode: visibleState.phase,
    requiredAction,
    permittedEvents,
    ...(blocked || visibleState.plan === undefined ? {} : { plan: visibleState.plan }),
    ...(blocked || record.lastVerdict === undefined ? {} : { lastVerdict: structuredClone(record.lastVerdict) }),
    routing: structuredClone(record.routing),
    progress: {
      coderIterations: visibleState.coderIterations,
      consecutiveRejections: visibleState.consecutiveRejections,
      planVersion: record.planVersion,
    },
    limits: {
      coderIterations: loop.maxCoderIterations,
      consecutiveRejections: loop.plannerEscalationAfterRejections,
      providerCalls: record.maxProviderCalls,
    },
    remaining: {
      coderIterations: Math.max(0, loop.maxCoderIterations - visibleState.coderIterations),
      consecutiveRejections: Math.max(0, loop.plannerEscalationAfterRejections - visibleState.consecutiveRejections),
      providerCalls: Math.max(0, record.maxProviderCalls - record.providerAttempts),
    },
    ...(blocked
      ? { message: "A provider returned but its durable outcome is uncertain; this run requires recovery before it can advance." }
      : record.terminalMessage === undefined
        ? {}
        : { message: record.terminalMessage }),
  };
  return mcpRunResponseSchema.parse(response);
}

function conflictResponse(record: McpRunRecord, expectedRevision: number): McpRunResponse {
  const response = responseFor(record, "conflict");
  const {
    plan: _plan,
    lastVerdict: _lastVerdict,
    message: _message,
    routing: _routing,
    permittedEvents: _permittedEvents,
    ...safeStatus
  } = response;
  return mcpRunResponseSchema.parse({
    ...safeStatus,
    outcome: "conflict",
    requiredAction: "inspect_run",
    permittedEvents: [],
    routing: [],
    conflict: { expectedRevision, currentRevision: record.revision },
  });
}

async function replayRequest(
  request: McpRunRequestRecord,
  requestHash: string,
  repository: McpRunRepository,
): Promise<McpRunResponse> {
  if (request.requestHash !== requestHash) {
    throw new Error("requestId was already used with a different canonical request body");
  }
  if (request.state === "settled") {
    const checkpoint = await repository.getCheckpoint(request.checkpoint);
    if (!checkpoint) {
      throw new Error(`Settled MCP request checkpoint ${request.checkpoint.runId}@${request.checkpoint.revision} was not found`);
    }
    return responseFor(checkpoint, request.outcome);
  }
  const record = await requireRun(repository, request.runId);
  return responseFor(record, "current");
}

function draftFrom(record: McpRunRecord, changes: Partial<McpRunRecordDraft>): McpRunRecordDraft {
  const { revision: _revision, ...draft } = structuredClone(record);
  return { ...draft, ...changes };
}

async function compareAndSwapValidated(
  transaction: Pick<McpRunTransaction, "compareAndSwap">,
  expectedRevision: number,
  draft: McpRunRecordDraft,
  request: McpRunRequestUpdate,
  outcome: RunOutcome,
): Promise<McpRunRecord | undefined> {
  assertProspectiveResponse(draft, expectedRevision, outcome);
  return transaction.compareAndSwap(expectedRevision, draft, request);
}

function assertProspectiveResponse(draft: McpRunRecordDraft, revision: number, outcome: RunOutcome): void {
  responseFor({ ...structuredClone(draft), revision }, outcome);
}

function pendingRequest(identity: RequestIdentity, effect: ProviderEffect): Extract<McpRunRequestUpdate, { state: "pending" }> {
  return { state: "pending", ...identity, effect };
}

function settledRequest(identity: RequestIdentity, outcome: RunOutcome): Extract<McpRunRequestUpdate, { state: "settled" }> {
  return { state: "settled", ...identity, outcome };
}

function requestIdentity(operation: "start" | "advance" | "cancel", requestId: string, input: unknown): RequestIdentity {
  return {
    requestRef: sha256(requestId),
    requestHash: sha256(stableJson({ operation, input })),
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function defaultRunId(): string {
  return `mrun_${randomBytes(24).toString("base64url")}`;
}

function statusFor(state: OrchestratorState): Exclude<RunStatus, "blocked" | "cancelled"> {
  if (state.phase === "done") return "done";
  if (state.phase === "failed") return "failed";
  return "active";
}

function assertMutable(record: McpRunRecord): void {
  if (record.status !== "active") throw new Error(`Run ${record.runId} is terminal and immutable`);
}

function assertPhase(record: McpRunRecord, expected: OrchestratorState["phase"], event: McpRunClientEvent["type"]): void {
  if (record.state.phase !== expected) {
    throw new Error(`Event ${event} is not permitted while run ${record.runId} is ${record.state.phase}`);
  }
}

async function requireRun(repository: McpRunRepository, runId: string): Promise<McpRunRecord> {
  const record = await repository.get(runId);
  if (!record) throw new Error(`MCP run ${runId} was not found`);
  return record;
}

async function requireTransactionRun(transaction: McpRunTransaction, runId: string): Promise<McpRunRecord> {
  const record = await transaction.get();
  if (!record) throw new Error(`MCP run ${runId} was not found`);
  return record;
}

function requireCommitted(record: McpRunRecord | undefined, action: string): McpRunRecord {
  if (!record) throw new Error(`Run revision changed while ${action}; provider outcome is uncertain`);
  return record;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported MCP run event: ${JSON.stringify(value)}`);
}
