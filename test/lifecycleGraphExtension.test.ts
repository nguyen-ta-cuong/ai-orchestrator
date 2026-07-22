import { describe, expect, it, vi } from "vitest";
import { applyWorkflowTransition } from "../src/adapters/piWorkflow/graphExecution.js";
import { createIdleLifecycleState, nextStage } from "../src/core/lifecycle.js";
import { lifecycleWorkflowGraph } from "../src/core/workflowGraphs.js";

const config = { maxCoderIterations: 3, plannerEscalationAfterRejections: 2, requirePlanApproval: true };

describe("lifecycle graph adapter", () => {
  it("runs an active graph node once and rejects stale ownership", async () => {
    const state = createIdleLifecycleState({ phase: "building", task: "task", runId: "run-1" });
    const trace = vi.fn();
    const next = await applyWorkflowTransition({
      definition: lifecycleWorkflowGraph(), engine: "graph", state, event: { type: "build_produced" },
      reduce: (value, event) => nextStage(value, event, config), ownsState: (value) => value.runId === "run-1", onTrace: trace,
    });
    expect(next.phase).toBe("verifying");
    expect(trace).toHaveBeenCalledOnce();
    await expect(applyWorkflowTransition({
      definition: lifecycleWorkflowGraph(), engine: "graph", state, event: { type: "build_produced" },
      reduce: (value, event) => nextStage(value, event, config), ownsState: () => false,
    })).rejects.toThrow("Stale graph execution cursor");
  });
});
