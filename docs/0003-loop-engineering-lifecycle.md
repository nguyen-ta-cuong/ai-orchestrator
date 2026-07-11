# Engineer the lifecycle as a durable loop with local top-tier model routing and a read-only DEBUG stage

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept current as work proceeds. Files under `plans/` are local execution records and must never be committed.

This plan supersedes `plans/0002-lifecycle-loop-engineering.md` for the lifecycle Pi implementation. It preserves the completed lifecycle core and artifact work from that plan, then deliberately changes the lifecycle by adding DEBUG and dynamic local model routing before implementing the Pi surface. It does not change the behavior of the existing `/orchestrate` fast path.

## Purpose / Big Picture

After this change, a developer can run `/lifecycle <task>` in Pi and let a durable loop move through DEFINE, PLAN, BUILD, VERIFY, REVIEW, and SHIP. When VERIFY or REVIEW rejects an implementation, a separate read-only DEBUG stage diagnoses the failure before GPT-5.5 edits code again. The loop chooses an appropriate top-tier architect/checker model from models already configured and authenticated in the user's local Pi registry: Claude Fable or an available GPT-5.6 variant. BUILD remains pinned to GPT-5.5 so the maker is distinct from the checker and model costs remain predictable.

The lifecycle is observable in three places. Pi's footer and widget show the current stage and selected model. `.ai-orchestrator/runs/<run-id>/` contains the specification, plan, debug diagnosis, state, and journal. The journal records every transition, verdict, and model-routing decision, including fallback reasons. If Pi exits, `/lifecycle resume` continues from disk rather than depending on conversation memory.

The intended flow is:

    DEFINE -> approve -> PLAN -> approve -> BUILD -> VERIFY -> REVIEW -> SHIP -> confirm -> done
                                      ^          |          |
                                      |          v          v
                                      +------ DEBUG <--- rejection
                                                 |
                                                 +-- diagnosis -> BUILD or re-PLAN according to loop policy

SHIP NO-GO continues to use the existing rejection policy directly. DEBUG is specifically the diagnostic bridge for VERIFY and REVIEW failures. It does not edit files and does not consume a BUILD iteration.

## Progress

- [x] (2026-07-11) Read `plans/0001-ai-orchestrator.md` and `plans/0002-lifecycle-loop-engineering.md` completely and inspected the completed lifecycle core.
- [x] (2026-07-11) Studied Addy Osmani's Loop Engineering article and extracted the durable design principles into this plan.
- [x] (2026-07-11) Studied `github.com/khoi/pi`, including its explicit Pi package manifest and structured `ask_user_question` extension patterns.
- [x] (2026-07-11) Re-read Pi `docs/extensions.md`, `docs/models.md`, `docs/packages.md`, the complete `examples/extensions/plan-mode/`, and `examples/extensions/structured-output.ts`.
- [x] (2026-07-11) Milestone 1: extended lifecycle state, artifacts, prompts, configuration, and tests for DEBUG and local stage routing.
- [x] (2026-07-11) Milestone 2: implemented `extensions/lifecycle.ts` with pipeline/stage commands, structured verdict and diagnosis tools, read-only command policy, disk persistence/resume, routing UI, finalization checkpoints, and safe restoration.
- [x] (2026-07-11) Milestone 3 automated scope: added `skills/lifecycle/SKILL.md`; after PR review fixes, `npm test` passes 12 files/112 tests; `npx tsc --noEmit`, build, pack dry-run, and direct Pi package load pass with no extension/skill warnings.
- [x] (2026-07-11) Closed clean-checkout validation gaps: lifecycle extension tests now use test-only Pi runtime stubs instead of untracked global-package symlinks, and builds remove stale `dist/` output before packaging. `npm test` passes 13 files/117 tests and pack dry-run contains the expected 61 files.
- [ ] Milestone 3 manual model-turn scope: run the full scratch-repository lifecycle, forced DEBUG rejection, and kill/restart transcript. This intentionally remains pending because it invokes paid models and requires an interactive Pi session.

## Surprises & Discoveries

