# AI Orchestrator user guide

AI Orchestrator keeps the maker away from the checker. Planning, implementation, diagnosis, verification, review, and publication decisions have separate responsibilities, explicit gates, and bounded retries.

Complete [setup](setup.md) first, then choose the smallest workflow that gives your task enough control:

| Workflow | Use when | Durable resume |
| --- | --- | --- |
| Pi `/orchestrate` | A focused change needs plan approval and an independent judge | No |
| Pi `/lifecycle` | A substantial change needs specification, verification, diagnosis, review, and recovery | Yes |
| Cursor with MCP | Cursor remains the coder while trusted server-side models plan and judge | Client-managed notes only |
| Cursor without MCP | MCP is prohibited and model handoffs can be performed manually | Client-managed notes only |

## Operating rules

These rules apply to every surface:

1. Approve the plan before source edits. `--yolo` skips supported human approval pauses; it does not bypass verification, retry limits, separation, cost/privacy policy, or publication consent.
2. Record the actual maker identity. A checker must differ from the latest maker; configured family separation may be stricter.
3. Treat structured verdicts and routing metadata as evidence, not permission to skip gates.
4. DEBUG diagnoses. BUILD edits. A checker or diagnosis phase never mutates source.
5. Stop when no eligible independent checker exists. Never describe same-model self-review as independent.
6. AI Orchestrator never pushes. Commits and pull requests require configured support and fresh explicit confirmation.
7. Inspect the working tree before publishing. The orchestrator never stashes, resets, cleans, checks out, or reverts it automatically.

## Pi fast path

Start a Plan → Code → Judge run:

```text
/orchestrate add a --version flag to the CLI
```

Commands:

```text
/orchestrate <task>          Start with plan approval
/orchestrate --yolo <task>   Skip only the plan-approval dialog
/orchestrate-stop            Cancel and restore the prior Pi state
```

The fast path:

1. Routes and runs a planner.
2. Shows the plan and waits for approval unless `--yolo` was used.
3. Routes a coding-capable maker and gives it constrained read/search/edit/write tools.
4. Runs the detected test command through the independent checking phase.
5. Requires `judge_verdict` with `approve` or actionable `reject` output.
6. Returns required fixes to BUILD on rejection. Two consecutive rejections re-plan by default; three total coding passes stop the run by default.
7. Restores the model, thinking level, and active tools that were selected before the run.

The fast path keeps session-visible state but does not create a durable lifecycle directory. If Pi exits during a fast run, inspect the tree and start a new run rather than assuming the conversation is authoritative recovery state.

## Pi durable lifecycle

Start a durable run:

```text
/lifecycle implement resumable export processing
```

Normal flow:

```text
DEFINE → approve → PLAN → approve → BUILD → VERIFY → REVIEW → SHIP
                                           ↘ reject → DEBUG → BUILD / PLAN / failed
```

### Commands

```text
/lifecycle [--yolo] <task>      Start and drive a full run
/lifecycle resume               Resume the authoritative active run
/lifecycle migrate-routing      Confirm changed routing policy for an unfinished run
/lifecycle-stop                 Cancel and preserve the run directory
/lifecycle-models [stage]       Preview routing without invoking a model
/lifecycle-routing-report       Show evidence-bounded recommendations
/lifecycle-routing-apply N      Confirm recommendation N as trusted user policy
/lifecycle-routing-rollback ID  Confirm exact rollback of an applied recommendation
/spec [--yolo] <idea>           Run DEFINE at the saved phase
/plan                           Run PLAN at the saved phase
/build                          Run BUILD at the saved phase
/test                           Run VERIFY at the saved phase
/debug                          Run DEBUG at the saved phase
/review                         Run REVIEW at the saved phase
/ship                           Run SHIP at the saved phase
```

Standalone stage commands do not skip, rewind, or replace the phase recorded in `state.json`.

### Stage responsibilities

- **DEFINE:** clarify objective, users, acceptance criteria, non-goals, constraints, and action boundaries. It may write only `spec.md`.
- **PLAN:** turn the approved specification into dependency-ordered, testable implementation tasks. It may write only `plan.md`.
- **BUILD:** implement the approved plan and checker/DEBUG findings with constrained source read/search/edit/write tools. It cannot use arbitrary shell or connector tools.
- **VERIFY:** run the exact detected test command and check acceptance criteria. It is source-read-only and ends with `verify_verdict`.
- **DEBUG:** investigate a VERIFY or REVIEW rejection without editing source, then end with `debug_diagnosis`; the extension writes `debug.md` for the next BUILD pass.
- **REVIEW:** inspect correctness, maintainability, architecture, security, and performance without editing, then end with `review_verdict`.
- **SHIP:** produce a structured GO/NO-GO decision and rollback plan. It is read-only and never pushes.

### Durable state and recovery

The repository, not the conversation, remembers lifecycle truth:

```text
.ai-orchestrator/
  active-run.json
  current.lock
  runs/
    current                         active run pointer
    <run-id>/
      spec.md
      plan.md
      debug.md
      state.json
      journal.md
      routing.jsonl
      evidence.jsonl
      execution.lock               transient process lease

~/.ai-orchestrator/routing-evidence/
  events.jsonl                     minimized cross-run analytical evidence
  budget.jsonl                     strict cumulative budget ledger
  recommendations/<id>.json        apply/rollback transaction records
```

