# AGENTS.md — ai-orchestrator

Guidance for coding agents implementing and maintaining this repository.

## Read first

The living specifications are local ExecPlans under `plans/`, which are deliberately not committed:

- `plans/0001-ai-orchestrator.md` describes the shipped Plan → Code → Judge fast path.
- `plans/0003-loop-engineering-lifecycle.md` is authoritative for the durable lifecycle, dynamic local model routing, and DEBUG loop. It supersedes `plans/0002-lifecycle-loop-engineering.md` for lifecycle Pi implementation.

Read the relevant plan completely before changing behavior. Keep its `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` current. **Never commit files under `plans/`.**

## Sticky Loop Engineering principles

This project engineers the system that prompts agents; it does not rely on a human manually prompting every phase. Preserve these principles in every surface:

1. **The repository remembers; the model does not.** Lifecycle truth lives in `.ai-orchestrator/runs/<run-id>/`: `spec.md`, `plan.md`, `debug.md`, `state.json`, and `journal.md`. Conversation/session entries are a UI mirror, never authoritative state.
2. **Keep the maker away from the checker.** BUILD uses an explicit configured pin or a capability-selected implementer (GPT-5.5 remains the built-in preference). DEFINE, PLAN, VERIFY, REVIEW, DEBUG, and SHIP use eligible models from the callable local registry. A model that edits code must not decide that its own work is done.
3. **DEBUG diagnoses; BUILD edits.** VERIFY or REVIEW rejection enters a read-only DEBUG phase. DEBUG gathers evidence and calls `debug_diagnosis`; the extension writes the structured result to `debug.md`. DEBUG never mutates source files. The independently selected BUILD implementer receives that diagnosis and implements it.
4. **Skills externalize intent.** Project conventions and phase rules belong in `AGENTS.md` and `skills/*/SKILL.md`, not in one-off prompts that must be rediscovered every run.
5. **Connectors perform real work, with gates.** Pi tools, Git, MCP, and `gh` are action surfaces. Read operations may be automated. Commit/PR/publication remains explicitly configured and confirmed. Never push automatically.
6. **Automations need resumable entry points.** `/lifecycle resume` must be idempotent and safe for scheduled invocation. An unattended run still fails closed at missing human approval or unavailable models.
7. **Use worktrees for parallel implementation.** Concurrent agents work in separate branch worktrees. Worktree isolation prevents file collisions but does not remove human review cost.
8. **Structured evidence beats prose.** Checker outcomes use terminating typed tools. State transitions are pure functions. The journal records transitions, verdicts, selected models, and fallback reasons.
9. **Stay the engineer.** Automation does not waive verification, comprehension, security review, or rollback responsibility. The tree is never reverted automatically; the human decides what to keep.

These principles are distilled from Addy Osmani's “Loop Engineering”: automations provide the heartbeat, worktrees isolate parallel work, skills preserve intent, connectors reach real systems, independent agents separate maker/checker, and state outside the conversation is the spine.

## Product surfaces

The npm package exposes three surfaces:

1. **Pi package** — `extensions/` and `skills/` are auto-discovered. `/orchestrate` is the fast path. `/lifecycle` and standalone stage commands provide the durable DEFINE → SHIP loop.
2. **MCP server** — `ai-orchestrator-mcp` serves Cursor. Cursor's selected agent remains the coder; the server calls architect/checker roles.
3. **Cursor rules/skills** — Markdown-only fallback for environments that forbid MCP; model switching is manual there.

The fast path is additive and stable:

    planning → approval → coding → judging → done
                              ↑         |
                              └ reject ┘

The lifecycle is durable:

    DEFINE → PLAN → BUILD → VERIFY → REVIEW → SHIP
                       ↑        |         |
                       └─ DEBUG <─ reject ┘

Two consecutive checker rejections re-plan. Three total BUILD passes fail by default. Caps come from config.

## Architecture and import direction

    src/core/                         pure shared policy
      loop.ts                         /orchestrate state machine
      lifecycle.ts                    lifecycle state machine
      lifecycleRouting.ts             pure stage-aware model candidate ordering
      prompts.ts                      fast-path prompts
      lifecyclePrompts.ts             lifecycle + DEBUG prompts
      config.ts                       merge/validation/defaults
      tests.ts                        test-command detection

    src/lifecycle/artifacts.ts        mutating disk adapter; atomic state/journal/run lock
    extensions/orchestrator.ts        existing Pi fast path
    extensions/lifecycle.ts           durable Pi lifecycle
    mcp/                              MCP adapter
    skills/ and cursor/               data-only instructions/assets

Import direction is one-way: surfaces and filesystem adapters may import `src/core/`; `src/core/` must never import Pi, MCP, extension, or artifact modules. `src/core/` is pure except configuration file reads already owned by `config.ts`.

## Invariants — do not break

