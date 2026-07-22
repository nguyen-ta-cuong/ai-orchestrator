import { describe, expect, it, vi } from "vitest";
import { applyWorkflowTransition } from "../src/adapters/piWorkflow/graphExecution.js";
import { createIdleState, nextPhase } from "../src/core/loop.js";
import { fastWorkflowGraph } from "../src/core/workflowGraphs.js";

const config = { maxCoderIterations: 3, plannerEscalationAfterRejections: 2, requirePlanApproval: true };

describe("fast graph adapter", () => {
  it.each(["graph-shadow", "graph"] as const)("preserves reducer transitions in %s", async (engine) => {
    const state = createIdleState({ phase: "coding", task: "task" });
    const trace = vi.fn();
    const next = await applyWorkflowTransition({
      definition: fastWorkflowGraph(), engine, state, event: { type: "code_produced" },
      reduce: (value, event) => nextPhase(value, event, config), ownsState: () => true, onTrace: trace,
    });
    expect(next.phase).toBe("judging");
    expect(trace).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "coding", nextNodeId: "judging", engine }));
  });
});
