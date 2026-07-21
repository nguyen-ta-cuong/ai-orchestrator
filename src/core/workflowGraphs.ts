import type { GraphDefinition, GraphEdgeDefinition, GraphNodeDefinition, SideEffectClass } from "./graph.js";

const DEFAULT_TIMEOUT_MS = 300_000;

export function fastWorkflowGraph(): GraphDefinition {
  return {
    schemaVersion: 1,
    id: "fast-workflow",
    version: "1.0.0",
    kind: "state-machine",
    entry: "idle",
    nodes: [
      node("idle", "wait-for-task", "none"),
      node("planning", "produce-plan", "write", ["task"], ["plan"]),
      node("awaiting_approval", "request-plan-approval", "external", ["plan"], ["approval-decision"]),
      node("coding", "produce-code", "write", ["plan"], ["source-changes"]),
      node("judging", "judge-code", "read", ["source-changes"], ["judge-report"]),
      node("replanning", "revise-plan", "write", ["judge-report"], ["plan"]),
      node("done", "finish-run", "none", [], ["run-result"], true),
      node("failed", "fail-run", "none", [], ["run-failure"], true),
    ],
    edges: withRunBounds([
      edge("idle", "planning", "start", "start-new-run"),
      edge("done", "planning", "start", "restart-terminal-run"),
      edge("failed", "planning", "start", "restart-terminal-run"),
      edge("planning", "awaiting_approval", "plan_produced", "human-approval-required"),
      edge("planning", "coding", "plan_produced", "approval-bypassed"),
      edge("replanning", "awaiting_approval", "plan_produced", "human-approval-required"),
      edge("replanning", "coding", "plan_produced", "approval-bypassed"),
      edge("awaiting_approval", "coding", "plan_approved", "human-approved"),
      edge("awaiting_approval", "planning", "plan_rejected_by_user", "human-declined"),
      edge("coding", "judging", "code_produced"),
      edge("judging", "done", "verdict", "judge-approved"),
      edge("judging", "coding", "verdict", "judge-retry"),
      edge("judging", "replanning", "verdict", "judge-replan"),
      edge("judging", "failed", "verdict", "build-cap-exhausted"),
      ...cancellationEdges(["planning", "awaiting_approval", "coding", "judging", "replanning", "done", "failed"]),
    ]),
  };
}

export function lifecycleWorkflowGraph(): GraphDefinition {
  return {
    schemaVersion: 1,
    id: "lifecycle-workflow",
    version: "1.0.0",
    kind: "state-machine",
    entry: "idle",
    nodes: [
      node("idle", "wait-for-lifecycle-task", "none"),
      node("defining", "produce-spec", "write", ["task"], ["spec"]),
      node("awaiting_spec_approval", "request-spec-approval", "external", ["spec"], ["approval-decision"]),
      node("planning", "produce-lifecycle-plan", "write", ["spec"], ["plan"]),
      node("awaiting_plan_approval", "request-plan-approval", "external", ["plan"], ["approval-decision"]),
      node("building", "build-plan", "write", ["plan"], ["source-changes"]),
      node("verifying", "verify-build", "read", ["source-changes"], ["verify-verdict"]),
      node("reviewing", "review-build", "read", ["verify-verdict"], ["review-verdict"]),
      node("debugging", "diagnose-rejection", "read", ["checker-rejection"], ["debug-diagnosis"]),
      node("shipping", "decide-shipping", "read", ["review-verdict"], ["ship-decision"]),
      node("awaiting_ship_approval", "request-publication-consent", "external", ["ship-decision"], ["approval-decision"]),
      node("finalizing", "finalize-run", "external", ["approval-decision"], ["finalization-result"]),
      node("done", "finish-lifecycle-run", "none", [], ["run-result"], true),
      node("failed", "fail-lifecycle-run", "none", [], ["run-failure"], true),
    ],
    edges: withRunBounds([
      edge("idle", "defining", "start", "start-new-run"),
      edge("done", "defining", "start", "restart-terminal-run"),
      edge("failed", "defining", "start", "restart-terminal-run"),
      edge("defining", "awaiting_spec_approval", "spec_produced", "human-approval-required"),
      edge("defining", "planning", "spec_produced", "approval-bypassed"),
      edge("awaiting_spec_approval", "planning", "spec_approved", "human-approved"),
      edge("awaiting_spec_approval", "defining", "spec_rejected_by_user", "human-declined"),
      edge("planning", "awaiting_plan_approval", "plan_produced", "human-approval-required"),
      edge("planning", "building", "plan_produced", "approval-bypassed"),
      edge("awaiting_plan_approval", "building", "plan_approved", "human-approved"),
      edge("awaiting_plan_approval", "planning", "plan_rejected_by_user", "human-declined"),
      edge("building", "verifying", "build_produced"),
      edge("verifying", "reviewing", "verdict", "verify-approved"),
      edge("verifying", "debugging", "verdict", "verify-rejected"),
      edge("reviewing", "shipping", "verdict", "review-approved"),
      edge("reviewing", "debugging", "verdict", "review-rejected"),
      edge("debugging", "building", "debug_produced", "build-retry"),
      edge("debugging", "planning", "debug_produced", "build-replan"),
      edge("debugging", "failed", "debug_produced", "build-cap-exhausted"),
      edge("shipping", "awaiting_ship_approval", "verdict", "ship-go"),
      edge("shipping", "finalizing", "verdict", "ship-go-yolo"),
      edge("shipping", "building", "verdict", "ship-no-go-retry"),
      edge("shipping", "planning", "verdict", "ship-no-go-replan"),
      edge("shipping", "failed", "verdict", "build-cap-exhausted"),
      edge("awaiting_ship_approval", "finalizing", "ship_confirmed", "human-approved"),
      edge("awaiting_ship_approval", "done", "ship_declined", "human-declined"),
      edge("finalizing", "done", "finalize_complete"),
      ...cancellationEdges([
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
      ]),
    ]),
  };
}

function node(
  id: string,
  handler: string,
  sideEffect: SideEffectClass,
  inputContracts: string[] = [],
  outputContracts: string[] = [],
  terminal = false,
): GraphNodeDefinition {
  return {
    id,
    handler,
    ...(terminal ? { terminal: true } : {}),
    inputContracts,
    outputContracts,
    sideEffect,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    retryBudget: sideEffect === "none" ? 0 : 2,
  };
}

function edge(from: string, to: string, event: string, guard?: string): GraphEdgeDefinition {
  return { from, to, event, ...(guard === undefined ? {} : { guard }) };
}

function cancellationEdges(phases: string[]): GraphEdgeDefinition[] {
  return phases.map((phase) => edge(phase, "idle", "cancelled", "run-cancelled"));
}

function withRunBounds(edges: GraphEdgeDefinition[]): GraphEdgeDefinition[] {
  // Restart and cancellation make every workflow edge part of a bounded run cycle.
  // Plan 0013 will enforce this declared monotonic budget at runtime.
  return edges.map((definition) => ({ ...definition, boundedBy: "run-transition-budget" }));
}