- Observation: Local Pi exposes GPT-5.6 as three separate authenticated-model candidates rather than one model id: `openai-codex/gpt-5.6-luna`, `openai-codex/gpt-5.6-sol`, and `openai-codex/gpt-5.6-terra`.
  Evidence: `pi --list-models` lists all three alongside `anthropic/claude-fable-5` and `openai-codex/gpt-5.5`.

- Observation: Pi's model registry already distinguishes all known models from models with configured authentication.
  Evidence: `ModelRegistry.getAvailable()` returns models for which auth is configured, while `find(provider, id)` only proves registration. Routing must start from `getAvailable()` and still handle `pi.setModel()` failure as a runtime fallback.

- Observation: `khoi/pi` uses an explicit `package.json` Pi manifest and keeps complex question UI in a multi-file extension. The current package relies on convention discovery, which is sufficient, but the structured-question pattern reinforces that lifecycle ambiguity should be resolved at DEFINE rather than guessed during BUILD.
  Evidence: `extensions/ask_user_question/index.ts` registers a typed, UI-guarded tool and recommends asking related questions together.

- Observation: Pi now supports a `max` thinking level, while this repository's config type stopped at `xhigh`.
  Evidence: current Pi `docs/extensions.md` and `docs/models.md` include `max`. Implementation now accepts and restores `max`; defaults remain `xhigh`, and the MCP mapper conservatively maps it to its highest supported effort/budget.

- Observation: An initial read-only command allowlist was unsafe because command names alone do not make options safe.
  Evidence: review demonstrated that `find . -delete`, `find -exec`, `git diff --output=...`, and ripgrep `--pre` could mutate or execute. The implemented policy removes generic `find` shell access (the built-in `find` tool remains), rejects shell metacharacters and execution/output options, and has regression tests.

- Observation: Two Pi extensions that independently own the session model and active tool set can corrupt one another.
  Evidence: architecture review identified stale restoration when `/orchestrate` and `/lifecycle` overlap. Both start paths now reject while the other workflow is active; normal `/orchestrate` transitions and prompts remain unchanged.

- Observation: Safe finalization requires provenance and durable checkpoints, not only `git diff --name-only`.
  Evidence: review found that pre-staged unrelated files could be committed and untracked implementation files omitted. New runs persist baseline dirty/staged paths, refuse commits with pre-staged work, include newly created files via porcelain status, scope `git add`, and persist commit SHA/PR URL before final completion.

- Observation: A stop command must not wait for the operation it is intended to stop, and a durable artifact needs a matching durable completion marker.
  Evidence: PR review found `/lifecycle-stop` called `waitForIdle()` before `ctx.abort()`, and DEBUG resume truncated a diagnosis written just before a crash because completion lived only in memory. The stop path now aborts immediately; `debugDiagnosisVerdictIndex` is persisted with `debug.md`, allowing resume to advance the exact rejected verdict without rerunning DEBUG.

- Observation: The original automated evidence depended on untracked symlinks in the implementation worktree, so `test/lifecycleExtension.test.ts` failed from a clean checkout when Vitest resolved optional Pi peer imports. TypeScript declaration shims do not provide runtime modules.
  Evidence: `npm ls @earendil-works/pi-ai` was empty in the clean worktree but reported an extraneous global-package symlink in the milestone worktree. Test-only Vitest aliases now provide the minimal runtime schemas without changing published peer dependencies.

- Observation: Running `tsc` without cleaning its output can package JavaScript for source files that no longer exist.
  Evidence: the first package dry-run contained 64 files, including stale `dist/src/core/artifacts.*`; cleaning `dist/` before compilation restored the expected 61-file tarball.

## Decision Log

- Decision: Create this new `0003` plan rather than rewriting `0002`.
  Rationale: The previous plan records completed Milestone 1 history. A new plan makes the DEBUG and routing changes explicit without falsifying that record.
  Date: 2026-07-11

- Decision: DEBUG is a first-class read-only phase and standalone `/debug` command. VERIFY or REVIEW rejection transitions to `debugging`; `debug_produced` then applies the existing cap/escalation policy and enters BUILD, PLAN, or FAILED.
  Rationale: A checker should identify that work is wrong, while a debugger should explain why and produce a focused handoff. Keeping diagnosis separate from code editing preserves maker/checker separation and avoids asking GPT-5.5 to grade its own approach.
  Date: 2026-07-11

