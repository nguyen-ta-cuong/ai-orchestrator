import { createHash, randomBytes } from "node:crypto";
import { z } from "zod/v3";
import {
  createIdleState,
  nextPhase,
  type JudgeReport,
  type LoopConfig,
  type OrchestratorState,
} from "../src/core/loop.js";
import { compileGraph, type CompiledGraph, type GraphDefinition } from "../src/core/graph.js";
import {
  applyRecoveryDecisionToLedger,
  createRecoveryLedger,
  fingerprintFailure,
  registerRecovery,
  validateRecoveryLedger,
  type FailureEvidence,
  type RecoveryLedger,
} from "../src/core/recovery.js";
import {
  createSchedulerRecoveryBinding,
  schedulerFailureEvidence,
  validateSchedulerRecoveryBinding,
  type SchedulerRecoveryBinding,
} from "../src/core/schedulerRecovery.js";
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
  mcpRunRecoverInputSchema,
  mcpRunRejectVerdictSchema,
  mcpRunResponseSchema,
  mcpRunRoutingDecisionSchema,
  mcpRunStartInputSchema,
  mcpTaskFeaturesSchema,
  type McpRunAdapter,
  type McpRunClientEvent,
  type McpRunResponse,
  type McpRunStartInput,
} from "./runProtocol.js";
import type { RoutedCompletionAttempt, RoutedCompletionAttemptResult } from "./llm.js";
import {
  MCP_PROVIDER_DEFINITE_FAILURE_CODES,
  MCP_PROVIDER_UNCERTAIN_FAILURE_CODES,
} from "./failureCodes.js";
import type { ArtifactReference, GraphExecutionState } from "../src/core/scheduler.js";
import {
  validateRecoveryArtifactBinding,
  type RecoveryArtifactBinding,
} from "../src/runtime/recoveryArtifacts.js";

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

const routedDecisionSchema = z.object({
  decisionId: z.string().regex(/^[A-Za-z0-9._:@/-]{1,128}$/),
  policyVersion: z.string().trim().min(1).max(256),
  policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  configDigest: z.string().regex(/^[a-f0-9]{64}$/),
  candidatesDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const providerAttemptSchema = z.object({
  attempt: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  providerRequestRef: z.string().regex(/^[a-f0-9]{64}$/),
  routingDecision: routedDecisionSchema,
  identity: z.object({
    provider: z.string().trim().min(1).max(200),
    model: z.string().trim().min(1).max(500),
    family: z.string().trim().min(1).max(500).optional(),
  }).strict(),
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  requestedOutputTokens: z.number().int().min(1).max(1_000_000).optional(),
  estimatedCostUsd: z.number().finite().min(0).optional(),
}).strict();

const providerSucceededAttemptResultSchema = providerAttemptSchema.extend({ outcome: z.literal("succeeded") }).strict();
const providerFailedAttemptResultSchema = providerAttemptSchema.extend({
  outcome: z.literal("failed"),
  failureCode: z.enum(MCP_PROVIDER_DEFINITE_FAILURE_CODES),
}).strict();
const providerUnknownAttemptResultSchema = providerAttemptSchema.extend({
  outcome: z.literal("unknown"),
  failureCode: z.enum(MCP_PROVIDER_UNCERTAIN_FAILURE_CODES),
}).strict();
const providerNonSuccessAttemptResultSchema = z.discriminatedUnion("outcome", [
  providerFailedAttemptResultSchema,
  providerUnknownAttemptResultSchema,
]);
const providerAttemptResultSchema = z.discriminatedUnion("outcome", [
  providerSucceededAttemptResultSchema,
  providerFailedAttemptResultSchema,
  providerUnknownAttemptResultSchema,
]);

const providerAttemptReservationSchema = providerAttemptSchema.extend({
  providerAttemptIdempotencyKey: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const artifactReferenceSchema = z.object({
  planVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  nodeId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/),
  contract: z.string().min(1).max(128).refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
  path: z.string().min(1).max(4_096),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();

export type ProviderAttemptReservation = z.infer<typeof providerAttemptReservationSchema>;

class ProviderCheckpointError extends Error {
  constructor() {
    super("Provider outcome checkpoint failed; the result is uncertain and requires recovery");
    this.name = "ProviderCheckpointError";
  }
}

export interface ProviderEffectBase {
  effectId: string;
  kind: "plan" | "judge";
  ordinal: number;
}

const providerAttemptEvidenceSchema = z.discriminatedUnion("phase", [
  providerAttemptReservationSchema.extend({
    phase: z.literal("failed"),
    effectId: z.string().regex(/^[a-f0-9]{64}$/),
    kind: z.enum(["plan", "judge"]),
    ordinal: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    failureCode: z.enum(MCP_PROVIDER_DEFINITE_FAILURE_CODES),
  }).strict(),
  providerAttemptReservationSchema.extend({
    phase: z.literal("unknown"),
    effectId: z.string().regex(/^[a-f0-9]{64}$/),
    kind: z.enum(["plan", "judge"]),
    ordinal: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    failureCode: z.enum(MCP_PROVIDER_UNCERTAIN_FAILURE_CODES),
  }).strict(),
  providerAttemptReservationSchema.extend({
    phase: z.enum(["awaiting_output_commit", "discarded"]),
    effectId: z.string().regex(/^[a-f0-9]{64}$/),
    kind: z.enum(["plan", "judge"]),
    ordinal: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  }).strict(),
  providerAttemptReservationSchema.extend({
    phase: z.literal("output_committed"),
    effectId: z.string().regex(/^[a-f0-9]{64}$/),
    kind: z.enum(["plan", "judge"]),
    ordinal: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    resultRef: artifactReferenceSchema,
  }).strict(),
]);

export type ProviderAttemptEvidence = z.infer<typeof providerAttemptEvidenceSchema>;

export type ProviderEffect = ProviderEffectBase & (
  | { phase: "prepared" }
  | { phase: "attempting"; attempt: ProviderAttemptReservation }
  | { phase: "attempted"; result: Exclude<RoutedCompletionAttemptResult, { outcome: "succeeded" }> }
  | { phase: "awaiting_output_commit"; attempt: ProviderAttemptReservation }
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
  providerEffects: ProviderEffectBase[];
  providerEvidence: ProviderAttemptEvidence[];
  nextProviderEffectOrdinal: number;
  maxProviderCalls: number;
  requestAuthority: McpRunRequestAuthority;
  cancelledCheckpoint?: OrchestratorState;
  abandonedProviderAttempt?: ProviderEffectBase & { attempt: ProviderAttemptReservation };
  recovery?: McpRunRecoveryEnvelope;
}

export interface McpRunRecoveryEnvelope {
  version: 1;
  binding: Readonly<SchedulerRecoveryBinding>;
  ledger: Readonly<RecoveryLedger>;
  artifacts: readonly Readonly<RecoveryArtifactBinding>[];
}

export interface McpRunRecoveryContext {
  graphDefinition: GraphDefinition;
  schedulerState: GraphExecutionState;
}

export type McpRunRecordDraft = Omit<McpRunRecord, "revision">;

interface McpRunRequestBase {
  requestRef: string;
  requestHash: string;
  mutationEffect: McpRunMutationEffect;
  providerEffectIds: string[];
}

export type McpRunMutationEffect =
  | { operation: "start" }
  | { operation: "advance"; event: McpRunClientEvent["type"] }
  | { operation: "cancel" }
  | { operation: "recover" };

export type McpRunRequestUpdate =
  | (McpRunRequestBase & { state: "pending"; effect: ProviderEffect })
  | (McpRunRequestBase & { state: "settled"; outcome: RunOutcome });

export type McpRunRequestRecord =
  | (Extract<McpRunRequestUpdate, { state: "pending" }> & {
    runId: string;
    reservedRevision: number;
    authorityDigest: string;
    eventDigest: string;
  })
  | (Extract<McpRunRequestUpdate, { state: "settled" }> & {
    runId: string;
    checkpoint: McpRunCheckpointReference;
    authorityDigest: string;
    eventDigest: string;
  });

export type McpRunRequestAuthority =
  | Pick<Extract<McpRunRequestUpdate, { state: "pending" }>, "state" | "requestRef" | "requestHash" | "mutationEffect" | "providerEffectIds" | "effect">
  | Pick<Extract<McpRunRequestUpdate, { state: "settled" }>, "state" | "requestRef" | "requestHash" | "mutationEffect" | "providerEffectIds" | "outcome">;

export interface McpRunCheckpointReference {
  runId: string;
  revision: number;
}

export interface McpRunPublication {
  record: McpRunRecord;
  request: McpRunRequestRecord;
}

export interface McpRunProviderOutput {
  runId: string;
  effect: ProviderEffectBase;
  attempt: ProviderAttemptReservation;
  contract: "mcp-plan-output-v1" | "mcp-judge-output-v1";
  bytes: Uint8Array;
}

/**
 * Must be called synchronously while the repository's exclusive lease is held,
 * after revision/request assignment and immediately before any bytes become
 * visible as authority. A thrown validation error must publish nothing.
 */
export type McpRunPublicationGuard = (publication: McpRunPublication) => void;

export interface McpRunStartTransaction {
  getRequest(): Promise<McpRunRequestRecord | undefined>;
  /** Atomically create the run, reserve the provider intent, and assign a revision. */
  reserve(
    draft: McpRunRecordDraft,
    request: Extract<McpRunRequestUpdate, { state: "pending" }>,
    beforePublication: McpRunPublicationGuard,
  ): Promise<McpRunRecord>;
  /** Atomically CAS the run, update the request record, and assign a revision. */
  compareAndSwap(
    expectedRevision: number,
    draft: McpRunRecordDraft,
    request: McpRunRequestUpdate,
    beforePublication: McpRunPublicationGuard,
  ): Promise<McpRunRecord | undefined>;
  /** Write immutable provider-result bytes while this lease generation is held. */
  writeProviderOutput(input: McpRunProviderOutput): Promise<ArtifactReference>;
}

export interface McpRunTransaction {
  get(): Promise<McpRunRecord | undefined>;
  getRequest(requestRef: string): Promise<McpRunRequestRecord | undefined>;
  /** Atomically CAS the run, update the request record, and assign a revision. */
  compareAndSwap(
    expectedRevision: number,
    draft: McpRunRecordDraft,
    request: McpRunRequestUpdate,
    beforePublication: McpRunPublicationGuard,
  ): Promise<McpRunRecord | undefined>;
  /** Write immutable provider-result bytes while this lease generation is held. */
  writeProviderOutput(input: McpRunProviderOutput): Promise<ArtifactReference>;
  /** Trusted scheduler state and graph bytes used to anchor the first recovery ledger. */
  getRecoveryContext?(): Promise<McpRunRecoveryContext>;
  /** Write one immutable content-addressed artifact while this lease generation is held. */
  writeRecoveryArtifact?(input: {
    runId: string;
    semanticRef: string;
    bytes: Uint8Array;
  }): Promise<RecoveryArtifactBinding>;
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
  /**
   * Revision 1 is the immutable creation checkpoint for a run. Durable
   * adapters must authenticate it through their append-only event/WAL chain;
   * the service uses it as the external anchor for frozen policy and identity.
   * This read must remain safe while a run lease is held.
   */
  getCheckpoint(reference: McpRunCheckpointReference): Promise<McpRunRecord | undefined>;
}

const loopConfigSchema = z.object({
  maxCoderIterations: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  plannerEscalationAfterRejections: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  requirePlanApproval: z.boolean(),
}).strict();

const stateSchema = z.object({
  phase: z.enum(["idle", "planning", "awaiting_approval", "coding", "judging", "replanning", "done", "failed"]),
  task: z.string().max(2_000_000),
  plan: z.string().max(2_000_000).optional(),
  coderIterations: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  consecutiveRejections: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  judgeReports: z.array(z.object({
    verdict: z.enum(["approve", "reject"]),
    reasons: z.string().max(50_000),
    requiredFixes: z.string().max(50_000).optional(),
  }).strict()).max(Number.MAX_SAFE_INTEGER),
  yolo: z.boolean(),
  originalModel: z.object({
    provider: z.string(),
    id: z.string(),
    thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  }).strict().optional(),
}).strict();

const runVerdictSchema = z.discriminatedUnion("verdict", [
  mcpRunApproveVerdictSchema,
  mcpRunRejectVerdictSchema,
]);

const providerEffectSchema = z.discriminatedUnion("phase", [
  z.object({ effectId: z.string().regex(/^[a-f0-9]{64}$/), kind: z.enum(["plan", "judge"]), ordinal: z.number().int().min(1), phase: z.literal("prepared") }).strict(),
  z.object({ effectId: z.string().regex(/^[a-f0-9]{64}$/), kind: z.enum(["plan", "judge"]), ordinal: z.number().int().min(1), phase: z.literal("attempting"), attempt: providerAttemptReservationSchema }).strict(),
  z.object({ effectId: z.string().regex(/^[a-f0-9]{64}$/), kind: z.enum(["plan", "judge"]), ordinal: z.number().int().min(1), phase: z.literal("attempted"), result: providerNonSuccessAttemptResultSchema }).strict(),
  z.object({ effectId: z.string().regex(/^[a-f0-9]{64}$/), kind: z.enum(["plan", "judge"]), ordinal: z.number().int().min(1), phase: z.literal("awaiting_output_commit"), attempt: providerAttemptReservationSchema }).strict(),
]);

const mutationEffectSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("start") }).strict(),
  z.object({
    operation: z.literal("advance"),
    event: z.enum(["plan_approved", "plan_revision_requested", "code_result_submitted", "cancelled"]),
  }).strict(),
  z.object({ operation: z.literal("cancel") }).strict(),
  z.object({ operation: z.literal("recover") }).strict(),
]);

const requestBaseSchema = {
  requestRef: z.string().regex(/^[a-f0-9]{64}$/),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  mutationEffect: mutationEffectSchema,
  providerEffectIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(MCP_RUN_ROUTING_MAX),
};

const requestAuthoritySchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("pending"),
    ...requestBaseSchema,
    effect: providerEffectSchema,
  }).strict(),
  z.object({
    state: z.literal("settled"),
    ...requestBaseSchema,
    outcome: z.enum(["started", "current", "advanced", "cancelled", "conflict"]),
  }).strict(),
]);

