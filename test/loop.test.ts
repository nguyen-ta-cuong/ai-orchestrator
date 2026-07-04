import { describe, expect, it } from "vitest";
import { type LoopConfig, type OrchestratorState, nextPhase } from "../src/core/loop.js";

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

  it("cancels back to idle", () => {
    const idle = nextPhase(approvePlan(), { type: "cancelled" }, config);

    expect(idle).toMatchObject({
      phase: "idle",
      task: "",
      coderIterations: 0,
      consecutiveRejections: 0,
      yolo: false,
      judgeReports: [],
    });
  });
});
