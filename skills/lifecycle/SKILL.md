---
name: lifecycle
description: Durable DEFINE→PLAN→BUILD→VERIFY→DEBUG→REVIEW→SHIP orchestration with local top-tier model routing, independent checking, on-disk artifacts, approval gates, and restart-safe resume.
---

# Lifecycle

Use this skill for substantial features, refactors, and fixes that need a specification, implementation plan, independent verification, diagnosis, review, and release decision.

## Commands

- `/lifecycle [--yolo] <task>` runs the complete lifecycle.
- `/lifecycle resume` continues the active run from disk.
- `/lifecycle-stop` abandons the active run while preserving its artifacts.
- `/spec [--yolo] <idea>` runs DEFINE only.
- `/plan`, `/build`, `/test`, `/debug`, `/review`, and `/ship` run the exact current stage as a standalone step.

Standalone stages are ordered. If a command does not match `state.json`, do not skip or rewind phases; report the current phase and correct next command.

## Durable memory

The run directory is authoritative:

    .ai-orchestrator/runs/<run-id>/
      spec.md
      plan.md
      debug.md
      state.json
      journal.md

Read stage inputs from these files rather than relying on conversation memory. Record transitions, structured verdicts, model choices, and fallback reasons in the journal. One run may be active per Git worktree.

## Models and maker/checker separation

Every stage uses the configured routing engine. In capability mode, Pi ranks callable local models against stage requirements, profiles, cost ceilings, task evidence, and separation policy. Explicit user/project role identities are pins; built-in identities are preferences. Legacy and capability-shadow modes retain exact legacy selection. `/lifecycle-models [stage]` previews ranking without invoking or selecting a model.

BUILD uses an explicit configured pin or a capability-selected implementer. A model that edits code never grades its own work. VERIFY, REVIEW, DEBUG, and SHIP use eligible independent checkers and remain read-only. DEBUG diagnoses rejection but does not apply the fix; the selected BUILD implementer consumes `debug.md` on the next pass. Fail closed when strict exact or family separation cannot be proven.

## Stage rules

### DEFINE

Clarify objective, users, independently testable acceptance criteria, non-goals, constraints, and always-do/ask-first/never-do boundaries. Explore read-only. Write only the exact `spec.md`. Do not plan implementation or edit source files. Ask grouped clarification questions when requirements are underspecified.

### PLAN

Read the approved specification. Produce dependency-ordered vertical tasks, each with files, acceptance criteria, and exact validation. Write only the exact `plan.md`. Do not implement.

### BUILD

Execute the approved plan in dependency order. Add or update a failing test first when practical, implement the minimum safe change, refactor while green, and run relevant validation. Address every checker finding and DEBUG diagnosis. Do not approve, review, ship, or publish your own work.

### VERIFY (`/test`)

Do not edit files. Run only approved read-only inspection commands and the exact detected test command. Check every acceptance criterion and plan task against the current diff. End with exactly one `verify_verdict` call.

### REVIEW

Do not edit files. Review correctness, readability, architecture fit, security, and performance. Cite concrete file/line evidence. Reject critical findings or important findings that undermine acceptance criteria. End with exactly one `review_verdict` call.

### DEBUG

DEBUG runs after VERIFY or REVIEW rejection. Do not edit files. Reproduce or inspect the failure with permitted read-only commands, distinguish evidence from hypothesis, identify root cause and confidence, recommend the smallest safe fix, name likely files, and give exact validation commands. End with exactly one `debug_diagnosis` call. The extension writes `debug.md`; the next configured or capability-selected BUILD implementer applies the fix.

### SHIP

Do not edit files. Review code quality, security, and test coverage. Use read-only `agent_team` fan-out when available; otherwise check sequentially. Produce GO/NO-GO, blockers, risks, fixes, and a concrete rollback plan. End with exactly one `ship_decision` call.

SHIP never pushes. `--yolo` skips approval pauses but does not grant publication consent. Commit and PR actions follow explicit config and user confirmation. The working tree is never reverted automatically.

## Loop policy

By default, three total BUILD passes are allowed. A VERIFY or REVIEW rejection enters DEBUG before retry/re-plan/failure. Two consecutive checker rejections escalate to PLAN after DEBUG. SHIP NO-GO follows the same retry/re-plan/failure policy directly. DEBUG does not consume a BUILD iteration.

Missing spec/plan/diagnosis or a missing verdict receives one reminder. After that, fail closed or synthesize a rejection as directed by the lifecycle extension. Non-interactive approval gates require an explicitly persisted yolo run.

## Resume, cancellation, and worktrees

On interruption, restore the user's model and active tools but keep disk phase and the run pointer. `/lifecycle resume` continues the saved phase. `/lifecycle-stop` restores model/tools, releases only the owned pointer, and preserves artifacts.

For parallel features, create separate branch worktrees yourself; do not make multiple agents edit one checkout. Worktrees prevent file collisions but do not remove the need for human review.

## Without lifecycle tools

When lifecycle commands or verdict tools are unavailable, reproduce the workflow manually:

1. Create the run directory and maintain `state.json`, `journal.md`, and model-selection evidence after every phase.
2. Use available routing preview/recommendations when present. Ask the user to switch manually to the highest-ranked eligible model for each phase and record the exact identity. A named model is only an example or configured preference.
3. Stop for spec and plan approval unless yolo was explicitly requested.
4. Select a coding-capable maker for BUILD, then switch to a different eligible model or independent agent for read-only VERIFY and REVIEW.
5. On rejection, switch to an independent read-only debugger, write `debug.md`, then return to an eligible BUILD implementer.
6. If strict exact or family separation cannot be satisfied, fail closed and ask for an eligible checker or explicit policy change; never claim independent approval from the maker.
7. Apply the configured iteration and escalation caps.
8. Present SHIP GO/NO-GO and rollback plan. Never commit, push, or open a PR without explicit consent.

If policy permits degraded separation, disclose it prominently and require stronger human verification. Record the user decision rather than silently continuing.