const runRecordSchema = z.object({
  runId: mcpRunIdSchema,
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  status: z.enum(["active", "done", "failed", "cancelled"]),
  state: stateSchema,
  repoContext: z.string().max(2_000_000).optional(),
  coderIdentity: z.string().trim().regex(/^[^/\s]+\/\S+$/).max(500),
  coderFamily: z.string().trim().min(1).max(500).optional(),
  requireDifferentCheckerFamily: z.boolean(),
  taskFeatures: mcpTaskFeaturesSchema.optional(),
  loop: loopConfigSchema,
  planVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  routing: z.array(mcpRunRoutingDecisionSchema).max(MCP_RUN_ROUTING_MAX),
  lastVerdict: runVerdictSchema.optional(),
  terminalMessage: z.string().max(50_000).optional(),
  pendingProviderIntent: z.boolean(),
  providerAttempts: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  providerEffects: z.array(z.object({
    effectId: z.string().regex(/^[a-f0-9]{64}$/),
    kind: z.enum(["plan", "judge"]),
    ordinal: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  }).strict()).max(MCP_RUN_ROUTING_MAX),
  providerEvidence: z.array(providerAttemptEvidenceSchema).max(MCP_RUN_ROUTING_MAX),
  nextProviderEffectOrdinal: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  maxProviderCalls: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  requestAuthority: requestAuthoritySchema,
  cancelledCheckpoint: stateSchema.optional(),
  abandonedProviderAttempt: z.object({
    effectId: z.string().regex(/^[a-f0-9]{64}$/),
    kind: z.enum(["plan", "judge"]),
    ordinal: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    attempt: providerAttemptReservationSchema,
  }).strict().optional(),
  recovery: z.unknown().optional(),
}).strict();

const requestRecordSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("pending"),
    ...requestBaseSchema,
    effect: providerEffectSchema,
    runId: mcpRunIdSchema,
    reservedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    authorityDigest: z.string().regex(/^[a-f0-9]{64}$/),
    eventDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  z.object({
    state: z.literal("settled"),
    ...requestBaseSchema,
    outcome: z.enum(["started", "current", "advanced", "cancelled", "conflict"]),
    runId: mcpRunIdSchema,
    checkpoint: z.object({
      runId: mcpRunIdSchema,
      revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    }).strict(),
    authorityDigest: z.string().regex(/^[a-f0-9]{64}$/),
    eventDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
]);

const runPublicationSchema = z.object({
  record: runRecordSchema,
  request: requestRecordSchema,
}).strict();

/** Parse and authenticate one exact repository publication at a disk boundary. */
export function parseMcpRunPublicationAuthority(unparsed: unknown): McpRunPublication {
  const publication = parseCanonical(runPublicationSchema, unparsed, "run publication authority") as McpRunPublication;
  // Exercise all semantic and response bounds in addition to the structural schema.
  const record = recordForAuthority(publication.record, publication.record.runId, publication.record.revision);
  if (!record) throw new Error("Run publication authority is missing its record");
  assertRequestReceiptAuthority(publication.request, record);
  return { record, request: structuredClone(publication.request) };
}

export function validateMcpRunRecoveryEnvelope(value: unknown): McpRunRecoveryEnvelope {
  assertCanonicalJsonData(value, "MCP recovery envelope");
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("MCP recovery envelope must be a plain object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (stableJson(keys) !== stableJson(["artifacts", "binding", "ledger", "version"])) {
    throw new Error("MCP recovery envelope has unexpected or missing fields");
  }
  if (record.version !== 1) throw new Error("MCP recovery envelope version must be 1");
  const binding = validateSchedulerRecoveryBinding(record.binding);
  const ledger = validateRecoveryLedger(record.ledger, binding.authority);
  if (!Array.isArray(record.artifacts) || Object.keys(record.artifacts).length !== record.artifacts.length ||
      record.artifacts.length > 4_096) {
    throw new Error("MCP recovery artifacts must be a bounded dense array");
  }
  const artifacts = record.artifacts.map(validateRecoveryArtifactBinding);
  if (new Set(artifacts.map(({ semanticRef }) => semanticRef)).size !== artifacts.length) {
    throw new Error("MCP recovery artifact references must be unique");
  }
  return Object.freeze({
    version: 1,
    binding,
    ledger,
    artifacts: Object.freeze(artifacts),
  });
}

export interface CreateMcpRunServiceOptions {
  repository: McpRunRepository;
  provider: McpRunProvider;
  loop: LoopConfig;
  createRunId?: (requestRef: string) => string;
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
  if (!Number.isInteger(maxProviderCalls) || maxProviderCalls < 1 || maxProviderCalls > MCP_RUN_ROUTING_MAX) {
    throw new Error(`maxProviderCalls must be an integer between 1 and ${MCP_RUN_ROUTING_MAX}`);
  }

