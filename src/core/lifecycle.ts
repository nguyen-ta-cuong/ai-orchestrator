import { decideRejectedBuildOutcome, type LoopConfig } from "./loop.js";
import type { LifecycleRoutedStage, ThinkingLevel } from "./config.js";

export type LifecyclePhase =
  | "idle"
  | "defining"
  | "awaiting_spec_approval"
  | "planning"
  | "awaiting_plan_approval"
  | "building"
  | "verifying"
  | "reviewing"
  | "debugging"
  | "shipping"
  | "awaiting_ship_approval"
  | "finalizing"
  | "done"
  | "failed";

export type LifecycleVerdictStage = "verify" | "review" | "ship";
export type LifecycleVerdict = "approve" | "reject";

export interface LifecycleOriginalModelState {
  provider: string;
  id: string;
  thinking: ThinkingLevel;
}

export interface LifecycleStageVerdict {
  stage: LifecycleVerdictStage;
  verdict: LifecycleVerdict;
  reasons: string;
  requiredFixes?: string;
}

export interface LifecycleModelSelection {
  stage: LifecycleRoutedStage | "build";
  provider: string;
  model: string;
  family?: string;
  thinking: ThinkingLevel;
  reason: string;
  selectedAt: string;
  routing?: {
    decisionId: string;
    engine: "legacy" | "capability-shadow" | "capability";
    policyVersion: string;
    profileVersion?: string;
    taskFeaturesHash: string;
    selectedRank: number;
    score?: number;
    separation: "not-applicable" | "different-model" | "different-family";
    fallbackCount: number;
    attemptedModels: string[];
    failureCategories: string[];
  };
}

export interface LifecycleState {
  version: 1;
  runId: string;
  phase: LifecyclePhase;
  task: string;
  specPath?: string;
  planPath?: string;
  debugPath?: string;
  debugDiagnosisVerdictIndex?: number;
  buildIterations: number;
  consecutiveRejections: number;
  verdicts: LifecycleStageVerdict[];
  modelSelections: LifecycleModelSelection[];
  baselinePaths?: string[];
  baselineStagedPaths?: string[];
  modelRestored?: boolean;
  finalization?: { commitSha?: string; prUrl?: string };
  shipReport?: string;
  yolo: boolean;
  originalModel?: LifecycleOriginalModelState;
}

export type LifecycleEvent =
  | { type: "start"; task: string; yolo: boolean }
  | { type: "spec_produced"; specPath?: string }
  | { type: "spec_approved" }
  | { type: "spec_rejected_by_user" }
  | { type: "plan_produced"; planPath?: string }
  | { type: "plan_approved" }
  | { type: "plan_rejected_by_user" }
  | { type: "build_produced" }
  | { type: "debug_produced"; debugPath?: string }
  | {
      type: "verdict";
      stage: LifecycleVerdictStage;
      verdict: LifecycleVerdict;
      reasons?: string;
      requiredFixes?: string;
    }
  | { type: "ship_confirmed" }
  | { type: "ship_declined" }
  | { type: "finalize_complete" }
  | { type: "cancelled" };

export function createIdleLifecycleState(overrides: Partial<LifecycleState> = {}): LifecycleState {
  const state: LifecycleState = {
    version: 1,
    runId: "",
    phase: "idle",
    task: "",
    buildIterations: 0,
    consecutiveRejections: 0,
    verdicts: [],
    modelSelections: [],
    modelRestored: true,
    yolo: false,
    ...overrides,
  };
  state.verdicts = overrides.verdicts ? overrides.verdicts.map((verdict) => ({ ...verdict })) : [];
  state.modelSelections = overrides.modelSelections
    ? overrides.modelSelections.map((selection) => ({
      ...selection,
      routing: selection.routing ? {
        ...selection.routing,
        attemptedModels: [...selection.routing.attemptedModels],
        failureCategories: [...selection.routing.failureCategories],
      } : undefined,
    }))
    : [];
  state.baselinePaths = overrides.baselinePaths ? [...overrides.baselinePaths] : undefined;
  state.baselineStagedPaths = overrides.baselineStagedPaths ? [...overrides.baselineStagedPaths] : undefined;
  state.finalization = overrides.finalization ? { ...overrides.finalization } : undefined;
  state.originalModel = overrides.originalModel ? { ...overrides.originalModel } : undefined;
  return state;
}

