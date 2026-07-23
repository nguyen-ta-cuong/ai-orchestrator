import {
  assertBuildDispatchCheckpoint,
  buildEffectIdentity,
  type BuildDispatchCheckpoint,
  type BuildRunningAction,
  type BuildWorkerBudgetReservation,
} from "../core/buildExecution.js";
import type { RunPaths } from "./artifacts.js";
import type { GraphExecutionState } from "../core/scheduler.js";
import {
  appendBuildDispatchCheckpoint,
  readBuildDispatchLedger,
  writeBuildEffectReceipt,
} from "./buildArtifacts.js";

export interface BuildActionSettlement {
  outcome: "succeeded" | "failed";
  recordedAt: string;
  receipt?: unknown;
}

export interface BuildActionExecutor {
  /** Called only after the exact action intent is durable. */
  execute(action: Readonly<BuildRunningAction>, context?: Readonly<BuildActionExecutionContext>): Promise<BuildActionSettlement>;
  /** Called instead of execute whenever a crash left the action outcome uncertain. */
  reconcile(action: Readonly<BuildRunningAction>, context?: Readonly<BuildActionExecutionContext>): Promise<BuildActionSettlement | undefined>;
}

export interface BuildActionExecutionContext {
  workerBudgetReservation?: Readonly<BuildWorkerBudgetReservation>;
  graphState?: Readonly<GraphExecutionState>;
  signal?: AbortSignal;
}

export interface DurableBuildActionResult {
  checkpoint: Readonly<BuildDispatchCheckpoint>;
  ledgerHead: string;
  reconciled: boolean;
}

/**
 * Execute one inner BUILD effect beneath the scheduler's single outer BUILD
 * reservation. This append-only ledger never overwrites scheduler sideEffect;
 * the caller seals and binds the ledger head in the outer result receipt.
 */
export async function executeDurableBuildAction(
  paths: RunPaths,
  actionValue: Readonly<BuildRunningAction>,
  executor: Readonly<BuildActionExecutor>,
  options: Readonly<{ owner: string; recordedAt: string; context?: Readonly<BuildActionExecutionContext> }>,
): Promise<DurableBuildActionResult> {
  const action = normalizeAction(actionValue);
  assertIsoTimestamp(options.recordedAt, "BUILD action intent timestamp");
  if (!executor || typeof executor.execute !== "function" || typeof executor.reconcile !== "function") {
    throw new Error("BUILD action executor must provide execute and reconcile functions");
  }
  let ledger = readBuildDispatchLedger(paths, action.planVersion, action.nodeId);
  let current = ledger.checkpoints.find(({ idempotencyKey }) => idempotencyKey === action.idempotencyKey);
  let reconciled = false;
  let createdIntent = false;
  if (!current) {
    if (action.kind === "reconcile-unknown") {
      throw new Error("BUILD reconciliation requires an existing durable unresolved intent");
    }
    const intent = checkpointFor(action, "intent-recorded", options.recordedAt);
    ledger = appendBuildDispatchCheckpoint(paths, intent, { owner: options.owner, expectedHead: ledger.head });
    current = ledger.checkpoints.find(({ idempotencyKey }) => idempotencyKey === action.idempotencyKey)!;
    createdIntent = true;
  } else if (current.status === "succeeded" || current.status === "failed") {
    if (!ledger.head) throw new Error("BUILD action terminal checkpoint is missing its ledger head");
    return Object.freeze({ checkpoint: current, ledgerHead: ledger.head, reconciled: false });
  }

  let settlement: BuildActionSettlement | undefined;
  if (createdIntent) settlement = await executor.execute(action, options.context);
  else {
    settlement = await executor.reconcile(action, options.context);
    reconciled = true;
  }
  if (settlement === undefined) {
    if (!ledger.head) throw new Error("BUILD action intent is missing its ledger head");
    return Object.freeze({ checkpoint: current, ledgerHead: ledger.head, reconciled });
  }
  const normalized = normalizeSettlement(settlement);
  let resultRef: string | undefined;
  if (normalized.outcome === "succeeded") {
    const receipt = writeBuildEffectReceipt(paths, action, normalized.receipt, { owner: options.owner });
    resultRef = receipt.sha256;
  }
  const terminal = checkpointFor(action, normalized.outcome, normalized.recordedAt, resultRef);
  const next = appendBuildDispatchCheckpoint(paths, terminal, { owner: options.owner, expectedHead: ledger.head });
  const checkpoint = next.checkpoints.find(({ idempotencyKey }) => idempotencyKey === action.idempotencyKey)!;
  if (!next.head) throw new Error("BUILD action result is missing its ledger head");
  return Object.freeze({ checkpoint, ledgerHead: next.head, reconciled });
}