- Decision: SHIP NO-GO does not pass through DEBUG in this change.
  Rationale: The user specifically placed DEBUG after failed VERIFY/REVIEW. SHIP blockers often concern release policy or rollback readiness rather than an implementation defect; the existing direct retry/re-plan policy remains appropriate.
  Date: 2026-07-11

- Decision: Pi lifecycle routing is local-first and deterministic rather than spending an extra LLM call to choose an LLM. It filters candidates through `ctx.modelRegistry.getAvailable()`, applies stage-specific ordered preferences, attempts `pi.setModel()` in order, and records the selected candidate and fallback reason. The configured fixed role is the final fallback.
  Rationale: This satisfies dynamic stage-based selection from models already set up locally, is testable, survives offline use, avoids routing-token cost, and cannot hallucinate a model id. The lifecycle agent still makes a stage-aware choice, but the policy is inspectable code rather than opaque prose.
  Date: 2026-07-11

- Decision: Default route order is Fable-first for DEFINE, PLAN, and SHIP; GPT-5.6 Sol-first for VERIFY, REVIEW, and DEBUG; GPT-5.6 Terra and Luna are subsequent GPT fallbacks; the other top-tier family follows before the configured role fallback.
  Rationale: DEFINE/PLAN benefit from Fable's one-million-token context and architecture role. Adversarial verification, review, and root-cause diagnosis benefit from using a different top-tier family from the default architect. Sol is the premium GPT-5.6 entry in Pi's model metadata, Terra is the balanced fallback, and Luna is the economical fallback. All ordering remains configurable.
  Date: 2026-07-11

- Decision: BUILD always uses `roles.coder`, default `openai-codex/gpt-5.5` at `xhigh`, and is excluded from dynamic routing.
  Rationale: This is an explicit user requirement and preserves the product's subscription-priced implementer model.
  Date: 2026-07-11

- Decision: Model choices are persisted in `LifecycleState.modelSelections` and appended to `journal.md`.
  Rationale: Loop Engineering requires memory outside the conversation. A resumed run must explain which model made each artifact or verdict and why a fallback happened.
  Date: 2026-07-11

- Decision: The core state machine stays pure. Pi registry inspection and model switching remain in the extension; a pure `src/core/lifecycleRouting.ts` selects from normalized available model references.
  Rationale: Local credentials are adapter concerns, while selection policy is shared, deterministic logic that needs unit tests.
  Date: 2026-07-11

- Decision: The existing `/orchestrate` state machine, prompts, and normal behavior remain unchanged; `extensions/orchestrator.ts` receives only an additive lifecycle-active start guard.
  Rationale: The lifecycle is additive, but model/tool ownership is session-global. Mutual exclusion requires both commands to reject overlap; the compatibility guard prevents stale restoration without altering fast-path transitions.
  Date: 2026-07-11

- Decision: DEBUG ends through a terminating `debug_diagnosis` tool, and the extension writes `debug.md` from the structured result.
  Rationale: A model cannot both be strictly read-only and directly write its artifact. Extension-owned artifact writing preserves the read-only source boundary and gives the handoff a machine-checkable shape.
  Date: 2026-07-11

- Decision: Checker/architect bash is filtered by a reviewed read-only policy; the exact detected test command is the only general validation command admitted outside fixed inspection commands.
  Rationale: Removing `edit` and `write` is not sufficient because bash can mutate files. Fail-closed command validation provides a real boundary while retaining tests and Git inspection.
  Date: 2026-07-11

- Decision: Persist `modelRestored`, initial dirty/staged paths, commit SHA, and PR URL in lifecycle state.
  Rationale: These checkpoints prevent stale model restoration on later sessions, avoid committing pre-existing work, and make finalization resumable after successful external side effects.
  Date: 2026-07-11

