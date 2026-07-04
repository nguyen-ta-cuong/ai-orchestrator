import { describe, expect, it } from "vitest";
import { createIdleState, type LoopConfig, type OrchestratorState, nextPhase } from "../src/core/loop.js";

const config: LoopConfig = {
  maxCoderIterations: 3,
  plannerEscalationAfterRejections: 2,
  requirePlanApproval: true,
};

function planningState(overrides: Partial<OrchestratorState> = {}): OrchestratorState {
  return {
    phase: "planning",
    task: "add a feature",
    coderIterations: 0,
    consecutiveRejections: 0,
    judgeReports: [],
    yolo: false,
    ...overrides,
  };
}

function approvePlan(state = planningState()): OrchestratorState {
  return nextPhase(nextPhase(state, { type: "plan_produced", plan: "1. Do it" }, config), {
    type: "plan_approved",
  }, config);
}

function completeCoding(state: OrchestratorState): OrchestratorState {
  return nextPhase(state, { type: "code_produced" }, config);
}

describe("nextPhase", () => {
  it("starts a run from idle/done/failed and ignores start mid-run", () => {
    const startEvent = { type: "start" as const, task: "ship it", yolo: true };
    const expectedStarted = {
      phase: "planning",
      task: "ship it",
      coderIterations: 0,
      consecutiveRejections: 0,
      judgeReports: [],
      yolo: true,
    };

    const dirtyIdle = createIdleState({
      plan: "old plan",
      coderIterations: 2,
      consecutiveRejections: 1,
      judgeReports: [{ verdict: "reject", reasons: "old" }],
      originalModel: { provider: "openai", id: "gpt-5", thinking: "medium" },
    });
    expect(nextPhase(dirtyIdle, startEvent, config)).toEqual(expectedStarted);

    const doneState: OrchestratorState = {
      ...dirtyIdle,
      phase: "done",
      task: "old task",
    };
    expect(nextPhase(doneState, startEvent, config)).toEqual(expectedStarted);

    const failedState: OrchestratorState = {
      ...dirtyIdle,
      phase: "failed",
      task: "old task",
    };
    expect(nextPhase(failedState, startEvent, config)).toEqual(expectedStarted);

    const midRun = approvePlan();
    expect(nextPhase(midRun, { type: "start", task: "new task", yolo: false }, config)).toEqual(midRun);
  });

  it("moves from approved first attempt to done", () => {
    const judging = completeCoding(approvePlan());
    const done = nextPhase(judging, { type: "verdict", verdict: "approve", reasons: "looks good" }, config);

    expect(done.phase).toBe("done");
    expect(done.coderIterations).toBe(1);
    expect(done.consecutiveRejections).toBe(0);
    expect(done.judgeReports).toEqual([{ verdict: "approve", reasons: "looks good" }]);
  });

  it("sends the first reject back to coding", () => {
    const judging = completeCoding(approvePlan());
    const retry = nextPhase(
      judging,
      { type: "verdict", verdict: "reject", reasons: "bug", requiredFixes: "fix bug" },
      config,
    );

    expect(retry.phase).toBe("coding");
    expect(retry.coderIterations).toBe(1);
    expect(retry.consecutiveRejections).toBe(1);
    expect(retry.judgeReports.at(-1)).toEqual({
      verdict: "reject",
      reasons: "bug",
      requiredFixes: "fix bug",
    });
  });

  it("escalates to replanning after two consecutive rejections instead of coding", () => {
    const firstRetry = nextPhase(
      completeCoding(approvePlan()),
      { type: "verdict", verdict: "reject", reasons: "first" },
      config,
    );
    const secondJudging = completeCoding(firstRetry);
    const replanning = nextPhase(
      secondJudging,
      { type: "verdict", verdict: "reject", reasons: "second" },
      config,
    );

    expect(replanning.phase).toBe("replanning");
    expect(replanning.coderIterations).toBe(2);
    expect(replanning.consecutiveRejections).toBe(0);
    expect(replanning.judgeReports).toHaveLength(2);
  });

  it("resets consecutive rejection count and can approve after a retry", () => {
    const retry = nextPhase(
      completeCoding(approvePlan()),
      { type: "verdict", verdict: "reject", reasons: "first" },
      config,
    );
    const done = nextPhase(
      completeCoding(retry),
      { type: "verdict", verdict: "approve", reasons: "fixed" },
      config,
    );

    expect(done.phase).toBe("done");
    expect(done.coderIterations).toBe(2);
    expect(done.consecutiveRejections).toBe(0);
  });

  it("fails after three total coder iterations with a final reject", () => {
    const stateAtThirdJudging: OrchestratorState = {
      phase: "judging",
      task: "add a feature",
      plan: "plan",
      coderIterations: 3,
      consecutiveRejections: 0,
      judgeReports: [],
      yolo: false,
    };

    const failed = nextPhase(
      stateAtThirdJudging,
      { type: "verdict", verdict: "reject", reasons: "still broken" },
      config,
    );

    expect(failed.phase).toBe("failed");
    expect(failed.coderIterations).toBe(3);
    expect(failed.judgeReports.at(-1)?.reasons).toBe("still broken");
  });

  it("prioritizes the total iteration cap over planner escalation", () => {
    const stateAtThirdJudging: OrchestratorState = {
      phase: "judging",
      task: "add a feature",
      plan: "plan",
      coderIterations: 3,
      consecutiveRejections: 1,
      judgeReports: [{ verdict: "reject", reasons: "previous" }],
      yolo: false,
    };

    const failed = nextPhase(
      stateAtThirdJudging,
      { type: "verdict", verdict: "reject", reasons: "still broken" },
      config,
    );

    expect(failed.phase).toBe("failed");
    expect(failed.consecutiveRejections).toBe(2);
  });

  it("skips awaiting approval when yolo is enabled", () => {
    const next = nextPhase(
      planningState({ yolo: true }),
      { type: "plan_produced", plan: "1. Do it" },
      config,
    );

    expect(next.phase).toBe("coding");
    expect(next.plan).toBe("1. Do it");
  });

  it("resets rejection counter on replan while preserving total coder iterations", () => {
    const replanning: OrchestratorState = {
      phase: "replanning",
      task: "add a feature",
      plan: "old plan",
      coderIterations: 2,
      consecutiveRejections: 0,
      judgeReports: [
        { verdict: "reject", reasons: "first" },
        { verdict: "reject", reasons: "second" },
      ],
      yolo: true,
    };

    const coding = nextPhase(replanning, { type: "plan_produced", plan: "revised plan" }, config);

    expect(coding.phase).toBe("coding");
    expect(coding.coderIterations).toBe(2);
    expect(coding.consecutiveRejections).toBe(0);
    expect(coding.plan).toBe("revised plan");
  });

  it("ignores phase-specific events received in the wrong phase", () => {
    const awaitingApproval = nextPhase(planningState(), { type: "plan_produced", plan: "initial" }, config);
    expect(nextPhase(awaitingApproval, { type: "plan_produced", plan: "late plan" }, config)).toEqual(awaitingApproval);
    expect(nextPhase(awaitingApproval, { type: "code_produced" }, config)).toEqual(awaitingApproval);
    expect(nextPhase(awaitingApproval, { type: "verdict", verdict: "approve", reasons: "late" }, config)).toEqual(
      awaitingApproval,
    );

    const judging = completeCoding(approvePlan());
    expect(nextPhase(judging, { type: "plan_approved" }, config)).toEqual(judging);
  });

  it("validates loop config", () => {
    expect(() => nextPhase(planningState(), { type: "plan_produced", plan: "x" }, { ...config, maxCoderIterations: 0 })).toThrow(
      "loop.maxCoderIterations must be a positive integer",
    );
    expect(() =>
      nextPhase(planningState(), { type: "plan_produced", plan: "x" }, { ...config, plannerEscalationAfterRejections: 0 }),
    ).toThrow("loop.plannerEscalationAfterRejections must be a positive integer");
  });

  it("cancels back to idle while preserving the original model for restoration", () => {
    const idle = nextPhase(
      approvePlan(planningState({ originalModel: { provider: "openai", id: "gpt-5", thinking: "medium" } })),
      { type: "cancelled" },
      config,
    );

    expect(idle).toMatchObject({
      phase: "idle",
      task: "",
      coderIterations: 0,
      consecutiveRejections: 0,
      yolo: false,
      judgeReports: [],
      originalModel: { provider: "openai", id: "gpt-5", thinking: "medium" },
    });
  });
});
