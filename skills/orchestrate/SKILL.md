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

When `orchestrator_run_start`, `orchestrator_run_get`, `orchestrator_run_advance`, `orchestrator_run_recover`, and `orchestrator_run_cancel` are available:

1. Select and record the Cursor host coder as exact `coderIdentity`; `orchestrator_models` may preview server-side routes but cannot select the host coder.
2. Start with a fresh `requestId`. Keep the returned opaque `runId` and exact `revision`, show the proposed plan, and wait for explicit approval.
3. Advance approval with a new request ID and the exact revision. Implement only when the server returns `currentNode: "coding"`.
4. Gather unstaged/staged diff and test output, then submit `code_result_submitted` at the exact current revision. The server owns iteration/rejection counters, independent checker routing, re-plans, and caps.
5. Follow `currentNode`, `permittedEvents`, `requiredAction`, and terminal/blocked status exactly. Approve every replacement plan separately and address all required fixes before resubmission.
6. Call `orchestrator_run_recover` only after the server has durably closed a provider failure or checker rejection. Do not supply a category or diagnosis: those come from server evidence and independent read-only DEBUG. After recovery, execute only the returned `permittedEvents`: submit code for a typed repair, approve an immutable successor plan, inspect a blocked safety gate, or stop at terminal status.
7. Reuse a request ID only for the identical body after a lost response. On conflict, read the run and reconcile before issuing a changed mutation under a new ID. Cancel explicitly with `orchestrator_run_cancel`.

Cursor instructions and MCP cannot switch Cursor's host model. Durable user-owned run authority survives MCP restart and exposes no provider endpoints or key state. The stateless plan/judge tools remain compatibility-only. Named models are configured preferences, not universal requirements.

## Without orchestrator tools

If MCP tools are unavailable, follow the same controls manually:

1. **Plan:** inspect read-only, produce a numbered implementation plan, record the selected planner identity, and wait for approval.
2. **Build:** switch manually to a configured coding-capable maker, record its exact identity, implement the approved plan, and run its validation commands.
3. **Check:** switch to a different model or independent agent, record the checker identity, and review the current diff against plan adherence, correctness, tests, unrelated changes, and security/regression risk. The maker cannot approve itself.
4. **Fail closed:** when project policy requires independent checking and no independent checker is available, stop and ask the user to provide one or change policy explicitly. Do not describe a same-model review as independent.
5. **Loop:** track `iteration` and `consecutiveRejections`. Address all fixes on rejection. Re-plan and re-approve after two consecutive rejections; stop after three total coding passes unless project configuration sets stricter caps.
6. Preserve approval, commit, PR, and publication gates. Leave the working tree as-is on failure.

When participating in a phase, follow that phase only. Worktree isolation prevents collisions but does not replace human review.
