---
name: orchestrate
description: Plan→code→judge orchestration for Pi and Cursor. Use when the user asks to run /orchestrate, use ai-orchestrator MCP tools, or follow the manual Plan → Code → Judge workflow.
---

# Orchestrate

Use the AI Orchestrator Plan → Code → Judge loop for non-trivial implementation tasks.

## Pi package workflow

When running inside Pi with the extension installed:

- `/orchestrate <task>` starts a run.
- `/orchestrate --yolo <task>` starts a run and skips plan approval.
- `/orchestrate-stop` cancels the active run and restores the original model/thinking level.
- `/lifecycle-models fast-judge` previews local capability routing without invoking a model.
- The judge phase must finish by calling `judge_verdict` exactly once.

Pi performs configured model switching and records routing evidence. Capability-shadow remains observational; capability mode activates ranking. The maker must not judge its own work.

## Cursor with MCP tools

When `orchestrator_plan`, `orchestrator_models`, and `orchestrator_judge` are available:

1. Call `orchestrator_models` for `plan` and inspect the trusted server-side route. It does not select a Cursor host model.
2. Call `orchestrator_plan`, record its actual routing metadata, show the plan, and wait for explicit approval.
3. Manually select and record a configured coding-capable Cursor model as exact `coderIdentity`, then implement and test the approved plan.
4. Gather `git diff`, `git diff --staged`, and test output. Call `orchestrator_models` for `fast-judge` with `coderIdentity` to confirm an eligible server-side independent checker.
5. Call `orchestrator_judge` with `coderIdentity`, then record its selected checker and fallback history. If strict separation has no eligible checker, stop; do not self-approve.
6. Follow `nextAction`, `nextIteration`, and `nextConsecutiveRejections` exactly. Maintain the full `judgeReports` list. For `replan`, send the original task, `previousPlan`, the latest `diffSummary`, and all reports, then obtain approval for the revision.

Cursor instructions and MCP cannot switch Cursor's host model. MCP routes only its own planner/judge API calls from the trusted user catalog and never exposes endpoints or key state. Named models are examples or configured preferences, not universal requirements.

## Without orchestrator tools

If MCP tools are unavailable, follow the same controls manually:

1. **Plan:** inspect read-only, produce a numbered implementation plan, record the selected planner identity, and wait for approval.
2. **Build:** switch manually to a configured coding-capable maker, record its exact identity, implement the approved plan, and run its validation commands.
3. **Check:** switch to a different model or independent agent, record the checker identity, and review the current diff against plan adherence, correctness, tests, unrelated changes, and security/regression risk. The maker cannot approve itself.
4. **Fail closed:** when project policy requires independent checking and no independent checker is available, stop and ask the user to provide one or change policy explicitly. Do not describe a same-model review as independent.
5. **Loop:** track `iteration` and `consecutiveRejections`. Address all fixes on rejection. Re-plan and re-approve after two consecutive rejections; stop after three total coding passes unless project configuration sets stricter caps.
6. Preserve approval, commit, PR, and publication gates. Leave the working tree as-is on failure.

When participating in a phase, follow that phase only. Worktree isolation prevents collisions but does not replace human review.
