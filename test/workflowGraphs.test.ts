import { describe, expect, it } from "vitest";
import { compileGraph, renderGraphMermaid, type GraphDefinition } from "../src/core/graph.js";
import {
  createIdleLifecycleState,
  nextStage,
  type LifecycleEvent,
  type LifecyclePhase,
  type LifecycleState,
} from "../src/core/lifecycle.js";
import {
  createIdleState,
  nextPhase,
  type LoopConfig,
  type LoopEvent,
  type OrchestratorState,
  type Phase,
} from "../src/core/loop.js";
import { fastWorkflowGraph, lifecycleWorkflowGraph } from "../src/core/workflowGraphs.js";

const config: LoopConfig = {
  maxCoderIterations: 3,
  plannerEscalationAfterRejections: 2,
  requirePlanApproval: true,
};

const noApproval: LoopConfig = { ...config, requirePlanApproval: false };

function edgeKey(from: string, to: string, event: string, guard?: string): string {
  return `${from}|${to}|${event}|${guard ?? ""}`;
}

function declaredEdges(definition: GraphDefinition): string[] {
  return definition.edges.map((edge) => edgeKey(edge.from, edge.to, edge.event, edge.guard)).sort();
}

describe("fastWorkflowGraph", () => {
  it("compiles, renders deterministically, and exactly characterizes every reducer transition", () => {
    const definition = fastWorkflowGraph();
    const compiled = compileGraph(definition);
    expect(renderGraphMermaid(compiled)).toBe(renderGraphMermaid(compileGraph(fastWorkflowGraph())));

    const observed = new Set<string>();
    const record = (
      state: OrchestratorState,
      event: LoopEvent,
      guard: string | undefined,
      selectedConfig: LoopConfig = config,
    ): OrchestratorState => {
      const next = nextPhase(state, event, selectedConfig);
      expect(next.phase, `${state.phase}/${event.type}/${guard}`).not.toBe(state.phase);
      observed.add(edgeKey(state.phase, next.phase, event.type, guard));
      return next;
    };

    const idle = createIdleState();
    record(idle, { type: "start", task: "task", yolo: false }, "start-new-run");
    for (const phase of ["done", "failed"] as const) {
      record(createIdleState({ phase }), { type: "start", task: "again", yolo: false }, "restart-terminal-run");
    }

    const planning = fastState("planning");
    const awaiting = record(planning, { type: "plan_produced", plan: "plan" }, "human-approval-required");
    record(fastState("planning", { yolo: true }), { type: "plan_produced" }, "approval-bypassed");
    record(fastState("replanning"), { type: "plan_produced" }, "human-approval-required");
    record(fastState("replanning", { yolo: true }), { type: "plan_produced" }, "approval-bypassed");
    record(awaiting, { type: "plan_approved" }, "human-approved");
    record(awaiting, { type: "plan_rejected_by_user" }, "human-declined");
    record(fastState("coding"), { type: "code_produced" }, undefined);
    record(fastState("judging", { coderIterations: 1 }), { type: "verdict", verdict: "approve" }, "judge-approved");
    record(fastState("judging", { coderIterations: 1 }), { type: "verdict", verdict: "reject" }, "judge-retry");
    record(
      fastState("judging", { coderIterations: 2, consecutiveRejections: 1 }),
      { type: "verdict", verdict: "reject" },
      "judge-replan",
    );
    record(
      fastState("judging", { coderIterations: 3, consecutiveRejections: 1 }),
      { type: "verdict", verdict: "reject" },
      "build-cap-exhausted",
    );
    for (const phase of ["planning", "awaiting_approval", "coding", "judging", "replanning", "done", "failed"] as const) {
      record(fastState(phase), { type: "cancelled" }, "run-cancelled");
    }

    expect([...observed].sort()).toEqual(declaredEdges(definition));
  });

  it("ignores every event that is invalid for each phase and keeps terminal states stable", () => {
    const events: LoopEvent[] = [
      { type: "start", task: "task", yolo: false },
      { type: "plan_produced" },
      { type: "plan_approved" },
      { type: "plan_rejected_by_user" },
      { type: "code_produced" },
      { type: "verdict", verdict: "approve" },
    ];
    const allowed: Record<Phase, Set<LoopEvent["type"]>> = {
      idle: new Set(["start"]),
      planning: new Set(["plan_produced"]),
      awaiting_approval: new Set(["plan_approved", "plan_rejected_by_user"]),
      coding: new Set(["code_produced"]),
      judging: new Set(["verdict"]),
      replanning: new Set(["plan_produced"]),
      done: new Set(["start"]),
      failed: new Set(["start"]),
    };
    for (const phase of Object.keys(allowed) as Phase[]) {
      const state = fastState(phase);
      for (const event of events) {
        if (!allowed[phase].has(event.type)) expect(nextPhase(state, event, config)).toEqual(state);
      }
    }
    for (const phase of ["done", "failed"] as const) {
      const terminal = fastState(phase);
      for (const event of events.filter(({ type }) => type !== "start")) expect(nextPhase(terminal, event, config)).toEqual(terminal);
    }
  });
});