- Decision: Keep Pi packages as optional runtime peers and alias only Vitest resolution to local schema stubs.
  Rationale: Pi supplies these modules when loading the package, while repository tests must be reproducible after a normal install without relying on a global Pi installation or pulling the full agent runtime into development dependencies.
  Date: 2026-07-11

- Decision: Make `npm run build` remove only generated `dist/` output before invoking TypeScript.
  Rationale: A deterministic build must not retain compiled files deleted from `src/`; cleaning the generated directory is safe and makes repeated package builds match clean-checkout output.
  Date: 2026-07-11

## Context and Orientation

The repository is a TypeScript ESM npm package. `src/core/` contains pure policy. `src/lifecycle/artifacts.ts` is the filesystem adapter. `extensions/orchestrator.ts` is the existing Plan -> Code -> Judge Pi extension and is the reference for model restoration, run-identity guards, structured tools, and active-tool management. The new extension must be `extensions/lifecycle.ts`; Pi convention discovery loads every TypeScript file in `extensions/`.

The completed lifecycle core currently has phases `idle`, `defining`, `awaiting_spec_approval`, `planning`, `awaiting_plan_approval`, `building`, `verifying`, `reviewing`, `shipping`, `awaiting_ship_approval`, `finalizing`, `done`, and `failed`. `src/core/lifecycle.ts` is the only module allowed to decide lifecycle transitions. `src/core/loop.ts` remains the only module allowed to decide `/orchestrate` transitions.

`src/core/config.ts` defines fixed roles `planner`, `coder`, `judge`, `spec`, `verifier`, `reviewer`, and `shipper`. The new work adds `debugger` and a `routing.lifecycle` block. Fixed roles remain necessary for MCP, explicit user overrides, and fallback. Dynamic local routing is Pi-only because Cursor's MCP server has no access to Pi's local registry.

The run directory is rooted at `config.lifecycle.artifactsDir`, default `.ai-orchestrator/runs`. `src/lifecycle/artifacts.ts` owns creation, the `current` pointer, atomic state writes, journal append, Git excludes, and ownership-safe release. Extend `RunPaths` with `debug` pointing to `debug.md`; never move filesystem mutation into `src/core/`.

Loop Engineering means engineering the system that prompts agents rather than manually prompting every turn. This implementation applies its six relevant primitives as follows:

1. Automations: `/lifecycle resume` is an idempotent continuation entry point suitable for a timer or scheduled prompt; scheduling itself remains documentation work.
2. Worktrees: implementation occurs on an isolated branch worktree, and the lifecycle never creates or merges worktrees automatically in this milestone.
3. Skills: `skills/lifecycle/SKILL.md` writes stage rules once so every run does not re-derive them.
4. Connectors: Pi tools, Git through `pi.exec`, and later MCP/`gh` are real actions, with destructive publication gated.
5. Sub-agents and maker/checker separation: GPT-5.5 implements; top-tier Fable/GPT-5.6 stages specify, verify, review, debug, and ship. SHIP may use `agent_team` read-only fan-out when available.
6. State outside context: spec, plan, diagnosis, state, and journal are on disk. The model forgets; the repository does not.

## Interfaces and Data Model

In `src/core/config.ts`, add `debugger` to `RoleName`. Add these public types:

    export type LifecycleRoutedStage = "define" | "plan" | "verify" | "review" | "debug" | "ship";

    export interface ModelCandidate extends RoleConfig {}

    export interface LifecycleRoutingConfig {
      enabled: boolean;
      stages: Record<LifecycleRoutedStage, ModelCandidate[]>;
    }

`OrchestratorConfig` gains:

    routing: {
      lifecycle: LifecycleRoutingConfig;
    };

Default candidates use exact local Pi ids. DEFINE, PLAN, and SHIP order Fable before Sol, Terra, and Luna. VERIFY, REVIEW, and DEBUG order Sol before Fable, Terra, and Luna. Every stage list must be non-empty, every candidate validates like a role, arrays replace rather than deep-merge by index, and `enabled: false` makes Pi use only the fixed stage role. The fixed `debugger` role defaults to Fable. Existing configs remain valid because deep merge supplies the new defaults.