function normalizeAction(value: Readonly<BuildRunningAction>): BuildRunningAction {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !new Set([
        "materialize-worktree",
        "invoke-worker",
        "validate-outputs",
        "record-human-integration",
        "cleanup-worktree",
        "reconcile-unknown",
      ]).has(value.kind)) {
    throw new Error("BUILD running action is invalid");
  }
  const expected = buildEffectIdentity({
    runId: value.runId,
    planVersion: value.planVersion,
    planHash: value.planHash,
    nodeId: value.nodeId,
    visit: value.visit,
    attempt: value.attempt,
    purpose: value.purpose,
    ordinal: value.ordinal,
    workspace: value.workspace,
  });
  if (expected.idempotencyKey !== value.idempotencyKey || expected.requestRef !== value.requestRef) {
    throw new Error("BUILD running action identity is invalid");
  }
  const expectedKind = value.purpose === "worktree"
    ? "materialize-worktree"
    : value.purpose === "worker"
      ? "invoke-worker"
      : value.purpose === "validator"
        ? "validate-outputs"
        : value.purpose === "human-integration"
          ? "record-human-integration"
          : value.purpose === "cleanup"
            ? "cleanup-worktree"
            : undefined;
  if (value.kind !== "reconcile-unknown" && value.kind !== expectedKind) {
    throw new Error("BUILD running action kind does not match its effect purpose");
  }
  return Object.freeze({ ...expected, kind: value.kind });
}

function checkpointFor(
  action: Readonly<BuildRunningAction>,
  status: BuildDispatchCheckpoint["status"],
  recordedAt: string,
  resultRef?: string,
): BuildDispatchCheckpoint {
  const checkpoint = {
    schemaVersion: 1 as const,
    runId: action.runId,
    planVersion: action.planVersion,
    planHash: action.planHash,
    nodeId: action.nodeId,
    visit: action.visit,
    attempt: action.attempt,
    purpose: action.purpose,
    ordinal: action.ordinal,
    workspace: action.workspace,
    idempotencyKey: action.idempotencyKey,
    requestRef: action.requestRef,
    status,
    recordedAt,
    ...(resultRef === undefined ? {} : { resultRef }),
  };
  return assertBuildDispatchCheckpoint(checkpoint);
}

function normalizeSettlement(value: unknown): BuildActionSettlement {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("BUILD action settlement must be an object");
  const record = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.values(Object.getOwnPropertyDescriptors(value));
  if ((prototype !== Object.prototype && prototype !== null) || descriptors.some((descriptor) => !("value" in descriptor))) {
    throw new Error("BUILD action settlement must contain only own data properties");
  }
  const extras = Reflect.ownKeys(record).filter((key) => typeof key !== "string" || !["outcome", "recordedAt", "receipt"].includes(key));
  if (extras.length > 0 || (record.outcome !== "succeeded" && record.outcome !== "failed")) {
    throw new Error("BUILD action settlement fields or outcome are invalid");
  }
  assertIsoTimestamp(record.recordedAt, "BUILD action settlement timestamp");
  if (record.outcome === "succeeded" && record.receipt === undefined) {
    throw new Error("Successful BUILD action settlement requires an immutable receipt");
  }
  if (record.outcome === "failed" && record.receipt !== undefined) {
    throw new Error("Failed BUILD action settlement cannot fabricate a success receipt");
  }
  return {
    outcome: record.outcome,
    recordedAt: record.recordedAt,
    ...(record.receipt === undefined ? {} : { receipt: record.receipt }),
  };
}

function assertIsoTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
}