describe("lifecycleWorkflowGraph", () => {
  it("compiles and exactly characterizes approval, DEBUG, cap, NO-GO, and terminal routes", () => {
    const definition = lifecycleWorkflowGraph();
    const compiled = compileGraph(definition);
    expect(renderGraphMermaid(compiled)).toBe(renderGraphMermaid(compileGraph(lifecycleWorkflowGraph())));

    const observed = new Set<string>();
    const record = (
      state: LifecycleState,
      event: LifecycleEvent,
      guard: string | undefined,
      selectedConfig: LoopConfig = config,
    ): LifecycleState => {
      const next = nextStage(state, event, selectedConfig);
      expect(next.phase, `${state.phase}/${event.type}/${guard}`).not.toBe(state.phase);
      observed.add(edgeKey(state.phase, next.phase, event.type, guard));
      return next;
    };

    record(lifecycleState("idle"), { type: "start", task: "task", yolo: false }, "start-new-run");
    for (const phase of ["done", "failed"] as const) {
      record(lifecycleState(phase), { type: "start", task: "again", yolo: false }, "restart-terminal-run");
    }
    record(lifecycleState("defining"), { type: "spec_produced" }, "human-approval-required");
    record(lifecycleState("defining", { yolo: true }), { type: "spec_produced" }, "approval-bypassed");
    record(lifecycleState("defining"), { type: "spec_produced" }, "approval-bypassed", noApproval);
    record(lifecycleState("awaiting_spec_approval"), { type: "spec_approved" }, "human-approved");
    record(lifecycleState("awaiting_spec_approval"), { type: "spec_rejected_by_user" }, "human-declined");
    record(lifecycleState("planning"), { type: "plan_produced" }, "human-approval-required");
    record(lifecycleState("planning", { yolo: true }), { type: "plan_produced" }, "approval-bypassed");
    record(lifecycleState("planning"), { type: "plan_produced" }, "approval-bypassed", noApproval);
    record(lifecycleState("awaiting_plan_approval"), { type: "plan_approved" }, "human-approved");
    record(lifecycleState("awaiting_plan_approval"), { type: "plan_rejected_by_user" }, "human-declined");
    record(lifecycleState("building"), { type: "build_produced" }, undefined);
    record(lifecycleState("verifying"), approve("verify"), "verify-approved");
    record(lifecycleState("verifying"), reject("verify"), "verify-rejected");
    record(lifecycleState("reviewing"), approve("review"), "review-approved");
    record(lifecycleState("reviewing"), reject("review"), "review-rejected");
    record(lifecycleState("debugging", { buildIterations: 1, consecutiveRejections: 1 }), { type: "debug_produced" }, "build-retry");
    record(lifecycleState("debugging", { buildIterations: 2, consecutiveRejections: 2 }), { type: "debug_produced" }, "build-replan");
    record(lifecycleState("debugging", { buildIterations: 3, consecutiveRejections: 1 }), { type: "debug_produced" }, "build-cap-exhausted");
    record(lifecycleState("shipping"), approve("ship"), "ship-go");
    record(lifecycleState("shipping", { yolo: true }), approve("ship"), "ship-go-yolo");
    record(lifecycleState("shipping", { buildIterations: 1 }), reject("ship"), "ship-no-go-retry");
    record(
      lifecycleState("shipping", { buildIterations: 2, consecutiveRejections: 1 }),
      reject("ship"),
      "ship-no-go-replan",
    );
    record(
      lifecycleState("shipping", { buildIterations: 3, consecutiveRejections: 1 }),
      reject("ship"),
      "build-cap-exhausted",
    );
    record(lifecycleState("awaiting_ship_approval"), { type: "ship_confirmed" }, "human-approved");
    record(lifecycleState("awaiting_ship_approval"), { type: "ship_declined" }, "human-declined");
    record(lifecycleState("finalizing"), { type: "finalize_complete" }, undefined);
    for (const phase of lifecycleActiveAndTerminalPhases) {
      record(lifecycleState(phase), { type: "cancelled" }, "run-cancelled");
    }

    // Approval bypass has two reducer causes but intentionally compiles to one deterministic route.
    expect([...observed].sort()).toEqual(declaredEdges(definition));
  });

  it("ignores invalid phase/event pairs and keeps terminal states stable", () => {
    const events: LifecycleEvent[] = [
      { type: "start", task: "task", yolo: false },
      { type: "spec_produced" },
      { type: "spec_approved" },
      { type: "spec_rejected_by_user" },
      { type: "plan_produced" },
      { type: "plan_approved" },
      { type: "plan_rejected_by_user" },
      { type: "build_produced" },
      { type: "debug_produced" },
      approve("verify"),
      approve("review"),
      approve("ship"),
      { type: "ship_confirmed" },
      { type: "ship_declined" },
      { type: "finalize_complete" },
    ];
    const allowed: Record<LifecyclePhase, Set<LifecycleEvent["type"]>> = {
      idle: new Set(["start"]),
      defining: new Set(["spec_produced"]),
      awaiting_spec_approval: new Set(["spec_approved", "spec_rejected_by_user"]),
      planning: new Set(["plan_produced"]),
      awaiting_plan_approval: new Set(["plan_approved", "plan_rejected_by_user"]),
      building: new Set(["build_produced"]),
      verifying: new Set(["verdict"]),
      reviewing: new Set(["verdict"]),
      debugging: new Set(["debug_produced"]),
      shipping: new Set(["verdict"]),
      awaiting_ship_approval: new Set(["ship_confirmed", "ship_declined"]),
      finalizing: new Set(["finalize_complete"]),
      done: new Set(["start"]),
      failed: new Set(["start"]),
    };
    for (const phase of Object.keys(allowed) as LifecyclePhase[]) {
      const state = lifecycleState(phase);
      for (const event of events) {
        const wrongVerdictStage = event.type === "verdict"
          && !((phase === "verifying" && event.stage === "verify")
            || (phase === "reviewing" && event.stage === "review")
            || (phase === "shipping" && event.stage === "ship"));
        if (!allowed[phase].has(event.type) || wrongVerdictStage) expect(nextStage(state, event, config)).toEqual(state);
      }
    }
    for (const phase of ["done", "failed"] as const) {
      const terminal = lifecycleState(phase);
      for (const event of events.filter(({ type }) => type !== "start")) expect(nextStage(terminal, event, config)).toEqual(terminal);
    }
  });
});

const lifecycleActiveAndTerminalPhases: LifecyclePhase[] = [
  "defining",
  "awaiting_spec_approval",
  "planning",
  "awaiting_plan_approval",
  "building",
  "verifying",
  "reviewing",
  "debugging",
  "shipping",
  "awaiting_ship_approval",
  "finalizing",
  "done",
  "failed",
];

function fastState(phase: Phase, overrides: Partial<OrchestratorState> = {}): OrchestratorState {
  return createIdleState({ phase, task: "task", ...overrides });
}

function lifecycleState(phase: LifecyclePhase, overrides: Partial<LifecycleState> = {}): LifecycleState {
  return createIdleLifecycleState({ runId: "run-1", phase, task: "task", ...overrides });
}

function approve(stage: "verify" | "review" | "ship"): LifecycleEvent {
  return { type: "verdict", stage, verdict: "approve", reasons: "ok" };
}

function reject(stage: "verify" | "review" | "ship"): LifecycleEvent {
  return { type: "verdict", stage, verdict: "reject", reasons: "not ready" };
}