Create `src/core/lifecycleRouting.ts` with pure interfaces and function:

    export interface AvailableModelRef {
      provider: string;
      model: string;
    }

    export interface LifecycleModelChoice {
      stage: LifecycleRoutedStage;
      candidate: ModelCandidate;
      source: "routing" | "role-fallback";
      reason: string;
    }

    export function lifecycleModelChoices(
      stage: LifecycleRoutedStage,
      config: OrchestratorConfig,
      available: readonly AvailableModelRef[],
      fallbackRole: RoleConfig,
    ): LifecycleModelChoice[];

The function returns available configured candidates in stage order, deduplicated by provider/model, then the available fixed role if absent. Returning an ordered list lets the Pi adapter try the next candidate when `pi.setModel()` returns false. It returns an empty list when nothing is locally configured.

In `src/core/lifecycle.ts`, add phase `debugging`, event `{ type: "debug_produced"; debugPath?: string }`, state field `debugPath?: string`, and state field:

    modelSelections: Array<{
      stage: LifecycleRoutedStage | "build";
      provider: string;
      model: string;
      thinking: ThinkingLevel;
      reason: string;
      selectedAt: string;
    }>;

The adapter also persists optional recovery/provenance fields: `modelRestored`, `baselinePaths`, `baselineStagedPaths`, and `finalization.commitSha|prUrl`. Older version-1 states may omit them; new runs populate them so restart cannot repeat stale model restoration or blindly commit pre-existing work.

VERIFY or REVIEW reject records the verdict, increments `consecutiveRejections`, and transitions to `debugging` without applying retry policy yet. `debug_produced` is valid only in `debugging`; it records the optional path and then calls `decideRejectedBuildOutcome`. The result maps to FAILED, PLAN with rejection counter reset, or BUILD. SHIP rejection keeps applying the policy immediately. Approval behavior and stage ranks are unchanged. Model selections are adapter observations, not transition events; the extension appends them when switching.

In `src/lifecycle/artifacts.ts`, add `debug` to `RunPaths`, create an empty `debug.md`, and validate the new phase and fields when reading state. State validation must remain fail-closed and accept only properly shaped selection records. Existing run directories without `debug.md` can resume: the extension creates it lazily before DEBUG. Existing version-1 states without the new optional fields remain valid.

In `src/core/lifecyclePrompts.ts`, add:

    export function debugPrompt(
      specText: string,
      planText: string,
      rejection: LifecycleStageVerdict,
      debugPath: string,
    ): string;

The prompt marks all artifact and rejection strings as untrusted JSON. It says: do not edit files; reproduce or inspect the failure with read-only tools and tests; identify root cause rather than symptoms; separate evidence, hypothesis, and confidence; list the smallest safe fix and exact validation; call `debug_diagnosis` exactly once; do not implement. The extension serializes that structured diagnosis to `debugPath`.

## Milestone 1: Core DEBUG and Routing Policy

First change tests so the desired policy fails before implementation. Update `test/lifecycle.test.ts`: VERIFY reject enters `debugging`, then `debug_produced` enters BUILD; REVIEW reject does the same; a second REVIEW rejection enters DEBUG first and only re-plans after diagnosis; cap exhaustion enters DEBUG first and fails after diagnosis; invalid `debug_produced` is ignored; DEBUG does not increment `buildIterations`; SHIP rejection still bypasses DEBUG.

Add `test/lifecycleRouting.test.ts` covering stage preference, filtering to locally available/authenticated references, fallback to fixed role, deduplication, disabled routing, and no available choice. Extend `test/config.test.ts` for `roles.debugger`, default route order, project route replacement, empty candidate rejection, malformed candidate rejection, and backward-compatible existing configs. Extend prompt and artifact tests for `debugPrompt`, `debug.md`, old state compatibility, malformed model selection rejection, and the new phase.

Then implement the interfaces above. Keep `src/core/` free of Pi imports and filesystem writes. Export pure routing and prompt interfaces from `src/index.ts`; do not export the mutating artifact adapter from the package root.

Milestone acceptance is:

    cd /Users/cuongnguyen/Documents/github/ai-orchestrator-lifecycle-milestone-2
    npm test
    npx tsc --noEmit
    npm run build