export function nextStage(
  state: LifecycleState,
  event: LifecycleEvent,
  config: LoopConfig,
): LifecycleState {
  validateLifecycleLoopConfig(config);

  if (event.type === "start") {
    if (state.phase !== "idle" && state.phase !== "done" && state.phase !== "failed") {
      return cloneLifecycleState(state);
    }
    return createIdleLifecycleState({
      runId: state.runId,
      phase: "defining",
      task: event.task,
      yolo: event.yolo,
    });
  }

  if (event.type === "cancelled") {
    return createIdleLifecycleState({
      runId: state.runId,
      originalModel: state.originalModel ? { ...state.originalModel } : undefined,
    });
  }

  const next = cloneLifecycleState(state);

  switch (event.type) {
    case "spec_produced": {
      if (next.phase !== "defining") return next;
      if (event.specPath !== undefined) next.specPath = event.specPath;
      next.phase = config.requirePlanApproval && !next.yolo ? "awaiting_spec_approval" : "planning";
      return next;
    }

    case "spec_approved": {
      if (next.phase !== "awaiting_spec_approval") return next;
      next.phase = "planning";
      return next;
    }

    case "spec_rejected_by_user": {
      if (next.phase !== "awaiting_spec_approval") return next;
      next.phase = "defining";
      return next;
    }

    case "plan_produced": {
      if (next.phase !== "planning") return next;
      if (event.planPath !== undefined) next.planPath = event.planPath;
      next.phase = config.requirePlanApproval && !next.yolo ? "awaiting_plan_approval" : "building";
      return next;
    }

    case "plan_approved": {
      if (next.phase !== "awaiting_plan_approval") return next;
      next.phase = "building";
      return next;
    }

    case "plan_rejected_by_user": {
      if (next.phase !== "awaiting_plan_approval") return next;
      next.phase = "planning";
      return next;
    }

    case "build_produced": {
      if (next.phase !== "building") return next;
      next.buildIterations += 1;
      next.phase = "verifying";
      return next;
    }

    case "debug_produced": {
      if (next.phase !== "debugging") return next;
      if (event.debugPath !== undefined) next.debugPath = event.debugPath;
      return applyRejectedBuildOutcome(next, config);
    }

    case "verdict": {
      if (!isVerdictValidForCurrentPhase(next.phase, event.stage)) return next;

      const previousRejection = findLastRejection(next.verdicts);
      next.verdicts.push({
        stage: event.stage,
        verdict: event.verdict,
        reasons: event.reasons ?? "",
        ...(event.requiredFixes !== undefined ? { requiredFixes: event.requiredFixes } : {}),
      });
      if (event.stage === "ship") {
        next.shipReport = event.reasons ?? "";
      }

      if (event.verdict === "approve") {
        if (shouldResetRejectionsOnApproval(previousRejection, event.stage)) {
          next.consecutiveRejections = 0;
        }
        next.phase = event.stage === "ship" && next.yolo ? "finalizing" : nextPhaseAfterApproval(event.stage);
        return next;
      }

      next.consecutiveRejections += 1;
      if (event.stage === "verify" || event.stage === "review") {
        next.phase = "debugging";
        return next;
      }

      return applyRejectedBuildOutcome(next, config);
    }

    case "ship_confirmed": {
      if (next.phase !== "awaiting_ship_approval") return next;
      next.phase = "finalizing";
      return next;
    }

    case "ship_declined": {
      if (next.phase !== "awaiting_ship_approval") return next;
      next.phase = "done";
      return next;
    }

    case "finalize_complete": {
      if (next.phase !== "finalizing") return next;
      next.phase = "done";
      return next;
    }

    default:
      return assertNever(event);
  }
}

function applyRejectedBuildOutcome(state: LifecycleState, config: LoopConfig): LifecycleState {
  const outcome = decideRejectedBuildOutcome(state.buildIterations, state.consecutiveRejections, config);
  if (outcome === "fail") {
    state.phase = "failed";
    return state;
  }
  if (outcome === "replan") {
    state.phase = "planning";
    state.consecutiveRejections = 0;
    return state;
  }
  state.phase = "building";
  return state;
}

function shouldResetRejectionsOnApproval(
  previousRejection: LifecycleStageVerdict | undefined,
  stage: LifecycleVerdictStage,
): boolean {
  return previousRejection === undefined || stageRank(stage) >= stageRank(previousRejection.stage);
}

function findLastRejection(verdicts: LifecycleStageVerdict[]): LifecycleStageVerdict | undefined {
  for (let index = verdicts.length - 1; index >= 0; index -= 1) {
    if (verdicts[index].verdict === "reject") {
      return verdicts[index];
    }
  }
  return undefined;
}

function stageRank(stage: LifecycleVerdictStage): number {
  switch (stage) {
    case "verify":
      return 0;
    case "review":
      return 1;
    case "ship":
      return 2;
    default:
      return assertNever(stage);
  }
}

function nextPhaseAfterApproval(stage: LifecycleVerdictStage): LifecyclePhase {
  switch (stage) {
    case "verify":
      return "reviewing";
    case "review":
      return "shipping";
    case "ship":
      return "awaiting_ship_approval";
    default:
      return assertNever(stage);
  }
}

function isVerdictValidForCurrentPhase(phase: LifecyclePhase, stage: LifecycleVerdictStage): boolean {
  return (
    (phase === "verifying" && stage === "verify") ||
    (phase === "reviewing" && stage === "review") ||
    (phase === "shipping" && stage === "ship")
  );
}

function cloneLifecycleState(state: LifecycleState): LifecycleState {
  return {
    ...state,
    verdicts: state.verdicts.map((verdict) => ({ ...verdict })),
    modelSelections: state.modelSelections.map((selection) => ({
      ...selection,
      routing: selection.routing ? {
        ...selection.routing,
        attemptedModels: [...selection.routing.attemptedModels],
        failureCategories: [...selection.routing.failureCategories],
      } : undefined,
    })),
    baselinePaths: state.baselinePaths ? [...state.baselinePaths] : undefined,
    baselineStagedPaths: state.baselineStagedPaths ? [...state.baselineStagedPaths] : undefined,
    finalization: state.finalization ? { ...state.finalization } : undefined,
    originalModel: state.originalModel ? { ...state.originalModel } : undefined,
  };
}

function validateLifecycleLoopConfig(config: LoopConfig): void {
  if (!Number.isInteger(config.maxCoderIterations) || config.maxCoderIterations < 1) {
    throw new Error("loop.maxCoderIterations must be a positive integer");
  }
  if (
    !Number.isInteger(config.plannerEscalationAfterRejections) ||
    config.plannerEscalationAfterRejections < 1
  ) {
    throw new Error("loop.plannerEscalationAfterRejections must be a positive integer");
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled lifecycle value: ${JSON.stringify(value)}`);
}
