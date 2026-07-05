import { describe, expect, it } from "vitest";
import type { LoopConfig } from "../src/core/loop.js";
import {
  createIdleLifecycleState,
  nextStage,
  type LifecycleState,
} from "../src/core/lifecycle.js";

const config: LoopConfig = {
  maxCoderIterations: 3,
  plannerEscalationAfterRejections: 2,
  requirePlanApproval: true,
};

function startState(yolo = false): LifecycleState {
  return nextStage(
    createIdleLifecycleState({ runId: "run-1" }),
    { type: "start", task: "add a lifecycle feature", yolo },
    config,
  );
}

function approvedSpec(yolo = false): LifecycleState {
  const afterSpec = nextStage(startState(yolo), { type: "spec_produced", specPath: ".ai-orchestrator/runs/run-1/spec.md" }, config);
  return yolo ? afterSpec : nextStage(afterSpec, { type: "spec_approved" }, config);
}

function approvedPlan(yolo = false): LifecycleState {
  const afterPlan = nextStage(approvedSpec(yolo), { type: "plan_produced", planPath: ".ai-orchestrator/runs/run-1/plan.md" }, config);
  return yolo ? afterPlan : nextStage(afterPlan, { type: "plan_approved" }, config);
}

function builtOnce(state = approvedPlan()): LifecycleState {
  return nextStage(state, { type: "build_produced" }, config);
}

