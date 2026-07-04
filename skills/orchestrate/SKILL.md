---
name: orchestrate
description: Plan→code→judge orchestration. Use when the user asks to run /orchestrate <task>, coordinate planner/coder/judge phases, or explain the ai-orchestrator workflow.
---

# Orchestrate

Use `/orchestrate <task>` to run the automated Plan → Code → Judge loop.

## Phase behavior

1. **Planner**: inspect the repository and produce a numbered implementation plan only. Do not edit files.
2. **Approval gate**: wait for the user to approve the plan unless `--yolo` is enabled.
3. **Coder**: implement the approved plan, edit files, run the validation commands from the plan, and fix failures.
4. **Judge**: review `git diff` and `git diff --staged` against the task and plan. Run the detected project test command when available. Do not edit files. Finish by calling `judge_verdict` exactly once.
5. **Loop policy**: on reject, return to coding with the judge feedback; after two consecutive rejections, re-plan; after three total coder iterations, stop and leave the working tree as-is.

## Commands

- `/orchestrate <task>`: start a run.
- `/orchestrate --yolo <task>`: start a run and skip plan approval.
- `/orchestrate-stop`: cancel the active run and restore the original model/thinking level.

When participating in an orchestrated phase, follow the current phase instructions exactly and avoid doing work assigned to a different phase.