  return {
    start: async (unparsed, signal) => {
      const input = mcpRunStartInputSchema.parse(unparsed);
      const identity = requestIdentity("start", input.requestId, input);
      return options.repository.withStartLease(identity.requestRef, async (transaction) => {
        const previous = requestForLookup(await transaction.getRequest(), identity.requestRef);
        if (previous) return replayRequest(previous, identity.requestHash, options.repository);

        const preflight = preflightResultSchema.parse(options.provider.preflight({
          task: input.task,
          ...(input.repoContext === undefined ? {} : { repoContext: input.repoContext }),
          coderIdentity: input.coderIdentity,
          ...(input.taskFeatures === undefined ? {} : { taskFeatures: structuredClone(input.taskFeatures) }),
        }));
        if (preflight.requireDifferentCheckerFamily && preflight.coderFamily === undefined) {
          throw new Error("Coder family is required for checker family separation");
        }
        const runId = mcpRunIdSchema.parse(createRunId(identity.requestRef));
        const planning = nextPhase(createIdleState(), { type: "start", task: input.task, yolo: false }, loop);
        const effect: ProviderEffect = newProviderEffect(runId, "plan", 1);
        const request = pendingRequest(identity, effect);
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
          providerEffects: [providerEffectBase(effect)],
          providerEvidence: [],
          nextProviderEffectOrdinal: 2,
          maxProviderCalls,
          requestAuthority: requestAuthorityFor(request),
        };
        const reserved = await reserveValidated(
          transaction,
          initialDraft,
          request,
          "current",
        );

        const tracker = providerAttemptTracker(transaction, reserved, identity, effect, [effect.effectId]);
        const providerResult = await callPlanProvider(options.provider, planRequest(reserved, tracker, { signal }));
        if (!providerResult.ok) {
          return settleOrBlockProviderFailure(transaction, tracker, identity, "started");
        }
        if (!tracker.canCommitReturnedResult()) {
          return settleOrBlockProviderFailure(transaction, tracker, identity, "started");
        }
        const completion = providerResult.value;
        if (!tracker.routingMatches(completion.routing)) {
          return settleProviderFailure(transaction, tracker.current(), identity, "started");
        }
        await options.afterProviderResult?.({ runId, effect });
        const providerCheckpoint = tracker.current();
        const resultRef = await writeProviderOutput(
          transaction,
          providerCheckpoint,
          effect,
          "mcp-plan-output-v1",
          Buffer.from(completion.plan, "utf8"),
        );
        const withPlan = nextPhase(providerCheckpoint.state, { type: "plan_produced", plan: completion.plan }, providerCheckpoint.loop);
        const settled = await compareAndSwapValidated(
          transaction,
          providerCheckpoint.revision,
          draftFrom(providerCheckpoint, {
            state: withPlan,
            routing: [...providerCheckpoint.routing, completion.routing],
            providerEvidence: markProviderOutput(providerCheckpoint.providerEvidence, effect, "output_committed", resultRef),
            pendingProviderIntent: false,
          }),
          settledRequestFor(providerCheckpoint, identity, "started"),
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
        const replay = requestForLookup(await transaction.getRequest(identity.requestRef), identity.requestRef, input.runId);
        if (replay) return replayRequest(replay, identity.requestHash, options.repository);

        const current = await requireTransactionRun(transaction, options.repository, input.runId);
        if (current.revision !== input.expectedRevision) {
          return conflictResponse(current, input.expectedRevision);
        }
        if (current.pendingProviderIntent && input.event.type !== "cancelled") return responseFor(current, "current");
        if (current.recovery !== undefined && input.event.type !== "cancelled") return responseFor(current, "current");
        if (input.event.type === "cancelled") assertCancellable(current);
        else assertMutable(current);

        switch (input.event.type) {
          case "plan_approved":
            return approvePlan(transaction, current, identity);
          case "plan_revision_requested":
            return revisePlan(transaction, current, input.event.feedback, identity, options, signal);
          case "code_result_submitted":
            return submitCode(transaction, current, input.event, identity, options, signal);
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
        const replay = requestForLookup(await transaction.getRequest(identity.requestRef), identity.requestRef, input.runId);
        if (replay) return replayRequest(replay, identity.requestHash, options.repository);

        const current = await requireTransactionRun(transaction, options.repository, input.runId);
        if (current.revision !== input.expectedRevision) {
          return conflictResponse(current, input.expectedRevision);
        }
        assertCancellable(current);
        return cancelRun(transaction, current, input.reason, identity);
      });
    },

    recover: async (unparsed) => {
      const input = mcpRunRecoverInputSchema.parse(unparsed);
      const identity = requestIdentity("recover", input.requestId, input);
      return options.repository.withRunLease(input.runId, async (transaction) => {
        const replay = requestForLookup(await transaction.getRequest(identity.requestRef), identity.requestRef, input.runId);
        if (replay) return replayRequest(replay, identity.requestHash, options.repository);
        const current = await requireTransactionRun(transaction, options.repository, input.runId);
        if (current.revision !== input.expectedRevision) return conflictResponse(current, input.expectedRevision);
        if (current.pendingProviderIntent) {
          throw new Error("Recovery cannot replace an unresolved provider outcome; cancel or reconcile it first");
        }
        if (current.status === "done" || current.status === "cancelled") {
          throw new Error(`Recovery cannot mutate terminal run status ${current.status}`);
        }
        return classifyMcpRunRecovery(transaction, current, identity);
      });
    },
  };
}

interface RequestIdentity {
  requestRef: string;
  requestHash: string;
  mutationEffect: McpRunMutationEffect;
}

async function classifyMcpRunRecovery(
  transaction: McpRunTransaction,
  current: McpRunRecord,
  identity: RequestIdentity,
): Promise<McpRunResponse> {
  if (!current.state.plan) throw new Error("Recovery requires an authenticated approved-plan artifact");
  if (!transaction.getRecoveryContext || !transaction.writeRecoveryArtifact) {
    throw new Error("Stateful recovery is unavailable for this MCP repository");
  }
  const context = await transaction.getRecoveryContext();
  const graph = compileGraph(context.graphDefinition);
  const existingEnvelope = current.recovery === undefined
    ? undefined
    : validateMcpRunRecoveryEnvelope(current.recovery);
  const binding = existingEnvelope?.binding ?? createSchedulerRecoveryBinding(graph, context.schedulerState, {
    nodeId: context.graphDefinition.entry,
    activePlanVersion: current.planVersion,
    activePlanHash: currentPlanArtifactHash(current),
  });
  const failure = deriveMcpRunFailureEvidence(graph, binding, current);
  let envelope = existingEnvelope ?? await createInitialRecoveryEnvelope(transaction, current, context, binding);
  const fingerprint = fingerprintFailure(failure);
  if (envelope.ledger.records.some((record) =>
    record.kind === "registration" && record.state.fingerprint === fingerprint)) {
    throw new Error("The latest closed failure is already registered in this recovery ledger");
  }
  envelope = {
    ...envelope,
    ledger: registerRecovery(envelope.ledger, envelope.binding.authority, failure),
  };

  envelope = {
    ...envelope,
    ledger: applyRecoveryDecisionToLedger(
      envelope.ledger,
      envelope.binding.authority,
      fingerprint,
      undefined,
    ),
  };
  const committed = await compareAndSwapValidated(
    transaction,
    current.revision,
    draftFrom(current, { recovery: envelope }),
    settledRequest(identity, "advanced"),
    "advanced",
  );
  return responseFor(requireCommitted(committed, "persisting recovery decision"), "advanced");
}

async function createInitialRecoveryEnvelope(
  transaction: McpRunTransaction,
  current: McpRunRecord,
  context: McpRunRecoveryContext,
  binding: SchedulerRecoveryBinding,
): Promise<McpRunRecoveryEnvelope> {
  if (!transaction.getRecoveryContext || !transaction.writeRecoveryArtifact || !current.state.plan) {
    throw new Error("Stateful recovery repository context is unavailable");
  }
  const activePlanHash = currentPlanArtifactHash(current);
  const graphRef = `plan-versions/${current.planVersion}/graph.json`;
  const planRef = `plan-versions/${current.planVersion}/plan.md`;
  const graphArtifact = await transaction.writeRecoveryArtifact({
    runId: current.runId,
    semanticRef: graphRef,
    bytes: Buffer.from(stableJson(context.graphDefinition), "utf8"),
  });
  const planArtifact = await transaction.writeRecoveryArtifact({
    runId: current.runId,
    semanticRef: planRef,
    bytes: Buffer.from(current.state.plan, "utf8"),
  });
  if (graphArtifact.sha256 !== binding.authority.graphDigest || planArtifact.sha256 !== activePlanHash) {
    throw new Error("Recovery genesis artifacts do not match scheduler and approved-plan authority");
  }
  return validateMcpRunRecoveryEnvelope({
    version: 1,
    binding,
    ledger: createRecoveryLedger(binding.authority),
    artifacts: [graphArtifact, planArtifact],
  });
}

function currentPlanArtifactHash(record: McpRunRecord): string {
  const plans = record.providerEvidence.filter((evidence) =>
    evidence.kind === "plan" && evidence.phase === "output_committed");
  const current = plans.at(-1);
  if (!current || current.phase !== "output_committed") {
    throw new Error("Recovery requires an immutable committed PLAN output");
  }
  return current.resultRef.sha256;
}

/**
 * Derive the only recovery observation the MCP fast-path can currently prove.
 * The client never supplies category, contract, attempt, or lineage data.
 */
export function deriveMcpRunFailureEvidence(
  graph: CompiledGraph,
  binding: SchedulerRecoveryBinding,
  record: McpRunRecord,
): FailureEvidence {
  if (record.runId !== binding.authority.runId ||
      record.planVersion !== binding.authority.activePlanVersion ||
      currentPlanArtifactHash(record) !== binding.authority.activePlanHash) {
    throw new Error("Recovery failure evidence is not bound to the current approved plan");
  }

  const latestEvidence = record.providerEvidence.at(-1);
  if (record.status === "failed" && latestEvidence?.phase === "failed") {
    const outputContract = `mcp-${latestEvidence.kind}-output-v1:${latestEvidence.effectId}`;
    const observation = providerFailureObservation(latestEvidence.failureCode, outputContract);
    return schedulerFailureEvidence(graph, binding, record.providerAttempts, {
      ...observation,
      artifactHashes: [binding.authority.activePlanHash],
    });
  }

  const latestCommitted = [...record.providerEvidence].reverse()
    .find((evidence) => evidence.phase === "output_committed");
  const lastReport = record.state.judgeReports.at(-1);
  if (latestEvidence?.phase === "output_committed" && latestEvidence === latestCommitted &&
      latestEvidence.kind === "judge" && record.lastVerdict?.verdict === "reject" &&
      lastReport?.verdict === "reject" && record.state.coderIterations > 0) {
    return schedulerFailureEvidence(graph, binding, record.state.coderIterations, {
      category: "implementation-defect",
      contractViolation: "validator-rejected",
      contractId: `mcp-judge-output-v1:${latestEvidence.effectId}`,
      artifactHashes: [binding.authority.activePlanHash],
    });
  }

  throw new Error("Recovery requires a server-authenticated closed provider failure or checker rejection");
}

function providerFailureObservation(
  code: Extract<ProviderAttemptEvidence, { phase: "failed" }>["failureCode"],
  contractId: string,
): { category: FailureEvidence["category"]; contractViolation?: FailureEvidence["contractViolation"]; contractId?: string } {
  switch (code) {
    case "provider_unconfigured":
    case "missing_api_key":
    case "unsupported_api":
      return { category: "configuration" };
    case "invalid_json":
    case "schema_validation_failed":
    case "truncated":
    case "response_too_large":
      return { category: "output-contract", contractViolation: "invalid-output", contractId };
    case "empty_response":
      return { category: "output-contract", contractViolation: "missing-output", contractId };
    case "http_error":
    case "provider_response_failed":
      return { category: "transient-provider" };
    default:
      return assertNever(code);
  }
}

function recoveryResponseFor(envelopeValue: McpRunRecoveryEnvelope): NonNullable<McpRunResponse["recovery"]> {
  const envelope = validateMcpRunRecoveryEnvelope(envelopeValue);
  const tail = envelope.ledger.records.at(-1);
  if (!tail) throw new Error("Persisted MCP recovery envelope has no decision");
  const state = tail.state;
  let decision: Extract<RecoveryLedger["records"][number], { kind: "decision" }>["decision"] | undefined;
  for (let index = envelope.ledger.records.length - 1; index >= 0; index -= 1) {
    const candidate = envelope.ledger.records[index]!;
    if (candidate.kind === "decision" && candidate.fingerprint === state.fingerprint) {
      decision = candidate.decision;
      break;
    }
  }
  return {
    failureFingerprint: state.fingerprint,
    status: state.status,
    ...(decision === undefined ? {} : { action: decision.action, reason: decision.reason, targetPlanVersion: decision.targetPlanVersion }),
    sourcePlanVersion: state.sourcePlanVersion,
    remaining: structuredClone(state.remaining),
  };
}

function currentRecoveryPlanVersion(envelope: McpRunRecoveryEnvelope): number {
  let version = envelope.binding.authority.activePlanVersion;
  for (const record of envelope.ledger.records) {
    if (record.kind === "successor" && record.event.phase === "activated") {
      version = record.event.targetPlanVersion;
    }
  }
  return version;
}

async function approvePlan(
  transaction: McpRunTransaction,
  current: McpRunRecord,
  identity: RequestIdentity,
): Promise<McpRunResponse> {
  assertPhase(current, "awaiting_approval", "plan_approved");
  const state = nextPhase(current.state, { type: "plan_approved" }, current.loop);
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
  options: CreateMcpRunServiceOptions,
  signal?: AbortSignal,
): Promise<McpRunResponse> {
  assertPhase(current, "awaiting_approval", "plan_revision_requested");
  assertRoutingCapacity(current);
  const planning = nextPhase(current.state, { type: "plan_rejected_by_user" }, current.loop);
  const effect = allocateProviderEffect(current, "plan");
  const reserved = await compareAndSwapValidated(
    transaction,
    current.revision,
    draftFrom(current, {
      state: planning,
      pendingProviderIntent: true,
      providerEffects: [...current.providerEffects, providerEffectBase(effect)],
      nextProviderEffectOrdinal: effect.ordinal + 1,
    }),
    pendingRequest(identity, effect),
    "current",
  );
  const intent = requireCommitted(reserved, "reserving PLAN revision intent");
  const tracker = providerAttemptTracker(transaction, intent, identity, effect, [effect.effectId]);
  const providerResult = await callPlanProvider(options.provider, planRequest(intent, tracker, {
    previousPlan: current.state.plan,
    userFeedback: feedback,
    judgeReports: intent.state.judgeReports,
    signal,
  }));
  if (!providerResult.ok) {
    return settleOrBlockProviderFailure(transaction, tracker, identity, "advanced");
  }
  if (!tracker.canCommitReturnedResult()) {
    return settleOrBlockProviderFailure(transaction, tracker, identity, "advanced");
  }
  const completion = providerResult.value;
  if (!tracker.routingMatches(completion.routing)) {
    return settleProviderFailure(transaction, tracker.current(), identity, "advanced");
  }
  await options.afterProviderResult?.({ runId: current.runId, effect });
  const providerCheckpoint = tracker.current();
  const resultRef = await writeProviderOutput(
    transaction,
    providerCheckpoint,
    effect,
    "mcp-plan-output-v1",
    Buffer.from(completion.plan, "utf8"),
  );
  const withPlan = nextPhase(providerCheckpoint.state, { type: "plan_produced", plan: completion.plan }, providerCheckpoint.loop);
  const committed = await compareAndSwapValidated(
    transaction,
    providerCheckpoint.revision,
    draftFrom(providerCheckpoint, {
      state: withPlan,
      planVersion: current.planVersion + 1,
      routing: [...providerCheckpoint.routing, completion.routing],
      providerEvidence: markProviderOutput(providerCheckpoint.providerEvidence, effect, "output_committed", resultRef),
      pendingProviderIntent: false,
    }),
    settledRequestFor(providerCheckpoint, identity, "advanced"),
    "advanced",
  );
  return responseFor(requireCommitted(committed, "settling revised PLAN"), "advanced");
}

async function submitCode(
  transaction: McpRunTransaction,
  current: McpRunRecord,
  event: Extract<McpRunClientEvent, { type: "code_result_submitted" }>,
  identity: RequestIdentity,
  options: CreateMcpRunServiceOptions,
  signal?: AbortSignal,
): Promise<McpRunResponse> {
  assertPhase(current, "coding", "code_result_submitted");
  assertRoutingCapacity(current);
  const judging = nextPhase(current.state, { type: "code_produced" }, current.loop);
  const judgeEffect = allocateProviderEffect(current, "judge");
  const reserved = await compareAndSwapValidated(
    transaction,
    current.revision,
    draftFrom(current, {
      state: judging,
      pendingProviderIntent: true,
      providerEffects: [...current.providerEffects, providerEffectBase(judgeEffect)],
      nextProviderEffectOrdinal: judgeEffect.ordinal + 1,
    }),
    pendingRequest(identity, judgeEffect),
    "current",
  );
  const intent = requireCommitted(reserved, "reserving JUDGE intent");
  if (!intent.state.plan) throw new Error("Cannot judge a run without an approved plan");
  const judgeTracker = providerAttemptTracker(transaction, intent, identity, judgeEffect, [judgeEffect.effectId]);
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
  if (!providerResult.ok) {
    return settleOrBlockProviderFailure(transaction, judgeTracker, identity, "advanced");
  }
  if (!judgeTracker.canCommitReturnedResult()) {
    return settleOrBlockProviderFailure(transaction, judgeTracker, identity, "advanced");
  }
  const verdict = providerResult.value;
  const judgeCheckpoint = judgeTracker.current();
  if (!judgeTracker.routingMatches(verdict.routing) || !checkerEvidenceIsValid(judgeCheckpoint, verdict.routing)) {
    return settleProviderFailure(transaction, judgeCheckpoint, identity, "advanced");
  }
  await options.afterProviderResult?.({ runId: current.runId, effect: judgeEffect });

  const verdictEvent = verdict.verdict === "reject"
    ? { type: "verdict" as const, verdict: "reject" as const, reasons: verdict.reasons, requiredFixes: verdict.requiredFixes }
    : { type: "verdict" as const, verdict: "approve" as const, reasons: verdict.reasons };
  const judged = nextPhase(judgeCheckpoint.state, verdictEvent, judgeCheckpoint.loop);
  const lastVerdict: RunVerdict = verdict.verdict === "reject"
    ? { verdict: "reject", reasons: verdict.reasons, requiredFixes: verdict.requiredFixes }
    : { verdict: "approve", reasons: verdict.reasons };
  const judgeResultRef = await writeProviderOutput(
    transaction,
    judgeCheckpoint,
    judgeEffect,
    "mcp-judge-output-v1",
    Buffer.from(stableJson(lastVerdict), "utf8"),
  );
  const afterJudge = draftFrom(judgeCheckpoint, {
    state: judged,
    status: statusFor(judged),
    routing: [...judgeCheckpoint.routing, verdict.routing],
    providerEvidence: markProviderOutput(judgeCheckpoint.providerEvidence, judgeEffect, "output_committed", judgeResultRef),
    lastVerdict,
    terminalMessage: judged.phase === "failed" ? "Maximum coder iterations reached; the run failed closed." : undefined,
  });

  if (judged.phase !== "replanning") {
    const committed = await compareAndSwapValidated(
      transaction,
      judgeCheckpoint.revision,
      { ...afterJudge, pendingProviderIntent: false },
      settledRequestFor(judgeCheckpoint, identity, "advanced"),
      "advanced",
    );
    return responseFor(requireCommitted(committed, "settling JUDGE result"), "advanced");
  }

  if (afterJudge.routing.length >= MCP_RUN_ROUTING_MAX) {
    return settleRoutingLimitAfterJudge(transaction, judgeCheckpoint.revision, afterJudge, identity);
  }

  const planEffect = newProviderEffect(
    afterJudge.runId,
    "plan",
    afterJudge.nextProviderEffectOrdinal,
  );
  const replanEffectIds = [...providerEffectIdsFor(judgeCheckpoint, identity), planEffect.effectId];
  const replanIntent = await compareAndSwapValidated(
    transaction,
    judgeCheckpoint.revision,
    {
      ...afterJudge,
      pendingProviderIntent: true,
      providerEffects: [...afterJudge.providerEffects, providerEffectBase(planEffect)],
      nextProviderEffectOrdinal: planEffect.ordinal + 1,
    },
    pendingRequest(identity, planEffect, replanEffectIds),
    "current",
  );
  const replanning = requireCommitted(replanIntent, "reserving re-PLAN intent");
  const planTracker = providerAttemptTracker(transaction, replanning, identity, planEffect, replanEffectIds);
  const planResult = await callPlanProvider(options.provider, planRequest(replanning, planTracker, {
    previousPlan: current.state.plan,
    judgeReports: judged.judgeReports,
    diff: event.diff,
    signal,
  }));
  if (!planResult.ok) {
    return settleOrBlockProviderFailure(transaction, planTracker, identity, "advanced");
  }
  if (!planTracker.canCommitReturnedResult()) {
    return settleOrBlockProviderFailure(transaction, planTracker, identity, "advanced");
  }
  const completion = planResult.value;
  if (!planTracker.routingMatches(completion.routing)) {
    return settleProviderFailure(transaction, planTracker.current(), identity, "advanced");
  }
  await options.afterProviderResult?.({ runId: current.runId, effect: planEffect });
  const planCheckpoint = planTracker.current();
  const planResultRef = await writeProviderOutput(
    transaction,
    planCheckpoint,
    planEffect,
    "mcp-plan-output-v1",
    Buffer.from(completion.plan, "utf8"),
  );
  const withPlan = nextPhase(planCheckpoint.state, { type: "plan_produced", plan: completion.plan }, planCheckpoint.loop);
  const committed = await compareAndSwapValidated(
    transaction,
    planCheckpoint.revision,
    draftFrom(planCheckpoint, {
      state: withPlan,
      status: "active",
      planVersion: current.planVersion + 1,
      routing: [...planCheckpoint.routing, completion.routing],
      providerEvidence: markProviderOutput(planCheckpoint.providerEvidence, planEffect, "output_committed", planResultRef),
      pendingProviderIntent: false,
    }),
    settledRequestFor(planCheckpoint, identity, "advanced"),
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
  const pendingEffect = current.requestAuthority.state === "pending" ? current.requestAuthority.effect : undefined;
  const abandonedProviderAttempt = pendingEffect?.phase === "attempting"
    ? { ...providerEffectBase(pendingEffect), attempt: structuredClone(pendingEffect.attempt) }
    : undefined;
  const providerEvidence = pendingEffect?.phase === "awaiting_output_commit"
    ? markProviderOutputUnknownForCancellation(current.providerEvidence, pendingEffect)
    : current.providerEvidence;
  const state = current.status === "failed" && current.recovery !== undefined
    ? createIdleState({
        originalModel: current.state.originalModel
          ? structuredClone(current.state.originalModel)
          : undefined,
      })
    : nextPhase(current.state, { type: "cancelled" }, current.loop);
  const committed = await compareAndSwapValidated(
    transaction,
    current.revision,
    draftFrom(current, {
      state,
      status: "cancelled",
      cancelledCheckpoint,
      terminalMessage: reason?.trim() || "Run cancelled by the client.",
      pendingProviderIntent: false,
      providerEvidence,
      ...(abandonedProviderAttempt === undefined ? {} : { abandonedProviderAttempt }),
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

async function settleOrBlockProviderFailure(
  transaction: Pick<McpRunTransaction, "compareAndSwap">,
  tracker: ProviderAttemptTracker,
  identity: RequestIdentity,
  outcome: RunOutcome,
): Promise<McpRunResponse> {
  tracker.assertNoActiveAttempt();
  if (tracker.hasUnknownOutcome()) return responseFor(tracker.current(), "current");
  return settleProviderFailure(transaction, tracker.current(), identity, outcome);
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
      providerEvidence: discardReturnedProviderOutput(intent),
      pendingProviderIntent: false,
    }),
    settledRequestFor(intent, identity, outcome),
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
    settledRequestFor(afterJudge, identity, "advanced"),
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
  hasUnknownOutcome: () => boolean;
  routingMatches: (routing: RunRoutingDecision) => boolean;
  assertNoActiveAttempt: () => void;
}

function allocateProviderEffect(record: McpRunRecord, kind: ProviderEffectBase["kind"]): ProviderEffect {
  return newProviderEffect(record.runId, kind, record.nextProviderEffectOrdinal);
}

function newProviderEffect(runId: string, kind: ProviderEffectBase["kind"], ordinal: number): ProviderEffect {
  return {
    effectId: providerEffectIdentity(runId, kind, ordinal),
    kind,
    ordinal,
    phase: "prepared",
  };
}

function providerEffectBase(effect: ProviderEffectBase): ProviderEffectBase {
  return { effectId: effect.effectId, kind: effect.kind, ordinal: effect.ordinal };
}

export function providerEffectIdentity(
  runId: string,
  kind: ProviderEffectBase["kind"],
  ordinal: number,
): string {
  return sha256(stableJson({ version: "mcp-provider-effect-v1", runId, kind, ordinal }));
}

function providerAttemptTracker(
  transaction: Pick<McpRunTransaction, "compareAndSwap">,
  initial: McpRunRecord,
  identity: RequestIdentity,
  effect: ProviderEffectBase,
  providerEffectIds: readonly string[],
): ProviderAttemptTracker {
  let checkpoint = initial;
  let activeAttempt: RoutedCompletionAttempt | undefined;
  let lastOutcome: RoutedCompletionAttemptResult["outcome"] | undefined;
  const completedAttempts: RoutedCompletionAttemptResult[] = [];
  let checkpointFailure: ProviderCheckpointError | undefined;
  let nextAttempt = 1;

  return {
    beforeAttempt: async (unparsed) => {
      const attempt = providerAttemptSchema.parse(unparsed);
      if (activeAttempt) throw new Error("A provider attempt is already active");
      if (attempt.attempt !== nextAttempt) throw new Error(`Provider attempt must be numbered ${nextAttempt}`);
      if (nextAttempt > 1 && lastOutcome !== "failed") {
        throw new Error("Provider fallback requires a prior definitive failure");
      }
      if (checkpoint.providerAttempts >= checkpoint.maxProviderCalls) {
        throw new Error("Provider call limit exhausted");
      }
      const reservation: ProviderAttemptReservation = {
        ...attempt,
        providerAttemptIdempotencyKey: providerAttemptIdempotencyKey(checkpoint.runId, effect, attempt),
      };
      const attempting: ProviderEffect = { ...effect, phase: "attempting", attempt: reservation };
      try {
        const committed = await compareAndSwapValidated(
          transaction,
          checkpoint.revision,
          draftFrom(checkpoint, { providerAttempts: checkpoint.providerAttempts + 1 }),
          pendingRequest(identity, attempting, providerEffectIds),
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
        const attempted: ProviderEffect = result.outcome === "succeeded"
          ? {
              ...effect,
              phase: "awaiting_output_commit",
              attempt: {
                ...attemptWithoutOutcome(result),
                providerAttemptIdempotencyKey: providerAttemptIdempotencyKey(checkpoint.runId, effect, result),
              },
            }
          : { ...effect, phase: "attempted", result };
        const committed = await compareAndSwapValidated(
          transaction,
          checkpoint.revision,
          draftFrom(checkpoint, {
            providerEvidence: [
              ...checkpoint.providerEvidence,
              evidenceForAttempt(checkpoint.runId, effect, result),
            ],
          }),
          pendingRequest(identity, attempted, providerEffectIds),
          "current",
        );
        checkpoint = requireCommitted(committed, "settling provider attempt evidence");
      } catch {
        checkpointFailure = new ProviderCheckpointError();
        throw checkpointFailure;
      }
      activeAttempt = undefined;
      lastOutcome = result.outcome;
      completedAttempts.push(structuredClone(result));
      nextAttempt += 1;
    },
    current: () => checkpoint,
    canCommitReturnedResult: () => {
      if (checkpointFailure) throw checkpointFailure;
      return activeAttempt === undefined && lastOutcome === "succeeded";
    },
    hasUnknownOutcome: () => lastOutcome === "unknown",
    routingMatches: (routing) => routingMatchesAttempts(routing, completedAttempts),
    assertNoActiveAttempt: () => {
      if (activeAttempt) throw new ProviderCheckpointError();
    },
  };
}

function sameAttempt(left: RoutedCompletionAttempt, right: RoutedCompletionAttempt): boolean {
  return left.attempt === right.attempt
    && left.providerRequestRef === right.providerRequestRef
    && sameRoutingDecision(left.routingDecision, right.routingDecision)
    && left.identity.provider === right.identity.provider
    && left.identity.model === right.identity.model
    && left.identity.family === right.identity.family
    && left.thinking === right.thinking
    && left.requestedOutputTokens === right.requestedOutputTokens
    && left.estimatedCostUsd === right.estimatedCostUsd;
}

function evidenceForAttempt(
  runId: string,
  effect: ProviderEffectBase,
  result: RoutedCompletionAttemptResult,
): ProviderAttemptEvidence {
  const base = {
    ...effect,
    ...attemptWithoutOutcome(result),
    providerAttemptIdempotencyKey: providerAttemptIdempotencyKey(runId, effect, result),
  };
  if (result.outcome === "succeeded") return { ...base, phase: "awaiting_output_commit" };
  if (result.outcome === "failed") return { ...base, phase: "failed", failureCode: result.failureCode };
  return { ...base, phase: "unknown", failureCode: result.failureCode };
}

export function providerAttemptIdempotencyKey(
  runId: string,
  effect: ProviderEffectBase,
  attempt: Pick<RoutedCompletionAttempt, "attempt" | "providerRequestRef">,
): string {
  return sha256(stableJson({
    version: "mcp-provider-attempt-v1",
    runId,
    effectId: effect.effectId,
    kind: effect.kind,
    ordinal: effect.ordinal,
    attempt: attempt.attempt,
    providerRequestRef: attempt.providerRequestRef,
  }));
}

function markProviderOutput(
  evidence: readonly ProviderAttemptEvidence[],
  effect: ProviderEffectBase,
  phase: "output_committed" | "discarded",
  resultRef?: ArtifactReference,
): ProviderAttemptEvidence[] {
  const copy: ProviderAttemptEvidence[] = evidence.map((item) => structuredClone(item));
  const index = findLastEvidenceIndex(copy, (item) => item.effectId === effect.effectId
    && item.phase === "awaiting_output_commit");
  if (index < 0) throw new Error(`No returned ${effect.kind} provider output is available to mark ${phase}`);
  const current = copy[index]!;
  if (current.phase !== "awaiting_output_commit") throw new Error("Provider evidence changed during output settlement");
  if (phase === "output_committed") {
    copy[index] = { ...current, phase, resultRef: artifactReferenceSchema.parse(resultRef) };
  } else {
    if (resultRef !== undefined) throw new Error("Discarded provider output must not retain a result artifact");
    copy[index] = { ...current, phase };
  }
  return copy;
}

async function writeProviderOutput(
  transaction: Pick<McpRunTransaction, "writeProviderOutput">,
  record: McpRunRecord,
  effect: ProviderEffectBase,
  contract: McpRunProviderOutput["contract"],
  bytes: Uint8Array,
): Promise<ArtifactReference> {
  const index = findLastEvidenceIndex(record.providerEvidence, (item) => item.effectId === effect.effectId
    && item.phase === "awaiting_output_commit");
  const evidence = index < 0 ? undefined : record.providerEvidence[index];
  if (!evidence || evidence.phase !== "awaiting_output_commit") {
    throw new Error(`No returned ${effect.kind} provider output is available to artifact`);
  }
  const resultRef = await transaction.writeProviderOutput({
    runId: record.runId,
    effect: providerEffectBase(effect),
    attempt: {
      attempt: evidence.attempt,
      providerRequestRef: evidence.providerRequestRef,
      routingDecision: structuredClone(evidence.routingDecision),
      identity: structuredClone(evidence.identity),
      thinking: evidence.thinking,
      ...(evidence.requestedOutputTokens === undefined ? {} : { requestedOutputTokens: evidence.requestedOutputTokens }),
      ...(evidence.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: evidence.estimatedCostUsd }),
      providerAttemptIdempotencyKey: evidence.providerAttemptIdempotencyKey,
    },
    contract,
    bytes: Buffer.from(bytes),
  });
  return artifactReferenceSchema.parse(resultRef);
}

function discardReturnedProviderOutput(record: McpRunRecord): ProviderAttemptEvidence[] {
  const copy = structuredClone(record.providerEvidence);
  const index = findLastEvidenceIndex(copy, (item) => item.phase === "awaiting_output_commit");
  const current = index < 0 ? undefined : copy[index];
  if (current?.phase === "awaiting_output_commit") copy[index] = { ...current, phase: "discarded" };
  return copy;
}

function markProviderOutputUnknownForCancellation(
  evidence: readonly ProviderAttemptEvidence[],
  effect: Extract<ProviderEffect, { phase: "awaiting_output_commit" }>,
): ProviderAttemptEvidence[] {
  const copy: ProviderAttemptEvidence[] = evidence.map((item) => structuredClone(item));
  const index = findLastEvidenceIndex(copy, (item) => item.effectId === effect.effectId
    && item.phase === "awaiting_output_commit");
  const current = index < 0 ? undefined : copy[index];
  if (!current || current.phase !== "awaiting_output_commit" || !sameAttempt(current, effect.attempt)) {
    throw new Error("Cancelled provider output does not match its durable evidence");
  }
  copy[index] = { ...current, phase: "unknown", failureCode: "provider_failed" };
  return copy;
}

function findLastEvidenceIndex(
  evidence: readonly ProviderAttemptEvidence[],
  predicate: (item: ProviderAttemptEvidence) => boolean,
): number {
  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    if (predicate(evidence[index]!)) return index;
  }
  return -1;
}

function routingMatchesAttempts(
  routing: RunRoutingDecision,
  attempts: readonly RoutedCompletionAttemptResult[],
): boolean {
  if (attempts.length === 0) return false;
  const selected = attempts.at(-1);
  if (!selected || selected.outcome !== "succeeded") return false;
  if (!attempts.every((attempt) => sameRoutingDecision(attempt.routingDecision, selected.routingDecision))) return false;
  const failures = attempts.slice(0, -1);
  if (failures.some((attempt) => attempt.outcome !== "failed")) return false;
  if (!sameRoutingIdentity(routing.selectedIdentity, selected.identity)) return false;
  if (routing.decisionId !== selected.routingDecision.decisionId
    || routing.policyVersion !== selected.routingDecision.policyVersion
    || routing.policyDigest !== selected.routingDecision.policyDigest
    || routing.configDigest !== selected.routingDecision.configDigest
    || routing.candidatesDigest !== selected.routingDecision.candidatesDigest) return false;
  if (routing.selectedIndex !== attempts.length - 1) return false;
  if (routing.thinking !== selected.thinking) return false;
  if (routing.fallbackHistory.length !== failures.length) return false;
  return failures.every((attempt, index) => {
    if (attempt.outcome !== "failed") return false;
    const claimed = routing.fallbackHistory[index];
    return claimed?.identity === `${attempt.identity.provider}/${attempt.identity.model}`
      && claimed.failureCode === attempt.failureCode;
  });
}

function sameRoutingDecision(
  left: RoutedCompletionAttempt["routingDecision"],
  right: RoutedCompletionAttempt["routingDecision"],
): boolean {
  return left.decisionId === right.decisionId
    && left.policyVersion === right.policyVersion
    && left.policyDigest === right.policyDigest
    && left.configDigest === right.configDigest
    && left.candidatesDigest === right.candidatesDigest;
}

function sameRoutingIdentity(
  left: RunRoutingDecision["selectedIdentity"],
  right: RoutedCompletionAttempt["identity"],
): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.family === right.family;
}

function attemptWithoutOutcome(result: RoutedCompletionAttemptResult): RoutedCompletionAttempt {
  const { outcome: _outcome, ...withPossibleFailure } = result;
  const { failureCode: _failureCode, ...attempt } = withPossibleFailure as RoutedCompletionAttempt & { failureCode?: unknown };
  return attempt;
}

function responseFor(record: McpRunRecord, outcome: RunOutcome): McpRunResponse {
  const loop = record.loop;
  const providerBlocked = record.pendingProviderIntent;
  const recoveryBlocked = record.recovery !== undefined && record.status !== "cancelled";
  const blocked = providerBlocked || recoveryBlocked;
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
    ...(providerBlocked || visibleState.plan === undefined ? {} : { plan: visibleState.plan }),
    ...(providerBlocked || record.lastVerdict === undefined ? {} : { lastVerdict: structuredClone(record.lastVerdict) }),
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
    ...(record.recovery === undefined ? {} : { recovery: recoveryResponseFor(record.recovery) }),
    ...(providerBlocked
      ? { message: "A provider returned but its durable outcome is uncertain; this run requires recovery before it can advance." }
      : recoveryBlocked
        ? { message: "A scheduler-anchored recovery decision is pending execution; inspect the typed recovery result before advancing." }
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
    recovery: _recovery,
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
    if (request.checkpoint.runId !== request.runId) {
      throw new Error("Settled MCP request checkpoint does not belong to its recorded run");
    }
    const checkpoint = recordForAuthority(
      await repository.getCheckpoint(request.checkpoint),
      request.checkpoint.runId,
      request.checkpoint.revision,
    );
    if (!checkpoint) {
      throw new Error(`Settled MCP request checkpoint ${request.checkpoint.runId}@${request.checkpoint.revision} was not found`);
    }
    await assertFrozenCreationAuthority(repository, checkpoint);
    assertRequestReceiptAuthority(request, checkpoint);
    return responseFor(checkpoint, request.outcome);
  }
  const reservation = recordForAuthority(
    await repository.getCheckpoint({ runId: request.runId, revision: request.reservedRevision }),
    request.runId,
    request.reservedRevision,
  );
  if (!reservation) {
    throw new Error(`Pending MCP request checkpoint ${request.runId}@${request.reservedRevision} was not found`);
  }
  await assertFrozenCreationAuthority(repository, reservation);
  assertRequestReceiptAuthority(request, reservation);
  if (!reservation.pendingProviderIntent) {
    throw new Error("Pending MCP request checkpoint does not retain provider-intent authority");
  }
  const record = await requireRun(repository, request.runId);
  if (record.revision < request.reservedRevision) {
    throw new Error("Pending MCP request points beyond the current run authority");
  }
  return responseFor(record, "current");
}

function assertRequestReceiptAuthority(request: McpRunRequestRecord, checkpoint: McpRunRecord): void {
  const update = requestUpdateFromRecord(request);
  const expected = createMcpRunRequestRecord(update, checkpoint);
  if (stableJson(request) !== stableJson(expected)) {
    throw new Error("MCP request receipt does not match its exact checkpoint authority");
  }
  if (stableJson(checkpoint.requestAuthority) !== stableJson(requestAuthorityFor(update))) {
    throw new Error("MCP request receipt was substituted with unrelated checkpoint authority");
  }
}

function requestUpdateFromRecord(request: McpRunRequestRecord): McpRunRequestUpdate {
  const base = {
    requestRef: request.requestRef,
    requestHash: request.requestHash,
    mutationEffect: structuredClone(request.mutationEffect),
    providerEffectIds: [...request.providerEffectIds],
  };
  return request.state === "pending"
    ? { ...base, state: "pending", effect: structuredClone(request.effect) }
    : { ...base, state: "settled", outcome: request.outcome };
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
  const boundDraft = bindRequestAuthority(draft, request);
  assertProspectiveResponse(boundDraft, expectedRevision, outcome);
  let publicationValidated = false;
  const beforePublication: McpRunPublicationGuard = (publication) => {
    validatePublication(publication, boundDraft, request, expectedRevision, outcome);
    publicationValidated = true;
  };
  const committed = await transaction.compareAndSwap(
    expectedRevision,
    boundDraft,
    request,
    beforePublication,
  );
  if (!committed) return undefined;
  if (!publicationValidated) {
    throw new Error("Run repository published a CAS result without invoking its validation guard");
  }
  return validateAssignedRecord(committed, boundDraft, expectedRevision, outcome);
}

async function reserveValidated(
  transaction: Pick<McpRunStartTransaction, "reserve">,
  draft: McpRunRecordDraft,
  request: Extract<McpRunRequestUpdate, { state: "pending" }>,
  outcome: RunOutcome,
): Promise<McpRunRecord> {
  const boundDraft = bindRequestAuthority(draft, request);
  assertProspectiveResponse(boundDraft, 0, outcome);
  let publicationValidated = false;
  const beforePublication: McpRunPublicationGuard = (publication) => {
    validatePublication(publication, boundDraft, request, 0, outcome);
    publicationValidated = true;
  };
  const committed = await transaction.reserve(boundDraft, request, beforePublication);
  if (!publicationValidated) {
    throw new Error("Run repository published a reservation without invoking its validation guard");
  }
  return validateAssignedRecord(committed, boundDraft, 0, outcome);
}

function bindRequestAuthority(
  draft: McpRunRecordDraft,
  update: McpRunRequestUpdate,
): McpRunRecordDraft {
  return JSON.parse(stableJson({
    ...structuredClone(draft),
    requestAuthority: requestAuthorityFor(update),
  })) as McpRunRecordDraft;
}

function requestAuthorityFor(update: McpRunRequestUpdate): McpRunRequestAuthority {
  return update.state === "pending"
    ? {
        state: "pending",
        requestRef: update.requestRef,
        requestHash: update.requestHash,
        mutationEffect: structuredClone(update.mutationEffect),
        providerEffectIds: [...update.providerEffectIds],
        effect: structuredClone(update.effect),
      }
    : {
        state: "settled",
        requestRef: update.requestRef,
        requestHash: update.requestHash,
        mutationEffect: structuredClone(update.mutationEffect),
        providerEffectIds: [...update.providerEffectIds],
        outcome: update.outcome,
      };
}

function validatePublication(
  publication: McpRunPublication,
  draft: McpRunRecordDraft,
  update: McpRunRequestUpdate,
  expectedRevision: number,
  outcome: RunOutcome,
): void {
  const record = validateAssignedRecord(publication.record, draft, expectedRevision, outcome);
  const request = parseCanonical(requestRecordSchema, publication.request, "request publication") as McpRunRequestRecord;
  const expectedRequest = createMcpRunRequestRecord(update, record);
  if (stableJson(request) !== stableJson(expectedRequest)) {
    throw new Error("Run repository assigned request authority that does not match the proposed publication");
  }
}

export function createMcpRunRequestRecord(
  update: McpRunRequestUpdate,
  record: McpRunRecord,
): McpRunRequestRecord {
  const authorityDigest = authorityDigestFor(record);
  const core = update.state === "pending"
    ? { ...structuredClone(update), runId: record.runId, reservedRevision: record.revision, authorityDigest }
    : {
        ...structuredClone(update),
        runId: record.runId,
        checkpoint: { runId: record.runId, revision: record.revision },
        authorityDigest,
      };
  return {
    ...core,
    eventDigest: sha256(stableJson({ version: "mcp-request-event-v1", ...core })),
  } as McpRunRequestRecord;
}

function authorityDigestFor(record: McpRunRecord): string {
  return sha256(stableJson({ version: "mcp-run-authority-v1", record }));
}

function validateAssignedRecord(
  unparsed: McpRunRecord,
  draft: McpRunRecordDraft,
  expectedRevision: number,
  outcome: RunOutcome,
): McpRunRecord {
  if (!Number.isSafeInteger(unparsed.revision) || unparsed.revision < 1) {
    throw new Error("Run repository assigned an unsafe revision");
  }
  const record = parseCanonical(runRecordSchema, unparsed, "run publication") as McpRunRecord;
  if (record.runId !== draft.runId) {
    throw new Error("Run repository changed the run identity while assigning a revision");
  }
  if (record.revision !== expectedRevision + 1) {
    throw new Error("Run repository must assign the exact next revision without gaps");
  }
  const { revision: _revision, ...assignedDraft } = record;
  if (stableJson(assignedDraft) !== stableJson(draft)) {
    throw new Error("Run repository changed authoritative run data while assigning a revision");
  }
  if (expectedRevision === 0) assertGenesisCheckpoint(record);
  assertRunBusinessInvariants(record);
  responseFor(record, outcome);
  return record;
}

function assertProspectiveResponse(draft: McpRunRecordDraft, revision: number, outcome: RunOutcome): void {
  responseFor({ ...structuredClone(draft), revision }, outcome);
}

function requestForLookup(
  unparsed: McpRunRequestRecord | undefined,
  expectedRequestRef: string,
  expectedRunId?: string,
): McpRunRequestRecord | undefined {
  if (!unparsed) return undefined;
  const request = parseCanonical(requestRecordSchema, unparsed, "request lookup") as McpRunRequestRecord;
  if (request.requestRef !== expectedRequestRef) {
    throw new Error("Run repository returned a request record for a different lookup reference");
  }
  if (expectedRunId !== undefined && request.runId !== expectedRunId) {
    throw new Error("Run repository returned a request record for a different run");
  }
  return request;
}

function recordForAuthority(
  unparsed: McpRunRecord | undefined,
  expectedRunId: string,
  expectedRevision?: number,
): McpRunRecord | undefined {
  if (!unparsed) return undefined;
  const record = parseCanonical(runRecordSchema, unparsed, "run authority") as McpRunRecord;
  if (record.runId !== expectedRunId) {
    throw new Error("Run repository returned authority for a different run");
  }
  if (expectedRevision !== undefined && record.revision !== expectedRevision) {
    throw new Error("Run repository returned a checkpoint at a different revision");
  }
  // Validate the frozen loop before any persisted transition consumes it.
  nextPhase(createIdleState(), { type: "start", task: "validate", yolo: false }, record.loop);
  assertRunBusinessInvariants(record);
  responseFor(record, "current");
  return record;
}

function assertRunBusinessInvariants(record: McpRunRecord): void {
  const visibleState = record.status === "cancelled" ? record.cancelledCheckpoint : record.state;
  if (!visibleState) throw new Error("Cancelled run is missing its last lifecycle checkpoint");
  if (!record.loop.requirePlanApproval) throw new Error("Persisted MCP runs must require plan approval");
  if (record.state.yolo || record.cancelledCheckpoint?.yolo) throw new Error("Persisted MCP runs must never enable yolo mode");
  if (record.providerAttempts > record.maxProviderCalls) throw new Error("Provider attempt count exceeds its frozen limit");
  if (visibleState.coderIterations > record.loop.maxCoderIterations) throw new Error("Coder iteration count exceeds its frozen limit");
  if (visibleState.consecutiveRejections > record.loop.plannerEscalationAfterRejections) {
    throw new Error("Consecutive rejection count exceeds its frozen escalation threshold");
  }
  if (record.requireDifferentCheckerFamily && record.coderFamily === undefined) {
    throw new Error("Coder family is required for checker family separation");
  }
  if (record.recovery !== undefined) {
    const recovery = validateMcpRunRecoveryEnvelope(record.recovery);
    if (recovery.binding.authority.runId !== record.runId ||
        currentRecoveryPlanVersion(recovery) !== record.planVersion) {
      throw new Error("Persisted MCP recovery authority is not bound to the run's approved plan lineage");
    }
  }

  const phase = record.state.phase;
  if (record.status === "active" && !["planning", "awaiting_approval", "coding", "judging", "replanning"].includes(phase)) {
    throw new Error("Active run status does not match its phase");
  }
  if (record.status === "done" && phase !== "done") throw new Error("Done run status does not match its phase");
  if (record.status === "failed" && phase !== "failed") throw new Error("Failed run status does not match its phase");
  if (record.status === "cancelled") {
    if (phase !== "idle" || !record.cancelledCheckpoint) throw new Error("Cancelled run must retain an idle reducer plus its last active checkpoint");
    if (record.state.task !== "" || record.state.plan !== undefined) throw new Error("Cancelled reducer state must be reset");
    const cancellableCheckpointPhases = ["planning", "awaiting_approval", "coding", "judging", "replanning"];
    const failedRecoveryCheckpoint = record.cancelledCheckpoint.phase === "failed" && record.recovery !== undefined;
    if (!cancellableCheckpointPhases.includes(record.cancelledCheckpoint.phase) && !failedRecoveryCheckpoint) {
      throw new Error("Cancelled run checkpoint must retain an active or failed recovery lifecycle phase");
    }
  } else if (record.cancelledCheckpoint !== undefined) {
    throw new Error("Only cancelled runs may retain a cancellation checkpoint");
  }
  if (record.status !== "cancelled" && record.abandonedProviderAttempt !== undefined) {
    throw new Error("Only cancelled runs may retain an abandoned provider attempt");
  }

  if (["awaiting_approval", "coding", "judging", "replanning", "done"].includes(visibleState.phase)
    && !visibleState.plan?.trim()) {
    throw new Error(`Run phase ${visibleState.phase} requires a non-empty plan`);
  }
  if (record.status === "done" && record.lastVerdict?.verdict !== "approve") {
    throw new Error("Done run must retain its approving verdict");
  }

  if (record.pendingProviderIntent !== (record.requestAuthority.state === "pending")) {
    throw new Error("Provider-intent flag does not match request authority");
  }
  if (record.pendingProviderIntent) {
    if (record.status !== "active" || !["planning", "judging", "replanning"].includes(phase)) {
      throw new Error("Pending provider intent is not valid for the current status and phase");
    }
    const activeEffect = record.requestAuthority.state === "pending" ? record.requestAuthority.effect : undefined;
    if (!activeEffect || record.requestAuthority.providerEffectIds.at(-1) !== activeEffect.effectId) {
      throw new Error("Pending request authority does not end with its active provider effect");
    }
    const expectedKind = phase === "judging" ? "judge" : "plan";
    if (activeEffect.kind !== expectedKind) {
      throw new Error("Pending provider effect kind does not match the active lifecycle phase");
    }
    assertEffectBaseMatchesLedger(record, activeEffect, "Pending provider effect");
    assertPendingEffectEvidence(record, activeEffect);
  } else if (record.status === "active" && !["awaiting_approval", "coding"].includes(phase)) {
    throw new Error("Active run without provider intent must await approval or code");
  }
  if (!record.pendingProviderIntent
    && record.providerEvidence.some(({ phase: evidencePhase }) => evidencePhase === "awaiting_output_commit")) {
    throw new Error("Settled run retains unresolved provider output evidence");
  }

  const effectIds = new Set<string>();
  for (const [index, effect] of record.providerEffects.entries()) {
    const expectedOrdinal = index + 1;
    if (effect.ordinal !== expectedOrdinal) throw new Error("Provider effect ordinals must be contiguous and monotonic");
    if (effect.effectId !== providerEffectIdentity(record.runId, effect.kind, effect.ordinal)) {
      throw new Error("Provider effect identity does not match its frozen run/kind/ordinal");
    }
    if (effectIds.has(effect.effectId)) throw new Error("Provider effect identities must be unique");
    effectIds.add(effect.effectId);
  }
  if (record.nextProviderEffectOrdinal !== record.providerEffects.length + 1) {
    throw new Error("Next provider effect ordinal does not follow the durable effect ledger");
  }
  if (new Set(record.requestAuthority.providerEffectIds).size !== record.requestAuthority.providerEffectIds.length
    || record.requestAuthority.providerEffectIds.some((effectId) => !effectIds.has(effectId))) {
    throw new Error("Request authority references duplicate or unknown provider effects");
  }
  const requestEffectIds = record.requestAuthority.providerEffectIds;
  const tailEffectIds = requestEffectIds.length === 0
    ? []
    : record.providerEffects.slice(-requestEffectIds.length).map(({ effectId }) => effectId);
  if (stableJson(requestEffectIds) !== stableJson(tailEffectIds)) {
    throw new Error("Request authority provider effects must be the contiguous ledger tail");
  }
  assertMutationEffectShape(record);

  const attemptKeys = new Set<string>();
  const attemptsByEffect = new Map<string, ProviderAttemptEvidence[]>();
  const routingDecisionOwners = new Map<string, string>();
  let lastEvidenceEffectOrdinal = 0;
  for (const evidence of record.providerEvidence) {
    const effect = record.providerEffects.find((candidate) => candidate.effectId === evidence.effectId);
    if (!effect || effect.kind !== evidence.kind || effect.ordinal !== evidence.ordinal) {
      throw new Error("Provider attempt evidence references an unknown or changed effect");
    }
    if (effect.ordinal < lastEvidenceEffectOrdinal) {
      throw new Error("Provider attempt evidence must follow provider effect order");
    }
    lastEvidenceEffectOrdinal = effect.ordinal;
    const expectedKey = providerAttemptIdempotencyKey(record.runId, effect, evidence);
    if (evidence.providerAttemptIdempotencyKey !== expectedKey || attemptKeys.has(expectedKey)) {
      throw new Error("Provider attempt idempotency keys must be exact and unique");
    }
    attemptKeys.add(expectedKey);
    const decisionOwner = routingDecisionOwners.get(evidence.routingDecision.decisionId);
    if (decisionOwner !== undefined && decisionOwner !== evidence.effectId) {
      throw new Error("Routing decision identities must be unique across provider effects");
    }
    routingDecisionOwners.set(evidence.routingDecision.decisionId, evidence.effectId);
    const attempts = attemptsByEffect.get(effect.effectId) ?? [];
    attempts.push(evidence);
    attemptsByEffect.set(effect.effectId, attempts);
  }
  if (record.requestAuthority.state === "pending" && record.requestAuthority.effect.phase !== "prepared") {
    const activeEffect = record.requestAuthority.effect;
    const activeAttempt = activeEffect.phase === "attempted" ? activeEffect.result : activeEffect.attempt;
    const decisionOwner = routingDecisionOwners.get(activeAttempt.routingDecision.decisionId);
    if (decisionOwner !== undefined && decisionOwner !== activeEffect.effectId) {
      throw new Error("Active routing decision identity was already used by another provider effect");
    }
  }
  for (const attempts of attemptsByEffect.values()) {
    attempts.forEach((attempt, index) => {
      if (attempt.attempt !== index + 1) throw new Error("Provider candidate attempts must be contiguous within an effect");
      if (!sameRoutingDecision(attempt.routingDecision, attempts[0]!.routingDecision)) {
        throw new Error("Provider attempts changed their predeclared routing decision");
      }
      if (index < attempts.length - 1 && attempt.phase !== "failed") {
        throw new Error("Only failed provider attempts may precede a fallback");
      }
    });
  }

  const abandoned = record.abandonedProviderAttempt;
  if (abandoned) {
    const effect = record.providerEffects.find(({ effectId }) => effectId === abandoned.effectId);
    const attempts = attemptsByEffect.get(abandoned.effectId) ?? [];
    if (!effect || effect.kind !== abandoned.kind || effect.ordinal !== abandoned.ordinal
      || abandoned.attempt.attempt !== attempts.length + 1
      || abandoned.attempt.providerAttemptIdempotencyKey
        !== providerAttemptIdempotencyKey(record.runId, abandoned, abandoned.attempt)
      || (attempts[0] !== undefined
        && !sameRoutingDecision(abandoned.attempt.routingDecision, attempts[0].routingDecision))) {
      throw new Error("Cancelled run's abandoned provider attempt is not exact durable evidence");
    }
    assertDefinitiveFallbackPredecessor(
      abandoned.attempt,
      attempts,
      "Cancelled run's abandoned provider fallback",
    );
  }

  const activeAttempt = record.requestAuthority.state === "pending"
    && record.requestAuthority.effect.phase === "attempting" ? 1 : 0;
  if (record.providerAttempts !== record.providerEvidence.length + activeAttempt + (abandoned ? 1 : 0)) {
    throw new Error("Provider attempt count does not match durable before/after evidence");
  }

  const routingIds = new Set<string>();
  for (const routing of record.routing) {
    if (routingIds.has(routing.decisionId)) throw new Error("Routing decision identities must be unique");
    routingIds.add(routing.decisionId);
    const committed = record.providerEvidence.filter((evidence) => evidence.phase === "output_committed"
      && evidence.routingDecision.decisionId === routing.decisionId);
    const selected = committed[0];
    if (committed.length !== 1 || !selected
      || !routingMatchesCommittedEvidence(routing, selected, attemptsByEffect.get(selected.effectId) ?? [])) {
      throw new Error("Routing result does not match one committed provider output");
    }
  }
  const committedOutputs = record.providerEvidence.filter((evidence) => evidence.phase === "output_committed");
  if (committedOutputs.length !== record.routing.length) {
    throw new Error("Committed provider outputs and routing results must have equal cardinality");
  }
  if (record.routing.some((routing, index) => routing.decisionId !== committedOutputs[index]?.routingDecision.decisionId)) {
    throw new Error("Routing result order does not match committed provider output order");
  }
  const committedPlans = committedOutputs.filter(({ kind }) => kind === "plan").length;
  if ((committedPlans === 0 && record.planVersion !== 1)
    || (committedPlans > 0 && record.planVersion !== committedPlans)) {
    throw new Error("Plan version does not match committed PLAN outputs");
  }
  assertReachableLifecycleAuthority(record, attemptsByEffect);
  const lastReport = visibleState.judgeReports.at(-1);
  if ((lastReport === undefined) !== (record.lastVerdict === undefined)
    || (lastReport !== undefined && stableJson(lastReport) !== stableJson(record.lastVerdict))) {
    throw new Error("Last verdict does not match reducer judge history");
  }
}

function assertMutationEffectShape(record: McpRunRecord): void {
  const ids = record.requestAuthority.providerEffectIds;
  const effects = ids.length === 0 ? [] : record.providerEffects.slice(-ids.length);
  const mutation = record.requestAuthority.mutationEffect;
  if (mutation.operation === "start") {
    if (record.requestAuthority.state === "settled" && record.requestAuthority.outcome !== "started") {
      throw new Error("Settled start request has an invalid outcome");
    }
    if (ids.length !== 1 || effects[0]?.kind !== "plan" || effects[0].ordinal !== 1) {
      throw new Error("Start request authority must own exactly the initial PLAN effect");
    }
    return;
  }
  if (mutation.operation === "recover") {
    if (record.requestAuthority.state !== "settled" || record.requestAuthority.outcome !== "advanced" || ids.length !== 0) {
      throw new Error("Recovery request must settle without provider effects");
    }
    if (record.recovery === undefined) throw new Error("Recovery request did not persist recovery authority");
    return;
  }
  if (record.requestAuthority.state === "settled") {
    const expectedOutcome = mutation.operation === "cancel" || mutation.event === "cancelled"
      ? "cancelled"
      : "advanced";
    if (record.requestAuthority.outcome !== expectedOutcome) {
      throw new Error("Settled mutation request has an invalid outcome");
    }
  }
  if (mutation.operation === "cancel" || mutation.event === "cancelled" || mutation.event === "plan_approved") {
    if (ids.length !== 0) throw new Error("Non-provider mutation unexpectedly owns provider effects");
    return;
  }
  if (mutation.event === "plan_revision_requested") {
    if (ids.length !== 1 || effects[0]?.kind !== "plan") {
      throw new Error("Plan revision request must own exactly one PLAN effect");
    }
    return;
  }
  if (ids.length < 1 || ids.length > 2 || effects[0]?.kind !== "judge"
    || (ids.length === 2 && effects[1]?.kind !== "plan")) {
    throw new Error("Code result request must own its JUDGE effect and optional re-PLAN effect");
  }
}

function assertPendingEffectEvidence(record: McpRunRecord, effect: ProviderEffect): void {
  const attempts = record.providerEvidence.filter((evidence) => evidence.effectId === effect.effectId);
  if (effect.phase === "prepared") {
    if (attempts.length !== 0) throw new Error("Prepared provider effect already has attempt evidence");
    return;
  }
  if (effect.phase === "attempting") {
    if (effect.attempt.attempt !== attempts.length + 1
      || effect.attempt.providerAttemptIdempotencyKey !== providerAttemptIdempotencyKey(record.runId, effect, effect.attempt)
      || (attempts[0] !== undefined
        && !sameRoutingDecision(effect.attempt.routingDecision, attempts[0].routingDecision))) {
      throw new Error("Active provider attempt does not match its durable reservation");
    }
    assertDefinitiveFallbackPredecessor(effect.attempt, attempts, "Active provider fallback");
    return;
  }
  const last = attempts.at(-1);
  if (!last || last.attempt !== attempts.length) throw new Error("Settled provider effect is missing ordered attempt evidence");
  const currentAttempt = effect.phase === "attempted" ? effect.result : effect.attempt;
  assertDefinitiveFallbackPredecessor(currentAttempt, attempts, "Settled provider fallback");
  if (effect.phase === "attempted") {
    const expectedPhase = effect.result.outcome;
    if ((last.phase !== "failed" && last.phase !== "unknown")
      || last.phase !== expectedPhase
      || !sameAttempt(last, effect.result)
      || last.failureCode !== effect.result.failureCode) {
      throw new Error("Settled provider effect does not match its afterAttempt evidence");
    }
  } else if (last.phase !== "awaiting_output_commit" || !sameAttempt(last, effect.attempt)) {
    throw new Error("Returned provider effect does not match its awaiting-output evidence");
  }
}

function assertDefinitiveFallbackPredecessor(
  attempt: Pick<ProviderAttemptReservation, "attempt">,
  evidence: readonly ProviderAttemptEvidence[],
  label: string,
): void {
  if (attempt.attempt <= 1) return;
  const predecessor = evidence[attempt.attempt - 2];
  if (!predecessor || predecessor.attempt !== attempt.attempt - 1 || predecessor.phase !== "failed") {
    throw new Error(`${label} requires an immediately prior definitive failure`);
  }
}

function assertEffectBaseMatchesLedger(
  record: Pick<McpRunRecord, "runId" | "providerEffects">,
  effect: ProviderEffectBase,
  label: string,
): void {
  const ledger = record.providerEffects.find(({ effectId }) => effectId === effect.effectId);
  if (!ledger
    || stableJson(providerEffectBase(effect)) !== stableJson(ledger)
    || effect.effectId !== providerEffectIdentity(record.runId, effect.kind, effect.ordinal)) {
    throw new Error(`${label} does not match its immutable effect ledger identity`);
  }
}

function assertReachableLifecycleAuthority(
  record: McpRunRecord,
  attemptsByEffect: ReadonlyMap<string, readonly ProviderAttemptEvidence[]>,
): void {
  const visibleState = record.status === "cancelled" ? record.cancelledCheckpoint : record.state;
  if (!visibleState) throw new Error("Cancelled run is missing its last lifecycle checkpoint");
  let replay = nextPhase(
    createIdleState(),
    { type: "start", task: visibleState.task, yolo: false },
    record.loop,
  );
  let reportIndex = 0;
  let hasUncommittedEffect = false;

  for (const [index, effect] of record.providerEffects.entries()) {
    if (hasUncommittedEffect) {
      throw new Error("Provider effects after an uncommitted effect are not reachable lifecycle authority");
    }
    replay = prepareLifecycleForProviderEffect(replay, effect.kind, record.loop);
    const attempts = attemptsByEffect.get(effect.effectId) ?? [];
    const committed = attempts.filter(({ phase }) => phase === "output_committed");
    if (committed.length > 1) {
      throw new Error("A provider effect committed more than one output");
    }
    if (committed.length === 0) {
      if (index !== record.providerEffects.length - 1) {
        throw new Error("Only the final provider effect may remain uncommitted");
      }
      hasUncommittedEffect = true;
      continue;
    }

    if (effect.kind === "plan") {
      if (!visibleState.plan?.trim()) throw new Error("Committed PLAN output is missing its lifecycle plan");
      replay = nextPhase(replay, { type: "plan_produced", plan: visibleState.plan }, record.loop);
      continue;
    }

    const report = visibleState.judgeReports[reportIndex];
    if (!report) throw new Error("Committed JUDGE output is missing its reducer report");
    const verdict = report.verdict === "approve"
      ? mcpRunApproveVerdictSchema.parse(report)
      : mcpRunRejectVerdictSchema.parse(report);
    replay = verdict.verdict === "approve"
      ? nextPhase(replay, { type: "verdict", verdict: "approve", reasons: verdict.reasons }, record.loop)
      : nextPhase(replay, {
          type: "verdict",
          verdict: "reject",
          reasons: verdict.reasons,
          requiredFixes: verdict.requiredFixes,
        }, record.loop);
    reportIndex += 1;
  }

  if (reportIndex !== visibleState.judgeReports.length) {
    throw new Error("Reducer judge history is not reachable from committed JUDGE outputs");
  }

  const candidates = reachableFinalStates(record, replay, hasUncommittedEffect);
  if (!candidates.some((candidate) => stableJson(candidate) === stableJson(visibleState))) {
    throw new Error("Persisted reducer phase and counters are not reachable lifecycle authority");
  }
  if (record.status === "cancelled" && stableJson(record.state) !== stableJson(createIdleState())) {
    throw new Error("Cancelled reducer state is not the exact idle lifecycle state");
  }
}

function prepareLifecycleForProviderEffect(
  state: OrchestratorState,
  kind: ProviderEffectBase["kind"],
  loop: LoopConfig,
): OrchestratorState {
  let prepared = state;
  if (kind === "plan") {
    if (prepared.phase === "awaiting_approval") {
      prepared = nextPhase(prepared, { type: "plan_rejected_by_user" }, loop);
    }
    if (prepared.phase !== "planning" && prepared.phase !== "replanning") {
      throw new Error(`PLAN effect is not reachable from lifecycle phase ${prepared.phase}`);
    }
    return prepared;
  }

  if (prepared.phase === "awaiting_approval") {
    prepared = nextPhase(prepared, { type: "plan_approved" }, loop);
  }
  if (prepared.phase !== "coding") {
    throw new Error(`JUDGE effect is not reachable from lifecycle phase ${prepared.phase}`);
  }
  return nextPhase(prepared, { type: "code_produced" }, loop);
}

function reachableFinalStates(
  record: McpRunRecord,
  replay: OrchestratorState,
  hasUncommittedEffect: boolean,
): OrchestratorState[] {
  if (record.status === "done") {
    return !hasUncommittedEffect && replay.phase === "done" ? [replay] : [];
  }
  const failedRecoveryCancellation = record.status === "cancelled" &&
    record.recovery !== undefined && record.cancelledCheckpoint?.phase === "failed";
  if (record.status === "failed" || failedRecoveryCancellation) {
    if (replay.phase === "failed") return hasUncommittedEffect ? [] : [replay];
    const providerFailureIsReachable = hasUncommittedEffect
      ? ["planning", "judging", "replanning"].includes(replay.phase)
      : replay.phase === "replanning";
    return providerFailureIsReachable
      ? [nextPhase(replay, { type: "provider_failed" }, record.loop)]
      : [];
  }
  if (record.status === "active") {
    if (hasUncommittedEffect) return [replay];
    return stableActiveStates(replay, record.loop);
  }
  if (hasUncommittedEffect) return [replay];
  return stableActiveStates(replay, record.loop);
}

function stableActiveStates(replay: OrchestratorState, loop: LoopConfig): OrchestratorState[] {
  if (replay.phase === "awaiting_approval") {
    return [replay, nextPhase(replay, { type: "plan_approved" }, loop)];
  }
  return replay.phase === "coding" ? [replay] : [];
}

function routingMatchesCommittedEvidence(
  routing: RunRoutingDecision,
  evidence: ProviderAttemptEvidence,
  attempts: readonly ProviderAttemptEvidence[],
): boolean {
  return evidence.phase === "output_committed"
    && routing.stage === (evidence.kind === "plan" ? "plan" : "fast-judge")
    && routing.decisionId === evidence.routingDecision.decisionId
    && routing.policyVersion === evidence.routingDecision.policyVersion
    && routing.policyDigest === evidence.routingDecision.policyDigest
    && routing.configDigest === evidence.routingDecision.configDigest
    && routing.candidatesDigest === evidence.routingDecision.candidatesDigest
    && routing.selectedIndex === evidence.attempt - 1
    && sameRoutingIdentity(routing.selectedIdentity, evidence.identity)
    && routing.thinking === evidence.thinking
    && routing.fallbackHistory.length === attempts.length - 1
    && attempts.slice(0, -1).every((attempt, index) => attempt.phase === "failed"
      && routing.fallbackHistory[index]?.identity === `${attempt.identity.provider}/${attempt.identity.model}`
      && routing.fallbackHistory[index]?.failureCode === attempt.failureCode);
}

function parseCanonical<T>(schema: z.ZodType<T>, unparsed: unknown, label: string): T {
  assertCanonicalJsonData(unparsed, label);
  const parsed = schema.parse(unparsed);
  if (stableJson(parsed) !== stableJson(unparsed)) {
    throw new Error(`${label} is not in canonical persisted form`);
  }
  return parsed;
}

function assertCanonicalJsonData(value: unknown, label: string, path = "$", seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number at ${path}`);
    return;
  }
  if (typeof value !== "object") throw new Error(`${label} contains non-JSON data at ${path}`);
  if (seen.has(value)) throw new Error(`${label} contains a cycle at ${path}`);
  seen.add(value);
  if (Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
      throw new Error(`${label} contains noncanonical array properties at ${path}`);
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new Error(`${label} contains a sparse array at ${path}`);
      assertCanonicalJsonData(value[index], label, `${path}[${index}]`, seen);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} contains a non-plain object at ${path}`);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (["__proto__", "prototype", "constructor"].includes(key)
        || !descriptor.enumerable || !("value" in descriptor) || descriptor.value === undefined) {
        throw new Error(`${label} contains noncanonical property ${path}.${key}`);
      }
      assertCanonicalJsonData(descriptor.value, label, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function pendingRequest(
  identity: RequestIdentity,
  effect: ProviderEffect,
  providerEffectIds: readonly string[] = [effect.effectId],
): Extract<McpRunRequestUpdate, { state: "pending" }> {
  return { state: "pending", ...identity, providerEffectIds: [...providerEffectIds], effect };
}

function settledRequest(
  identity: RequestIdentity,
  outcome: RunOutcome,
  providerEffectIds: readonly string[] = [],
): Extract<McpRunRequestUpdate, { state: "settled" }> {
  return { state: "settled", ...identity, providerEffectIds: [...providerEffectIds], outcome };
}

function settledRequestFor(
  record: Pick<McpRunRecordDraft, "requestAuthority">,
  identity: RequestIdentity,
  outcome: RunOutcome,
): Extract<McpRunRequestUpdate, { state: "settled" }> {
  return settledRequest(identity, outcome, providerEffectIdsFor(record, identity));
}

function providerEffectIdsFor(
  record: Pick<McpRunRecordDraft, "requestAuthority">,
  identity: RequestIdentity,
): string[] {
  if (record.requestAuthority.requestRef !== identity.requestRef
    || record.requestAuthority.requestHash !== identity.requestHash) {
    throw new Error("Provider request authority does not belong to the active mutation");
  }
  return [...record.requestAuthority.providerEffectIds];
}

function requestIdentity(operation: "start" | "advance" | "cancel" | "recover", requestId: string, input: unknown): RequestIdentity {
  const mutationEffect: McpRunMutationEffect = operation === "advance"
    ? {
        operation,
        event: (input as { event: McpRunClientEvent }).event.type,
      }
    : { operation };
  return {
    requestRef: sha256(requestId),
    requestHash: sha256(stableJson({ operation, input })),
    mutationEffect,
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

function assertCancellable(record: McpRunRecord): void {
  if (record.status === "active") return;
  if (record.status === "failed" && record.recovery !== undefined) return;
  throw new Error(`Run ${record.runId} is terminal and immutable`);
}

function assertPhase(record: McpRunRecord, expected: OrchestratorState["phase"], event: McpRunClientEvent["type"]): void {
  if (record.state.phase !== expected) {
    throw new Error(`Event ${event} is not permitted while run ${record.runId} is ${record.state.phase}`);
  }
}

async function requireRun(repository: McpRunRepository, runId: string): Promise<McpRunRecord> {
  const record = recordForAuthority(await repository.get(runId), runId);
  if (!record) throw new Error(`MCP run ${runId} was not found`);
  await assertFrozenCreationAuthority(repository, record);
  return record;
}

async function requireTransactionRun(
  transaction: McpRunTransaction,
  repository: McpRunRepository,
  runId: string,
): Promise<McpRunRecord> {
  const record = recordForAuthority(await transaction.get(), runId);
  if (!record) throw new Error(`MCP run ${runId} was not found`);
  await assertFrozenCreationAuthority(repository, record);
  return record;
}

async function assertFrozenCreationAuthority(
  repository: McpRunRepository,
  record: McpRunRecord,
): Promise<void> {
  const genesis = recordForAuthority(
    await repository.getCheckpoint({ runId: record.runId, revision: 1 }),
    record.runId,
    1,
  );
  if (!genesis) throw new Error(`MCP run ${record.runId} is missing its immutable creation checkpoint`);
  assertGenesisCheckpoint(genesis);
  if (stableJson(creationAuthorityFor(record)) !== stableJson(creationAuthorityFor(genesis))) {
    throw new Error("Persisted MCP run changed authority frozen at creation");
  }
}

function assertGenesisCheckpoint(record: McpRunRecord): void {
  const effect = record.providerEffects[0];
  const authority = record.requestAuthority;
  if (record.revision !== 1
    || record.status !== "active"
    || record.state.phase !== "planning"
    || record.state.plan !== undefined
    || record.state.coderIterations !== 0
    || record.state.consecutiveRejections !== 0
    || record.state.judgeReports.length !== 0
    || record.planVersion !== 1
    || record.routing.length !== 0
    || record.providerAttempts !== 0
    || record.providerEffects.length !== 1
    || !effect
    || effect.kind !== "plan"
    || effect.ordinal !== 1
    || record.providerEvidence.length !== 0
    || record.nextProviderEffectOrdinal !== 2
    || !record.pendingProviderIntent
    || authority.state !== "pending"
    || authority.mutationEffect.operation !== "start"
    || authority.providerEffectIds.length !== 1
    || authority.providerEffectIds[0] !== effect.effectId
    || authority.effect.phase !== "prepared"
    || authority.effect.effectId !== effect.effectId) {
    throw new Error("MCP run revision 1 is not a canonical creation checkpoint");
  }
  assertEffectBaseMatchesLedger(record, authority.effect, "Genesis provider effect");
}

function creationAuthorityFor(record: McpRunRecord): unknown {
  const creationState = record.status === "cancelled" ? record.cancelledCheckpoint : record.state;
  if (!creationState) throw new Error("Cancelled run is missing its creation task authority");
  return {
    version: "mcp-run-creation-authority-v1",
    runId: record.runId,
    taskDigest: sha256(creationState.task),
    repoContextDigest: record.repoContext === undefined ? null : sha256(record.repoContext),
    coderIdentity: record.coderIdentity,
    coderFamily: record.coderFamily ?? null,
    requireDifferentCheckerFamily: record.requireDifferentCheckerFamily,
    taskFeatures: record.taskFeatures ?? null,
    loop: record.loop,
    maxProviderCalls: record.maxProviderCalls,
  };
}

function requireCommitted(record: McpRunRecord | undefined, action: string): McpRunRecord {
  if (!record) throw new Error(`Run revision changed while ${action}; provider outcome is uncertain`);
  return record;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported MCP run event: ${JSON.stringify(value)}`);
}