All commands must pass. Existing `/orchestrate` tests must remain unchanged and green.

## Milestone 2: Pi Lifecycle Extension

Create `extensions/lifecycle.ts`. Keep `/orchestrate` prompts and state-machine behavior untouched; add only a start-time guard in `extensions/orchestrator.ts` so the two model/tool owners cannot overlap. Use constants unique to lifecycle: custom entry type `ai-orchestrator-lifecycle`, status/widget keys of the same name, and terminating tools `verify_verdict`, `review_verdict`, `debug_diagnosis`, and `ship_decision`.

Register commands:

- `/lifecycle [--yolo] <task>` creates a run and automatically drives all stages.
- `/lifecycle resume` reads the current disk state and automatically continues from the saved phase.
- `/lifecycle-stop` aborts the active turn, restores tools and original model, transitions/cancels state, releases only the owned `current` pointer, and preserves the run directory.
- `/spec [--yolo] <idea>` creates a run and performs DEFINE only, including its approval gate, then restores the original model and tells the user to run `/plan`.
- `/plan`, `/build`, `/test`, `/debug`, `/review`, and `/ship` run exactly the phase currently recorded on disk. They refuse backward or out-of-order execution with a message naming the current phase and correct next command. A standalone command restores the user's model and tools when that stage and any associated gate completes.

At command start, call `ctx.waitForIdle()`, load config with `{ ignoreMcpProviders: true }`, and capture original model/thinking once. Every await across a dialog or model switch must be followed by a run-id and expected-phase check. This prevents a stale approval callback from advancing a stopped or replaced run.

Model routing works only for DEFINE, PLAN, VERIFY, REVIEW, DEBUG, and SHIP. For the stage, normalize `ctx.modelRegistry.getAvailable()` to provider/id references, call `lifecycleModelChoices`, and try each returned model. On successful `pi.setModel`, set candidate thinking, append a selection record to state, persist it, and append the rationale to the journal. If a candidate disappears or `setModel` returns false, continue to the next choice and include that fallback in the eventual rationale. If none works, stop safely with an error listing attempted candidates and config locations. BUILD bypasses the router and resolves only `roles.coder` (GPT-5.5 by default).

Register the three structured terminating tools using `StringEnum`, never `Type.Union` of literals. Their execute functions throw unless disk and in-memory state are both the matching phase and run id. VERIFY and REVIEW accept `{ verdict, reasons, requiredFixes? }`; SHIP accepts `{ decision: go|no_go, report, blockers? }`. Each returns `terminate: true` and stores a pending structured result for `agent_end`.

For DEFINE and PLAN, prompts require writing non-empty files. At `agent_end`, check disk rather than trusting assistant prose. Send one reminder if missing; after the reminder, stop with an actionable error. Approval dialogs offer Approve, Revise, and Cancel. Revision feedback from `ctx.ui.editor` is trusted user input passed separately to the prompt builder. Without UI and without yolo, fail safe and say to rerun with `--yolo`.

At BUILD completion, emit `build_produced` and enter VERIFY. At VERIFY/REVIEW/SHIP completion, require the matching structured tool. Remind once when absent, then synthesize a reject. A VERIFY or REVIEW reject enters DEBUG; start `debugPrompt`, require non-empty `debug.md`, remind once if absent, then emit `debug_produced`. BUILD receives both the checker finding and latest diagnosis as trusted feedback. DEBUG itself never calls a verdict tool.

Tool gating is defense in depth. DEFINE, PLAN, VERIFY, REVIEW, DEBUG, and SHIP remove `edit` and `write`. VERIFY, REVIEW, DEBUG, and SHIP keep read/search tools and `bash`; DEFINE and PLAN may write only their exact artifact through a narrow extension-owned write mechanism or, more simply, temporarily allow `write` but use a `tool_call` guard that permits mutation only when the target path exactly equals `spec.md` or `plan.md`. BUILD restores the full pre-lifecycle tool set. SHIP may retain `agent_team` only if it was active before the stage. The `tool_call` guard always blocks `edit`/`write` during VERIFY, REVIEW, DEBUG, and SHIP, regardless of active-tool configuration.