describe("nextStage", () => {
  it("runs the gated happy path from define to done", () => {
    const defining = startState();
    expect(defining).toMatchObject({ phase: "defining", runId: "run-1", task: "add a lifecycle feature" });

    const awaitingSpec = nextStage(defining, { type: "spec_produced", specPath: "spec.md" }, config);
    expect(awaitingSpec.phase).toBe("awaiting_spec_approval");
    expect(awaitingSpec.specPath).toBe("spec.md");

    const planning = nextStage(awaitingSpec, { type: "spec_approved" }, config);
    const awaitingPlan = nextStage(planning, { type: "plan_produced", planPath: "plan.md" }, config);
    expect(awaitingPlan.phase).toBe("awaiting_plan_approval");
    expect(awaitingPlan.planPath).toBe("plan.md");

    const verifying = builtOnce(nextStage(awaitingPlan, { type: "plan_approved" }, config));
    expect(verifying.phase).toBe("verifying");
    expect(verifying.buildIterations).toBe(1);

    const reviewing = nextStage(verifying, { type: "verdict", stage: "verify", verdict: "approve", reasons: "tests pass" }, config);
    expect(reviewing.phase).toBe("reviewing");

    const shipping = nextStage(reviewing, { type: "verdict", stage: "review", verdict: "approve", reasons: "looks good" }, config);
    expect(shipping.phase).toBe("shipping");

    const awaitingShip = nextStage(shipping, { type: "verdict", stage: "ship", verdict: "approve", reasons: "GO\nRollback: revert commit" }, config);
    expect(awaitingShip.phase).toBe("awaiting_ship_approval");
    expect(awaitingShip.shipReport).toContain("GO");

    const finalizing = nextStage(awaitingShip, { type: "ship_confirmed" }, config);
    expect(finalizing.phase).toBe("finalizing");

    const done = nextStage(finalizing, { type: "finalize_complete" }, config);
    expect(done.phase).toBe("done");
    expect(done.consecutiveRejections).toBe(0);
    expect(done.verdicts).toHaveLength(3);
  });

  it("skips all approval gates under yolo", () => {
    const planning = nextStage(startState(true), { type: "spec_produced" }, config);
    expect(planning.phase).toBe("planning");

    const building = nextStage(planning, { type: "plan_produced" }, config);
    expect(building.phase).toBe("building");

    const verifying = builtOnce(building);
    const reviewing = nextStage(verifying, { type: "verdict", stage: "verify", verdict: "approve", reasons: "ok" }, config);
    const shipping = nextStage(reviewing, { type: "verdict", stage: "review", verdict: "approve", reasons: "ok" }, config);
    const finalizing = nextStage(shipping, { type: "verdict", stage: "ship", verdict: "approve", reasons: "go" }, config);
    expect(finalizing.phase).toBe("finalizing");
  });

  it("respects requirePlanApproval false for spec and plan gates", () => {
    const noApproval: LoopConfig = { ...config, requirePlanApproval: false };
    const defining = nextStage(createIdleLifecycleState({ runId: "run-1" }), { type: "start", task: "task", yolo: false }, noApproval);
    const planning = nextStage(defining, { type: "spec_produced" }, noApproval);
    expect(planning.phase).toBe("planning");
    expect(nextStage(planning, { type: "plan_produced" }, noApproval).phase).toBe("building");
  });

  it("sends a verify rejection back to building and then can continue", () => {
    const verifying = builtOnce();
    const rebuilding = nextStage(
      verifying,
      { type: "verdict", stage: "verify", verdict: "reject", reasons: "test failed", requiredFixes: "fix test" },
      config,
    );
    expect(rebuilding.phase).toBe("building");
    expect(rebuilding.buildIterations).toBe(1);
    expect(rebuilding.consecutiveRejections).toBe(1);

    const reviewing = nextStage(
      builtOnce(rebuilding),
      { type: "verdict", stage: "verify", verdict: "approve", reasons: "fixed" },
      config,
    );
    expect(reviewing.phase).toBe("reviewing");
    expect(reviewing.consecutiveRejections).toBe(0);
  });

  it("escalates two consecutive review rejections to planning while preserving build iterations", () => {
    const reviewing = nextStage(builtOnce(), { type: "verdict", stage: "verify", verdict: "approve", reasons: "ok" }, config);
    const building = nextStage(reviewing, { type: "verdict", stage: "review", verdict: "reject", reasons: "first" }, config);
    const reviewingAgain = nextStage(builtOnce(building), { type: "verdict", stage: "verify", verdict: "approve", reasons: "ok" }, config);
    const planning = nextStage(reviewingAgain, { type: "verdict", stage: "review", verdict: "reject", reasons: "second" }, config);

    expect(planning.phase).toBe("planning");
    expect(planning.buildIterations).toBe(2);
    expect(planning.consecutiveRejections).toBe(0);
    expect(planning.verdicts.filter((verdict) => verdict.verdict === "reject")).toHaveLength(2);
  });

  it("fails when the build iteration cap is reached before another retry", () => {
    const verifying: LifecycleState = {
      ...createIdleLifecycleState({ runId: "run-1" }),
      phase: "verifying",
      task: "task",
      buildIterations: 3,
      consecutiveRejections: 0,
    };

    const failed = nextStage(verifying, { type: "verdict", stage: "verify", verdict: "reject", reasons: "still broken" }, config);
    expect(failed.phase).toBe("failed");
    expect(failed.buildIterations).toBe(3);
  });

  it("treats a ship NO-GO as a rejection", () => {
    const shipping = nextStage(
      nextStage(builtOnce(), { type: "verdict", stage: "verify", verdict: "approve", reasons: "ok" }, config),
      { type: "verdict", stage: "review", verdict: "approve", reasons: "ok" },
      config,
    );

    const building = nextStage(
      shipping,
      { type: "verdict", stage: "ship", verdict: "reject", reasons: "NO-GO: missing rollback", requiredFixes: "Add rollback" },
      config,
    );

    expect(building.phase).toBe("building");
    expect(building.shipReport).toContain("NO-GO");
    expect(building.verdicts.at(-1)).toMatchObject({ stage: "ship", verdict: "reject" });
  });

  it("allows a human to decline shipping after a GO report without failing the run", () => {
    const awaitingShip = nextStage(
      nextStage(
        nextStage(builtOnce(), { type: "verdict", stage: "verify", verdict: "approve", reasons: "ok" }, config),
        { type: "verdict", stage: "review", verdict: "approve", reasons: "ok" },
        config,
      ),
      { type: "verdict", stage: "ship", verdict: "approve", reasons: "GO" },
      config,
    );

    const done = nextStage(awaitingShip, { type: "ship_declined" }, config);
    expect(done.phase).toBe("done");
  });

  it("escalates two consecutive ship rejections through verify and review approvals", () => {
    const firstShipping = nextStage(
      nextStage(builtOnce(), { type: "verdict", stage: "verify", verdict: "approve", reasons: "ok" }, config),
      { type: "verdict", stage: "review", verdict: "approve", reasons: "ok" },
      config,
    );
    const rebuilding = nextStage(firstShipping, { type: "verdict", stage: "ship", verdict: "reject", reasons: "first no-go" }, config);
    const secondShipping = nextStage(
      nextStage(builtOnce(rebuilding), { type: "verdict", stage: "verify", verdict: "approve", reasons: "ok" }, config),
      { type: "verdict", stage: "review", verdict: "approve", reasons: "ok" },
      config,
    );
    const planning = nextStage(secondShipping, { type: "verdict", stage: "ship", verdict: "reject", reasons: "second no-go" }, config);

    expect(planning.phase).toBe("planning");
    expect(planning.consecutiveRejections).toBe(0);
    expect(planning.buildIterations).toBe(2);
  });

  it("prioritizes the build iteration cap over planner escalation", () => {
    const verifying: LifecycleState = {
      ...createIdleLifecycleState({ runId: "run-1" }),
      phase: "verifying",
      task: "task",
      buildIterations: 3,
      consecutiveRejections: 1,
      verdicts: [{ stage: "review", verdict: "reject", reasons: "previous" }],
    };

    const failed = nextStage(verifying, { type: "verdict", stage: "verify", verdict: "reject", reasons: "cap wins" }, config);
    expect(failed.phase).toBe("failed");
    expect(failed.consecutiveRejections).toBe(2);
  });

  it("does not skip the ship gate when approval is disabled but yolo is false", () => {
    const noApproval: LoopConfig = { ...config, requirePlanApproval: false };
    const building = nextStage(
      nextStage(
        nextStage(createIdleLifecycleState({ runId: "run-1" }), { type: "start", task: "task", yolo: false }, noApproval),
        { type: "spec_produced" },
        noApproval,
      ),
      { type: "plan_produced" },
      noApproval,
    );
    const awaitingShip = nextStage(
      nextStage(
        nextStage(building, { type: "build_produced" }, noApproval),
        { type: "verdict", stage: "verify", verdict: "approve", reasons: "ok" },
        noApproval,
      ),
      { type: "verdict", stage: "review", verdict: "approve", reasons: "ok" },
      noApproval,
    );

    expect(nextStage(awaitingShip, { type: "verdict", stage: "ship", verdict: "approve", reasons: "GO" }, noApproval).phase).toBe(
      "awaiting_ship_approval",
    );
  });

  it("handles user rejection of spec and plan approval gates", () => {
    const awaitingSpec = nextStage(startState(), { type: "spec_produced" }, config);
    expect(nextStage(awaitingSpec, { type: "spec_rejected_by_user" }, config).phase).toBe("defining");

    const awaitingPlan = nextStage(approvedSpec(), { type: "plan_produced" }, config);
    expect(nextStage(awaitingPlan, { type: "plan_rejected_by_user" }, config).phase).toBe("planning");
  });

  it("does not mutate the input state", () => {
    const verifying = builtOnce();
    const originalVerdicts = verifying.verdicts;
    const next = nextStage(verifying, { type: "verdict", stage: "verify", verdict: "reject", reasons: "no" }, config);

    expect(verifying.phase).toBe("verifying");
    expect(verifying.verdicts).toBe(originalVerdicts);
    expect(verifying.verdicts).toEqual([]);
    expect(next.verdicts).toHaveLength(1);
  });

  it("ignores invalid events for the current phase", () => {
    const awaitingSpec = nextStage(startState(), { type: "spec_produced" }, config);
    expect(nextStage(awaitingSpec, { type: "build_produced" }, config)).toEqual(awaitingSpec);
    expect(nextStage(awaitingSpec, { type: "verdict", stage: "verify", verdict: "approve", reasons: "late" }, config)).toEqual(awaitingSpec);

    const verifying = builtOnce();
    expect(nextStage(verifying, { type: "verdict", stage: "review", verdict: "approve", reasons: "wrong tool" }, config)).toEqual(verifying);
  });

  it("validates loop config", () => {
    expect(() => nextStage(startState(), { type: "spec_produced" }, { ...config, maxCoderIterations: 0 })).toThrow(
      "loop.maxCoderIterations must be a positive integer",
    );
    expect(() =>
      nextStage(startState(), { type: "spec_produced" }, { ...config, plannerEscalationAfterRejections: 0 }),
    ).toThrow("loop.plannerEscalationAfterRejections must be a positive integer");
  });

  it("cancels back to idle while preserving original model for restoration", () => {
    const building = approvedPlan();
    const withOriginal = {
      ...building,
      originalModel: { provider: "anthropic", id: "claude", thinking: "high" as const },
    };

    const idle = nextStage(withOriginal, { type: "cancelled" }, config);
    expect(idle).toMatchObject({
      phase: "idle",
      runId: "run-1",
      task: "",
      buildIterations: 0,
      consecutiveRejections: 0,
      originalModel: { provider: "anthropic", id: "claude", thinking: "high" },
    });
  });
});