- Only `src/core/loop.ts` decides `/orchestrate` transitions. Only `src/core/lifecycle.ts` decides lifecycle transitions. Surfaces never duplicate cap/escalation policy.
- Existing `/orchestrate` behavior and tests remain unchanged unless a separate approved plan explicitly changes them.
- Pi lifecycle routing starts from `ctx.modelRegistry.getAvailable()`, selects every stage including BUILD through pure capability policy when enabled, and records the chosen model and rationale. Explicit user/project `roles.*` identities are pins; built-in role identities are preferences. Legacy and shadow engines retain the prior exact-route behavior.
- All role/model mappings and route candidates are configurable. Never hardcode credentials or provider endpoints outside config defaults.
- Pi ignores `mcp.providers`; MCP never reads Pi's local model registry. MCP ignores project-level provider endpoint/key overrides because the repository is untrusted input.
- Every active-run exit path restores the user's original model, thinking level, and active tools: done, failed, cancel, Escape abort, model/provider error, session shutdown, interrupted restart, and standalone stage completion.
- VERIFY, REVIEW, DEBUG, and SHIP are read-only. Their active tools are read/search plus filtered `bash` and the matching verdict/diagnosis tool. Bash accepts only reviewed inspection forms and the exact detected test command; a `tool_call` guard also blocks `edit` and `write` regardless of active-tool configuration.
- DEFINE and PLAN may write only their exact run artifact. BUILD is the only lifecycle phase with normal source mutation tools.
- Verdicts are structured, never parsed from prose: `judge_verdict`, `verify_verdict`, `review_verdict`, and `ship_decision`. Use `StringEnum` from `@earendil-works/pi-ai`; never `Type.Union` of string literals.
- Disk state is authoritative. Write it atomically after every transition, append journal evidence, and release `current` only when the caller still owns that run id.
- Guard every async approval/editor/confirm callback with run id and expected phase checks.
- Missing artifacts or verdicts get one reminder, then fail closed or synthesize a rejection as specified by the ExecPlan.
- One active lifecycle run per repository. The working tree is never automatically stashed, reset, checked out, cleaned, or reverted.
- `--yolo` skips human lifecycle gates but never grants publication consent. SHIP never pushes. Commit/PR actions obey config and explicit confirmation.
- The installer never overwrites an existing `.cursor/mcp.json`.

## Pi implementation conventions

Before Pi extension work, read the installed Pi docs completely:

- `docs/extensions.md`
- `docs/models.md` when routing or model behavior changes
- `docs/packages.md` and `docs/skills.md` when packaging resources changes
- `examples/extensions/plan-mode/`
- `examples/extensions/structured-output.ts`

Resolve these paths under the installed `@earendil-works/pi-coding-agent` package named by the coding harness, not relative to this repository.

Use `ctx.waitForIdle()` at command entry, `ctx.hasUI` for dialogs, `ctx.mode === "tui"` for TUI-only custom components, `pi.appendEntry()` for session mirrors, and `pi.setActiveTools()` with exact restoration. Throw from tool `execute` to signal failure. Keep persisted data JSON-serializable. Pi loads extensions uncompiled through jiti; TypeScript compilation still must pass.

The `github.com/khoi/pi` package is a useful reference for an explicit Pi manifest and typed, UI-guarded structured questions. Prefer one grouped clarification at DEFINE when requirements are ambiguous rather than allowing BUILD to guess.

## Configuration and trust boundaries

Precedence is built-in defaults ← `~/.ai-orchestrator/config.json` ← `<project>/.ai-orchestrator.json`.

- Prototype-pollution keys are dropped.
- Lifecycle artifact paths remain relative and contained in the project.
- `$ENV_VAR` interpolation is limited to `mcp.providers.*.apiKey`; never execute shell syntax from orchestrator config.
- MCP provider base URLs require HTTPS and project config cannot redirect trusted user credentials.
- Pi resolves provider/model pairs through its own registry and credentials.

## Testing and validation

TypeScript is strict ESM, Node ≥20. Runtime dependencies are `@modelcontextprotocol/sdk` and `zod`; Pi packages are peers. Tests must not use real credentials or network.

Run from repository root:

    npm install
    npm test
    npx tsc --noEmit
    npm run build
    npm pack --dry-run

New transition behavior requires a state-machine test first. Stateful filesystem changes require adversarial tests for corrupt state, stale ownership, path traversal, lock contention, and cleanup. Routing changes require tests for local availability filtering, priority, fallback, deduplication, disabled routing, and no candidate.

Manual Pi validation belongs in a scratch repository with cheap configured models first. Verify model switches, write guards, approval identity checks, DEBUG handoff, resume after restart, original-model/tool restoration, no skill warnings, and package discovery. Record concise evidence in the active ExecPlan.

## Questions policy

If behavior is ambiguous, read the active ExecPlan and its Decision Log first. Ask the user when ambiguity affects security, credentials, destructive operations, publication, externally visible contracts, or model-cost policy. Otherwise choose the conservative fail-closed behavior and record the decision and rationale in the ExecPlan rather than silently guessing.