Persist after every transition using atomic `writeState`, append one journal line, and mirror state with `pi.appendEntry`. Disk is authoritative. On `session_start`, if disk has an active run, restore the saved original model if necessary, deactivate lifecycle verdict tools, clear lifecycle UI, and notify the user to use `/lifecycle resume` or `/lifecycle-stop`; do not release the run. On `session_shutdown`, restore model/tools but preserve active disk phase and lock. This differs intentionally from `/orchestrate`, whose session-local run is reset when interrupted.

Finalization remains conservative. `ship.commit: never` skips commit; `ask` requires interactive confirmation; `auto` permits commit but never push. Stage only paths returned by `git diff --name-only` and `git diff --staged --name-only`, excluding the artifact directory; never use `git add -A`. `ship.openPr: ask` requires a second explicit confirmation and a successful commit, then runs `gh pr create`; `never` skips. Non-interactive `ask` behaves as `never`. Report failures without reverting the tree. Complete with a summary, restore model/tools, and release only the current pointer owned by the run.

Status UI shows phase, selected model, BUILD iteration count, consecutive rejections, and last verdict. Use `ctx.hasUI` for dialogs/status/widget. In print/JSON mode, use visible custom messages instead of relying on notifications.

## Milestone 3: Skill, Validation, and Evidence

Create `skills/lifecycle/SKILL.md` with valid Agent Skills frontmatter (`name: lifecycle`, concise description). Document the seven effective stages, including DEBUG as a diagnostic sub-loop, all commands, gates, artifacts, dynamic local routing, GPT-5.5-only implementation, structured verdicts, resume, and cancellation. State phase boundaries explicitly: architects do not implement, BUILD does not approve itself, checkers and debugger do not edit, SHIP does not publish without consent.

Include a “Without lifecycle tools” fallback for Cursor and other agents. It must preserve maker/checker separation when multiple models or sub-agents exist, store state in the same artifact files, and ask the user to switch between a top-tier Fable/GPT-5.6 checker and GPT-5.5 implementer when automatic switching is unavailable.

Run automated validation:

    cd /Users/cuongnguyen/Documents/github/ai-orchestrator-lifecycle-milestone-2
    npm test
    npx tsc --noEmit
    npm run build
    npm pack --dry-run

Confirm the tarball includes `extensions/lifecycle.ts`, `skills/lifecycle/SKILL.md`, and compiled core lifecycle/routing modules while excluding `plans/` and `test/`.

Manual validation uses `/tmp/lc-demo`, with a tiny TypeScript CLI and tests. Install the worktree path with Pi. First configure cheap local candidates to exercise fallbacks, then use defaults once:

    cd /tmp/lc-demo
    pi install /Users/cuongnguyen/Documents/github/ai-orchestrator-lifecycle-milestone-2
    pi
    /lifecycle add a --version flag that prints 1.0.0

Observe DEFINE and PLAN artifacts and gates, GPT-5.5 BUILD edits, a top-tier independent VERIFY and REVIEW, SHIP report and confirmation, and restoration of the original model. Force a failed test and observe VERIFY reject -> DEBUG read-only diagnosis in `debug.md` -> GPT-5.5 rebuild. During DEBUG, attempt an edit and confirm it is blocked. Kill Pi during BUILD, restart, observe the disk-state notice, and run `/lifecycle resume`. Temporarily make the preferred model unavailable and verify the next locally configured candidate is selected and the fallback is journaled.

Pi startup must show no skill warnings. Record concise transcripts in this plan's `Artifacts and Notes` and update `Progress` and `Outcomes & Retrospective`.

## Validation and Acceptance

The work is accepted when all automated tests and type checks pass and the manual transcript proves these behaviors:

1. `/orchestrate` retains its existing Plan -> Code -> Judge behavior.
2. `/lifecycle` persists a complete run outside conversation context and resumes after restart.
3. BUILD uses configured GPT-5.5, while every non-build stage chooses the first suitable locally available Fable/GPT-5.6 candidate and records the reason.
4. VERIFY or REVIEW rejection cannot edit files and always enters read-only DEBUG before BUILD/re-plan/failure.
5. DEBUG writes concrete evidence and validation steps to `debug.md`, does not increment BUILD iterations, and hands diagnosis to the implementer.
6. Structured verdict tools, run-id checks, one-reminder recovery, and tool guards fail closed.
7. Original model, thinking, and active tools are restored on completion, failure, cancel, abort, shutdown, and standalone stage completion.
8. No commit, push, or PR occurs without the configured and user-confirmed opt-in; the tree is never reverted automatically.

## Idempotence and Recovery

Core transitions are pure and invalid events return an unchanged clone. State writes are atomic. Run creation and release use ownership-aware locks. `/lifecycle resume` is safe to repeat: it reads the current disk phase and refuses to create another run. `/lifecycle-stop` preserves artifacts. If the current pointer is corrupt, the user may remove only `<artifactsDir>/current`; run directories remain evidence. Never automatically reset, stash, checkout, or clean the working tree.

If implementation fails partway, rerun tests after each milestone. Existing version-1 run states without DEBUG fields remain readable. If a run resumes at VERIFY/REVIEW rejection from an older build, it can continue through the new transition only after the next verdict; do not synthesize or rewrite historical verdicts.

## Artifacts and Notes

Research evidence:

    pi --list-models
    anthropic     claude-fable-5
    openai-codex  gpt-5.5
    openai-codex  gpt-5.6-luna
    openai-codex  gpt-5.6-sol
    openai-codex  gpt-5.6-terra

Loop Engineering principles incorporated from Addy Osmani's June 2026 article: scheduled automation provides heartbeat; worktrees prevent parallel file collision; skills externalize intent; connectors let loops act on real systems; separate sub-agents keep the maker away from the checker; durable state outside the conversation is the spine. The human remains responsible for verification and comprehension rather than surrendering judgment to automation.

Automated implementation evidence:

    npm test
    Test Files  13 passed (13)
    Tests       117 passed (117)

    npx tsc --noEmit
    # passed with no output

    npm run build
    # passed

    npm pack --dry-run
    # 61 files; includes lifecycle extension/skill/routing/debug policy; excludes plans and tests

    pi -e /Users/cuongnguyen/Documents/github/ai-orchestrator-lifecycle-milestone-2 --list-models
    # exit 0; stderr empty (no extension or skill warnings)

The paid interactive lifecycle transcript remains pending.

## Outcomes & Retrospective

Implemented the durable Pi lifecycle, dynamic authenticated-local Fable/GPT-5.6 routing, fixed GPT-5.5 BUILD, structured read-only DEBUG handoff, standalone stage commands, resume, model/tool restoration, mutual exclusion with `/orchestrate`, scoped finalization, skill guidance, and automated validation. The main deviation from the initial draft is stronger: DEBUG no longer asks a read-only model to write a file; it calls `debug_diagnosis` and the extension writes the artifact. Review also required a real bash policy and durable finalization/model-restoration checkpoints.

Follow-up clean-checkout validation removed two hidden environmental dependencies: tests no longer need globally symlinked Pi peers, and packaging no longer retains stale compiler output. The automated lifecycle evidence is now reproducible from the repository's declared dependencies.

Remaining work is interactive evidence against paid models plus the later MCP/Cursor lifecycle surface. Filesystem symlink containment and stale crash-lock reclamation are pre-existing artifact-adapter hardening opportunities that should receive a separate focused plan rather than an untested late change here.

---

Revision note (2026-07-11): Created this plan from the two prior plans plus current repository state. It supersedes the lifecycle Pi milestone with dynamic local Fable/GPT-5.6 routing, a read-only DEBUG stage, durable model-selection records, updated Loop Engineering invariants, and a concrete implementation/validation path. The change responds to the availability of stronger GPT-5.6 models while retaining GPT-5.5 as the dedicated implementer.

Revision note (2026-07-11): Recorded clean-checkout test isolation and deterministic packaging fixes after the merged implementation was validated without the milestone worktree's untracked global Pi symlinks.