`state.json`, the journal, run evidence, and trusted-user evidence are persistent until removed. `current.lock` and `execution.lock` are transient ownership/lease files. Only one lifecycle run may own a Git worktree, including commands started from different subdirectories. State writes are atomic, locks and process leases are reclaimable after a proven stale owner, and corrupt or ambiguous ownership fails closed.

Use `/lifecycle resume` after an interruption. Resume re-reads state after obtaining the execution lease, restores any pending structured checker verdict, reconciles recoverable commit/PR intent, and continues only from the saved phase. Missing artifacts, policy drift, unsafe paths, unavailable models, unknown budget state, or ownership loss pause/fail rather than silently guessing.

`/lifecycle-stop` preserves artifacts but releases the active pointer. It is cancellation, not a promise that the stopped run can later be resumed.

### Routing policy changes during a run

A lifecycle run freezes the complete routing/role policy identity when routing begins. If trusted or project policy changes before the run finishes, resume pauses.

1. Review the changed configuration.
2. Run `/lifecycle migrate-routing`.
3. Confirm adoption in the dialog.
4. Run `/lifecycle resume` if the phase did not continue automatically.

Past decisions remain evidence; migration affects the unfinished phase and later selections.

### Routing reports and recommendations

`/lifecycle-routing-report` is read-only. It groups only compatible policy/profile versions and requires the configured minimum evidence before recommending a preference.

`/lifecycle-routing-apply <number>` is a global trusted-user change, not a project-local tweak. The confirmation identifies the stage, evidence category, sample basis, tradeoff/proposal, and global scope. On approval it updates `~/.ai-orchestrator/config.json`, advances the routing version, and writes a private recoverable transaction record.

Use the returned ID with `/lifecycle-routing-rollback <id>`. Rollback succeeds only when every field changed by application still matches the applied transaction; it refuses to overwrite newer policy.

### Cost and privacy evidence

Pi maintains `budget.jsonl` independently of optional recommendation evidence, so disabling analytics never disables cumulative run/day ceilings. Estimated ceilings continue to constrain planned spend. When a provider does not report observed usage, the event records `unknown` and adds no amount to observed totals; corrupt ledger state fails closed.

Routing and evidence files contain bounded identities, policy/profile versions, task categories/features, typed failure reasons, usage/cost values (or `unknown`), and outcomes. They exclude prompts, source text, diffs, artifact text, credentials, request headers, and repository remotes.

## Cursor with MCP

The MCP server routes only its planner and checker calls. Cursor's selected host model remains the coder.

1. Call `orchestrator_models` with `stage: "plan"` and the task. Review eligible server-side candidates and exclusions.
2. Call `orchestrator_plan` with the task, repository context, and structured task features when known.
3. Record returned routing metadata, show the plan, and wait for explicit user approval.
4. Select a coding-capable Cursor model and record its exact host identity as canonical `provider/model` in `coderIdentity`.
5. Implement, run relevant tests in Cursor, and collect `git diff`, `git diff --staged`, and test output.
6. Call `orchestrator_models` with `stage: "fast-judge"` and `coderIdentity`; verify independent checking is satisfied.
7. On the first pass, call `orchestrator_judge` with these required counter values:

   ```json
   {
     "task": "the original task",
     "plan": "the approved plan",
     "diff": "the current unstaged and staged diff",
     "testOutput": "the relevant test output",
     "iteration": 1,
     "consecutiveRejections": 0,
     "coderIdentity": "provider/model"
   }
   ```

8. Record the actual checker, fallback history, verdict, reasons, and required fixes.
9. Follow the returned `nextAction`, `nextIteration`, and `nextConsecutiveRejections` exactly:
   - `done`: report the independently approved result.
   - `retry_coding`: address every required fix, retest, refresh the diff, and use the returned counters on the next judge call.
   - `replan`: call `orchestrator_plan` with the original `task`, the last approved plan as `previousPlan`, accumulated `judgeReports`, and the refreshed `diffSummary`; present and approve the revised plan before editing again.
   - `stop_failed`: stop and report remaining work without reverting the tree.

`previousPlan` is mandatory whenever `judgeReports` or `diffSummary` is supplied. MCP is stateless across tool calls. It enforces per-request estimate and fallback caps, returns minimized routing metadata, and does not write project artifacts or cumulative run/day evidence. Keep client-side run notes when durable audit history is required.

## Cursor without MCP

Install instructions-only mode as described in [setup](setup.md). Follow `.cursor/skills/orchestrate/SKILL.md`:

1. Produce and explicitly approve a plan.
2. Manually select and record a coding-capable maker.
3. Implement and test.
4. Manually switch to and record an independent checker.
5. Apply the configured retry/re-plan caps.
6. Fail closed when strict independent checking cannot be satisfied.

Without MCP there is no server-side routing, model switch, fallback, metadata, or counter calculation. The user and Cursor workflow own those records.

## Publication and cleanup

SHIP may offer commit or pull-request actions only when configuration permits and the user confirms the exact current action. On resume, durable intent helps reconcile side effects but never substitutes for fresh authorization when an action has not occurred. Pull-request creation requires an already-pushed upstream whose tip matches local `HEAD`; AI Orchestrator does not push it.

Before removing a run directory, ensure the run is terminal and retain any artifacts required by your project. Never edit active lifecycle metadata manually to force a transition.

## Help

- [Setup guide](setup.md)
- [Configuration reference](../README.md#configuration-and-trust-boundaries)
- [Troubleshooting](../README.md#troubleshooting)
- [Adaptive routing PRD](https://github.com/nguyen-ta-cuong/ai-orchestrator/blob/main/docs/adaptive-capability-model-routing-prd.md)
