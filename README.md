# AI Orchestrator

## Build with one model. Check with another. Keep the final say.

AI Orchestrator is an open-source orchestration package for Pi and Cursor. It separates planning, implementation, and checking so the model that edits your code does not approve its own work.

Use a short **Plan → Code → Judge** loop for focused changes, or a durable **DEFINE → PLAN → BUILD → VERIFY → REVIEW → SHIP** lifecycle for work that needs specifications, restart-safe state, structured recovery, and independently reviewed BUILD graphs.

```sh
# Pi
pi install npm:@miracle3010/ai-orchestrator

# Cursor
npx @miracle3010/ai-orchestrator install-cursor
```

Then start with:

```text
/orchestrate add a --version flag to the CLI
/lifecycle implement resumable export processing
```

## How a run works

![AI Orchestrator run flow](https://cdn.jsdelivr.net/npm/@miracle3010/ai-orchestrator/docs/images/ai-orchestrator-run-flow.png)

The fast path is available in Pi and through Cursor’s durable MCP workflow. The full lifecycle runs in Pi. Cursor can also use the same Plan → Code → Judge controls manually when MCP is unavailable.

## Why use AI Orchestrator?

### Independent checking is a control, not a prompt

The latest BUILD identity is excluded from checker stages. You can require a different model family as well as a different exact model. If the configured separation cannot be proven, the run fails closed instead of labeling self-review as independent.

### Durable work survives the conversation

Lifecycle truth lives under `.ai-orchestrator/runs/<run-id>/`, not in model memory. Specifications, immutable plan versions, graph checkpoints, structured events, verdicts, routing decisions, and recovery evidence can be inspected and resumed after interruption.

### Recovery has a contract

Failures do not fall into an open-ended “try again” loop:

- **Retry** repeats a transient failed action within a bounded attempt budget.
- **Repair** sends a typed, read-only DEBUG diagnosis back to BUILD without changing the approved graph.
- **Re-plan** creates an immutable successor plan version and returns to explicit approval.
- Authorization, policy, budget, or uncertain side-effect failures pause or stop; recovery never bypasses a safety gate.

### Model choice is explainable

Capability routing evaluates callable models against stage requirements, task features, context and output limits, privacy policy, cost ceilings, profile confidence, and maker/checker separation. Every exclusion, score, selected thinking level, and fallback reason is inspectable.

Fresh installs use `capability-shadow`: exact configured routes remain active while capability candidates are ranked for comparison. Switch to active capability routing only after reviewing the preview for your own model catalog.

### Automation stops at the boundary you own

- Plans require approval by default.
- `--yolo` skips supported workflow approval pauses, not checks, budgets, or publication consent.
- VERIFY, REVIEW, DEBUG, and SHIP are read-only.
- Parallel writers require isolated worktrees, verified disjoint write sets, and explicit interactive consent.
- AI Orchestrator never pushes.
- It never automatically stashes, resets, cleans, checks out, or reverts your working tree.

## Choose the right workflow

| Workflow | Best for | State owner | Start |
| --- | --- | --- | --- |
| Pi fast path | Focused changes that still need an approved plan and independent judgment | Pi session | `/orchestrate <task>` |
| Pi lifecycle | Substantial, risky, restartable, or multi-part changes | Repository run directory | `/lifecycle <task>` |
| Cursor with MCP | Cursor codes while trusted server-side models plan and judge | Trusted user MCP run store | Install, then ask Cursor to use AI Orchestrator |
| Cursor without MCP | Environments where MCP is unavailable or prohibited | Manual workflow records | `install-cursor --no-mcp` |

If you are unsure, use `/orchestrate` for a small change and `/lifecycle` when you need a written specification, durable resume, more than one checker, or structured recovery.

## Pi

Install the package:

```sh
pi install npm:@miracle3010/ai-orchestrator
```

### Fast path

```text
/orchestrate <task>          Plan, request approval, build, and judge
/orchestrate --yolo <task>   Skip only the plan-approval pause
/orchestrate-stop            Cancel and restore the previous Pi state
```

The default loop allows three total coding passes and re-plans after two consecutive checker rejections.

### Durable lifecycle

```text
/lifecycle [--yolo] <task>      Start and drive a complete lifecycle
/lifecycle resume               Resume the active run from disk
/lifecycle migrate-routing      Adopt reviewed routing-policy changes
/lifecycle-stop                 Cancel and preserve the run artifacts
/lifecycle-models [stage]       Preview model routing without a model call
/lifecycle-routing-report       Show evidence-backed recommendations
/lifecycle-routing-apply N      Apply a confirmed trusted-user preference
/lifecycle-routing-rollback ID  Roll back that exact applied preference
```

Standalone stage commands are also available:

```text
/spec [--yolo] <idea>
/plan
/build
/test
/debug
/review
/ship
```

They run only when the saved lifecycle phase matches; they never skip or rewind durable state.

During PLAN, the planner must finish with `submit_build_plan`. The extension validates the DAG, writes canonical versioned plan artifacts, generates `plan.md`, and freezes that plan version before approval. During BUILD, read-only branches may fan out. Source-writing branches stay sequential unless the plan declares isolated worktrees and disjoint writes and you approve worktree creation, repository checkout behavior, concurrency, and final manual integration.

## Cursor

Install the rule, skill, and MCP configuration from your Cursor project:

```sh
npx @miracle3010/ai-orchestrator install-cursor
```

The installer creates missing AI Orchestrator assets but does not overwrite customized files. If `.cursor/mcp.json` already exists, it prints the server entry for you to merge.

With MCP enabled, prefer these durable tools:

```text
orchestrator_run_start
orchestrator_run_get
orchestrator_run_advance
orchestrator_run_recover
orchestrator_run_cancel
```

The server owns plan versions, revisions, permitted events, iteration counters, checker selection, fallback budgets, and recovery lineage. Cursor remains the coder and must declare its actual `provider/model` identity. Every mutation uses the exact returned revision plus a client idempotency key; a conflict is reconciled by reading the run.

`orchestrator_models` previews trusted server-side planner or checker candidates without calling a model. The compatibility tools `orchestrator_plan` and `orchestrator_judge` remain available for clients that still own their own loop.

For instructions-only mode:

```sh
npx @miracle3010/ai-orchestrator install-cursor --no-mcp
```

Cursor and Markdown cannot switch the selected host model. The installed workflow therefore requires you to record each maker/checker handoff and fail closed when independent checking is unavailable.

## Two independent engines

AI Orchestrator separates **model routing** from **workflow execution**:

| Concern | Engines | Fresh-install default |
| --- | --- | --- |
| Which eligible model should run a stage? | `legacy`, `capability-shadow`, `capability` | `capability-shadow` |
| How should a valid workflow transition execute? | `legacy`, `graph-shadow`, `graph` | `graph-shadow` |

Shadow mode is observational. It lets you compare the newer policy with the compatibility path without silently giving it authority.

The graph compiler, durable scheduler, stateful MCP protocol, immutable BUILD DAGs, versioned recovery, and rollout evidence verifier are shipped. Active graph execution remains a trusted-user opt-in because this repository contains contract tests, not the real field corpus and released compatibility window required to change the default or remove the compatibility path.

## Configuration and trust

Configuration precedence is:

1. Built-in defaults.
2. Trusted user config at `~/.ai-orchestrator/config.json`.
3. Project config at `<project>/.ai-orchestrator.json`.

Repositories are untrusted input on the MCP surface. Project config cannot add provider endpoints, credentials, or trusted model-catalog entries; weaken trusted privacy, cost, or separation ceilings; activate graph authority without trusted-user permission; grant parallel writes; or authorize publication.

Pi uses Pi’s authenticated local registry and ignores `mcp.*`. MCP uses only providers and models declared in trusted user config and never inspects the project filesystem. Cursor supplies bounded repository context, diffs, tests, and its coder identity as untrusted data.

See the [configuration reference](docs/configuration.md) for providers, model profiles, routing modes, budgets, graph execution, lifecycle artifacts, and SHIP policy.

## Documentation

- [Documentation index](docs/README.md) — choose the guide for your task.
- [Setup](docs/setup.md) — install Pi or Cursor and configure a trusted MCP catalog.
- [User guide](docs/user-guide.md) — operate the fast loop, lifecycle, durable MCP runs, recovery, and publication gates.
- [Configuration reference](docs/configuration.md) — defaults, precedence, engines, routing, budgets, and trust boundaries.
- [Structured graph architecture](docs/graph-architecture.md) — graph authority, scheduler checkpoints, BUILD DAGs, recovery, and rollout status.
- [Capability-aware routing](docs/adaptive-capability-model-routing-prd.md) — the shipped routing design, evidence loop, and known limits.
- [Contributing](CONTRIBUTING.md) — development workflow and validation.
- [Security policy](SECURITY.md) — supported versions and private vulnerability reporting.

## Requirements

- Node.js 20 or newer.
- Ripgrep (`rg`) for bounded nested BUILD-worker search.
- Pi workflows: Pi with the intended models authenticated in its local registry.
- Cursor MCP workflows: trusted provider credentials and at least one trusted planner/checker model.
- Git is strongly recommended for diff review, durable worktree coordination, and isolated BUILD candidates.

## Develop from source

Run validation serially because the build cleans and regenerates `dist/`:

```sh
npm install
npm test
npx tsc --noEmit
npm run build
npm pack --dry-run
```

Do not run `npm test` concurrently with `npm run build` or `npm pack`.

## Project principles

1. **The repository remembers; the model does not.**
2. **The maker does not grade its own work.**
3. **DEBUG diagnoses; BUILD edits.**
4. **Structured evidence beats prose.**
5. **Automation remains bounded, resumable, and reviewable.**
6. **Publication always belongs to the user.**

## License

[ISC](LICENSE)
