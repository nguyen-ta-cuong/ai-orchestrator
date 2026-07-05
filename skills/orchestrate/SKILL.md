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
- The judge phase must finish by calling `judge_verdict` exactly once.

## Cursor with MCP tools

When `orchestrator_plan` and `orchestrator_judge` tools are available:

1. Call `orchestrator_plan` with the task and repository context.
2. Show the returned plan and wait for explicit user approval before editing.
3. Implement the approved plan as the coder.
4. Run relevant tests, gather `git diff` and `git diff --staged`, then call `orchestrator_judge`.
5. Follow the returned `nextAction`, `nextIteration`, and `nextConsecutiveRejections` exactly. Do not apply your own loop counter policy.
6. Maintain a `judgeReports` list of `{ verdict, reasons, requiredFixes }` objects. When `nextAction` is `replan`, call `orchestrator_plan` with the original `task`, the `previousPlan`, a `diffSummary`, and the full `judgeReports` list. Reset `judgeReports` only after the revised plan is approved.

## Without orchestrator tools

If the MCP tools are unavailable, follow the same loop manually:

1. **Planner**: inspect the repository and produce a numbered implementation plan only. Do not edit files. Ask the user to approve the plan.
2. **Coder**: after approval, implement the plan, run validation commands from the plan, and fix failures.
3. **Judge**: review the current diff against the task and plan using this checklist: plan adherence, correctness, tests passing or justified, no unrelated changes, and no obvious security/regression risk.
4. **Loop policy**: keep `iteration` and `consecutiveRejections` counters in the conversation. On rejection, address every required fix and judge again. After two consecutive rejections, revise the plan and ask for approval again. After three total coder iterations, stop and report the remaining fixes. If project config states different loop caps, use those values instead.
5. Prompt the user to switch models at phase boundaries when appropriate (planner/reviewer model for planning/judging, coder model for implementation). Proceed with the current model if the user declines.

When participating in any phase, follow the current phase instructions exactly and avoid doing work assigned to a different phase.
