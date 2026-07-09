import type { ThinkingLevel } from "./config.js";

export type Phase =
  | "idle"
  | "planning"
  | "awaiting_approval"
  | "coding"
  | "judging"
  | "replanning"
  | "done"
  | "failed";

export type Verdict = "approve" | "reject";

export interface JudgeReport {
  verdict: Verdict;
  reasons: string;
  requiredFixes?: string;
}

export interface OriginalModelState {
  provider: string;
  id: string;
  thinking: ThinkingLevel;
}

export interface OrchestratorState {
  phase: Phase;
  task: string;
  plan?: string;
  coderIterations: number;
  consecutiveRejections: number;
  judgeReports: JudgeReport[];
  yolo: boolean;
  originalModel?: OriginalModelState;
}

export interface LoopConfig {
  maxCoderIterations: number;
  plannerEscalationAfterRejections: number;
  requirePlanApproval: boolean;
}

export type LoopEvent =
  | { type: "start"; task: string; yolo: boolean }
  | { type: "plan_produced"; plan?: string }
  | { type: "plan_approved" }
  | { type: "plan_rejected_by_user" }
  | { type: "code_produced" }
  | { type: "verdict"; verdict: Verdict; reasons?: string; requiredFixes?: string }
  | { type: "cancelled" };

export const DEFAULT_LOOP_CONFIG: LoopConfig = {
  maxCoderIterations: 3,
  plannerEscalationAfterRejections: 2,
  requirePlanApproval: true,
};

export type RejectedBuildOutcome = "fail" | "replan" | "retry";

export function decideRejectedBuildOutcome(
  coderIterations: number,
  consecutiveRejections: number,
  config: LoopConfig,
): RejectedBuildOutcome {
  validateLoopConfig(config);
  if (coderIterations >= config.maxCoderIterations) return "fail";
  if (consecutiveRejections >= config.plannerEscalationAfterRejections) return "replan";
  return "retry";
}

export function createIdleState(overrides: Partial<OrchestratorState> = {}): OrchestratorState {
  const state: OrchestratorState = {
    phase: "idle",
    task: "",
    coderIterations: 0,
    consecutiveRejections: 0,
    judgeReports: [],
    yolo: false,
    ...overrides,
  };
  state.judgeReports = overrides.judgeReports ? [...overrides.judgeReports] : [];
  return state;
}

export function nextPhase(
  state: OrchestratorState,
  event: LoopEvent,
  config: LoopConfig = DEFAULT_LOOP_CONFIG,
): OrchestratorState {
  validateLoopConfig(config);

  if (event.type === "start") {
    if (state.phase !== "idle" && state.phase !== "done" && state.phase !== "failed") {
      return cloneState(state);
    }
    return createIdleState({ phase: "planning", task: event.task, yolo: event.yolo });
  }

  if (event.type === "cancelled") {
    return createIdleState({
      originalModel: state.originalModel ? { ...state.originalModel } : undefined,
    });
  }

  const next = cloneState(state);

  switch (event.type) {
    case "plan_produced": {
      if (next.phase !== "planning" && next.phase !== "replanning") {
        return next;
      }
      if (event.plan !== undefined) {
        next.plan = event.plan;
      }
      next.phase = config.requirePlanApproval && !next.yolo ? "awaiting_approval" : "coding";
      return next;
    }

    case "plan_approved": {
      if (next.phase !== "awaiting_approval") {
        return next;
      }
      next.phase = "coding";
      return next;
    }

    case "plan_rejected_by_user": {
      if (next.phase !== "awaiting_approval") {
        return next;
      }
      next.phase = "planning";
      return next;
    }

    case "code_produced": {
      if (next.phase !== "coding") {
        return next;
      }
      next.coderIterations += 1;
      next.phase = "judging";
      return next;
    }

    case "verdict": {
      if (next.phase !== "judging") {
        return next;
      }

      next.judgeReports.push({
        verdict: event.verdict,
        reasons: event.reasons ?? "",
        ...(event.requiredFixes !== undefined ? { requiredFixes: event.requiredFixes } : {}),
      });

      if (event.verdict === "approve") {
        next.phase = "done";
        next.consecutiveRejections = 0;
        return next;
      }

      next.consecutiveRejections += 1;

      const outcome = decideRejectedBuildOutcome(next.coderIterations, next.consecutiveRejections, config);
      if (outcome === "fail") {
        next.phase = "failed";
        return next;
      }

      if (outcome === "replan") {
        next.phase = "replanning";
        next.consecutiveRejections = 0;
        return next;
      }

      next.phase = "coding";
      return next;
    }

    default:
      return assertNever(event);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled loop event: ${JSON.stringify(value)}`);
}

function cloneState(state: OrchestratorState): OrchestratorState {
  return {
    ...state,
    judgeReports: state.judgeReports.map((report) => ({ ...report })),
    originalModel: state.originalModel ? { ...state.originalModel } : undefined,
  };
}

function validateLoopConfig(config: LoopConfig): void {
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
