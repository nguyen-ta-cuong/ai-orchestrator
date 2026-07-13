# Adaptive capability-aware model routing

Status: Proposed

Date: 2026-07-11

Owner: ai-orchestrator maintainers

## Executive summary

ai-orchestrator currently says it selects models from the user's local Pi registry, but it only filters a built-in list of four exact model IDs. The fast `/orchestrate` path is even stricter: planner, coder, and judge are fixed roles whose defaults name Claude Fable 5 and GPT-5.5. A user can have many suitable authenticated models and still receive “no locally configured model” unless they manually rewrite every route.

This PRD replaces model-name-first routing with capability-aware routing. The system will discover models the user can actually call, normalize objective metadata, combine it with explicit capability profiles and user policy, enforce maker/checker separation, and rank candidates for the work a stage must perform. Exact model pins remain supported as overrides and fallbacks, but built-in model IDs stop being the product's definition of “best.”

The routing decision remains deterministic, inspectable, and offline. The first release does not spend an extra model call to choose a model. Later releases may classify task features with a model, but the final candidate set and ranking remain constrained by validated local facts and policy. Every decision is journaled with eligible candidates, exclusions, scores, selected reasoning effort, fallback attempts, and policy version.

## Problem statement

The built-in configuration in `src/core/config.ts` defaults planner, judge, specification, verifier, reviewer, debugger, and shipper roles to `anthropic/claude-fable-5` at `xhigh`. BUILD defaults to `openai-codex/gpt-5.5` at `xhigh`. Lifecycle routing recognizes only Fable plus the Sol, Terra, and Luna GPT-5.6 variants. `src/core/lifecycleRouting.ts` filters those exact names through `ModelRegistry.getAvailable()` and preserves their configured order. `extensions/lifecycle.ts` bypasses routing for BUILD, while `extensions/orchestrator.ts` resolves every fast-path role by exact provider and model.

On the development machine used for this PRD, `pi --list-models` reports authenticated access to many Anthropic, OpenAI Codex, and OpenRouter models. Pi exposes useful objective metadata for each model: provider, API type, reasoning support, accepted input types, context window, maximum output tokens, and cost rates. The current router discards all of that metadata except provider and ID.

This creates five product failures:

1. Availability is local, but suitability is hardcoded globally.
2. New or aliased models cannot participate until this package ships a code change.
3. BUILD cannot use a user-preferred coding model without replacing the fixed coder role.
4. Planner and checker independence is accidental. A fixed default can place the same model family on both sides of the loop.
5. The journal records the selected model but cannot explain why other available models were excluded or how cost, context, risk, and task type affected selection.

## Research synthesis

Addy Osmani's [Loop Engineering](https://addyosmani.com/blog/loop-engineering/) identifies automation, worktrees, skills, connectors, sub-agents, and durable external state as the practical pieces of a loop. Its strongest architectural constraint for this project is to keep the maker away from the checker and to treat repository state, not conversation memory, as authoritative. It also warns that unattended verification, token cost, comprehension debt, and cognitive surrender become more important as automation improves.

LangChain's [The Art of Loop Engineering](https://www.langchain.com/blog/the-art-of-loop-engineering) describes four nested loops: the agent loop, verification loop, event-driven loop, and hill-climbing improvement loop. The immediate routing change belongs inside the agent and verification loops. Selection traces and outcomes should deliberately prepare for a later hill-climbing loop, but automatic mutation of production routing policy is not part of the first release. Human-reviewed policy promotion is the safe boundary.

The [cobusgreyling/loop-engineering](https://github.com/cobusgreyling/loop-engineering) reference implementation adds operational practices that are directly useful here: readiness levels, report-only rollout before autonomous action, token budgets, append-only run logs, circuit breakers, attempt caps, explicit handoff, and failure catalogs. In particular, “verifier theater,” infinite fix loops, token burn, state rot, and over-reach must be visible routing outcomes rather than only prompt concerns.

The combined implication is that model routing is not a one-time “best model” lookup. It is a policy loop: discover what is available, match it to a stage and task, enforce independence and safety constraints, observe outcomes, and improve the policy through reviewed evidence.

## Goals

After implementation, users can:

- run `/orchestrate` and `/lifecycle` without having the package's preferred model IDs installed;
- allow the orchestrator to choose among their authenticated models using transparent stage and task requirements;
- pin, prefer, deny, or profile models without changing source code;
- choose quality, balanced, economy, or custom routing policy;
- preserve strict maker/checker separation even when both candidates come from one provider;
- understand every choice and fallback from UI and durable run artifacts;
- compare routing quality, cost, latency, and convergence across runs before accepting policy changes;
- keep MCP credentials and provider endpoints outside repository-controlled configuration.

## Non-goals

The first delivery does not benchmark every model on the public internet, call an LLM solely to choose another LLM, train or fine-tune models, automatically rewrite routing policy, automatically purchase access to a provider, or claim that model names alone prove competence. It does not make SHIP push automatically, relax human publication gates, or allow checkers to edit source files. It does not require OpenRouter; direct Pi providers remain first-class.

## Users and primary workflows

The primary user is a developer with several models configured in Pi who wants reliable stage selection without maintaining exact route arrays. A team maintainer wants project-wide constraints such as allowed providers, minimum context, cost ceilings, and mandatory checker diversity. An advanced operator wants to pin selected stages, add capability profiles for custom models, inspect routing traces, and compare candidate performance. MCP and Cursor users need equivalent policy semantics even though the MCP server cannot inspect Pi's local registry.

The critical workflow is:

    local model registry + user/project policy + stage requirements + task features + run history
                                      |
                                      v
                  hard eligibility -> deterministic scoring -> ordered fallbacks
                                      |
                                      v
                      selected model + explanation + durable trace

## Product principles

The repository remembers; the model does not. Routing inputs, policy version, decisions, fallbacks, and outcomes live in run artifacts.

The maker never grades itself. A checker must differ from the BUILD model according to configured separation rules. Provider-family diversity is preferred and can be required.

Hard facts precede opinions. Authentication, context capacity, tool support, reasoning support, and cost come from the active adapter or explicit configuration. Subjective capabilities such as architecture, coding, debugging, or adversarial review come from versioned profiles and measured local evidence, never from an unvalidated substring alone.

Hard constraints precede scoring. A cheap model that cannot satisfy context, tool, privacy, or separation requirements is ineligible rather than merely penalized.

The router is explainable. Given the same normalized inputs and policy, pure core code returns the same ordered candidates and reasons.

Learning is gated. Runtime evidence may recommend score changes, but a human approves changes to default or project policy.

## Architectural approaches considered

### Exact ordered model lists

This is the current lifecycle design. It is simple and deterministic, but it ages immediately, ignores almost all registry metadata, duplicates configuration across stages, and fails users whose available models have different names or providers. Keep exact lists only as explicit pins and emergency fallback chains.

### Name-based heuristics

This approach infers that strings containing `coder`, `pro`, `opus`, or `mini` indicate capabilities. It works for prototypes but is unsafe as the primary design because naming conventions are provider-specific, aliases drift, and custom models may be mislabeled. Conservative family rules may seed profiles, but every inferred attribute must identify its source and be overridable.

### LLM-as-router

A small model could read the task and select a model. This handles nuanced task descriptions but adds latency and cost, can invent unavailable IDs, is difficult to reproduce, and creates a circular bootstrap problem. It is acceptable later as an optional task-feature classifier whose output is validated against a closed schema. It is not acceptable as the authority for eligibility or final choice.

### External gateway router

OpenRouter and similar gateways can optimize provider availability, cost, throughput, and latency after a model or model set is chosen. That is useful transport routing but does not replace lifecycle role routing. The orchestrator must still decide whether a stage needs architecture, code editing, adversarial review, or diagnosis. Gateway routing may operate beneath this policy when the chosen Pi model represents a gateway model.

### Chosen approach: deterministic policy plus profiles plus evidence

The selected design normalizes adapter metadata, overlays explicit capability profiles, applies stage requirements and task features, filters on hard constraints, then produces an ordered score with a full explanation. Static pins override automatic ranking. Local outcome evidence can contribute a bounded adjustment after enough samples, but it cannot override safety or separation constraints. This approach is portable, testable, and evolvable without pretending that objective registry metadata alone measures model quality.

## Capability model

### Objective model facts

Each adapter normalizes the facts it can prove into a `DiscoveredModel`:

    provider and model ID
    display name and API family
    authenticated or otherwise callable
    reasoning support and supported thinking levels
    text and image input support
    context window and maximum output tokens
    input, output, cache-read, and cache-write cost rates when known
    provider-auth kind when safely available, such as subscription or API key

No secret, endpoint credential, or raw authentication material enters core routing or run artifacts.

### Subjective capability profile

A `ModelCapabilityProfile` assigns normalized scores from 0 through 100 for:

- `requirements`: turning ambiguity into testable specifications;
- `architecture`: repository comprehension, decomposition, and trade-off reasoning;
- `coding`: correct multi-file source edits and test implementation;
- `debugging`: causal diagnosis from failures, logs, and code;
- `verification`: deterministic acceptance-criteria checking and test interpretation;
- `review`: adversarial correctness, security, performance, and maintainability review;
- `release`: risk synthesis, rollback planning, and ship/no-ship judgment;
- `structuredOutput`: reliable use of terminating typed tools;
- `longContext`: effective use of large repository and artifact context;
- `speed` and `economy`: relative operational preferences, not quality claims.

Profiles also contain confidence, provenance, version, and optional family identity. Provenance is one of `user`, `project`, `builtin`, `observed`, or `inferred`. User and project values override built-in values. Observed adjustments require a minimum sample count and are bounded. Inferred profiles receive low confidence and cannot satisfy a stage's `minimumProfileConfidence` unless policy explicitly allows it.

### Stage requirements

DEFINE emphasizes requirements, long-context exploration, ambiguity detection, and structured artifact production. PLAN emphasizes architecture, dependency ordering, repository comprehension, and validation design. BUILD requires coding, tool use, sufficient context, and mutation permission. VERIFY emphasizes test execution, acceptance-criterion traceability, and structured verdict reliability. DEBUG emphasizes causal reasoning over logs, failures, code, and previous verdicts while remaining read-only. REVIEW emphasizes adversarial comparison of PRD, approved plan, diff, architecture, security, and performance. SHIP emphasizes evidence synthesis, release risk, rollback planning, and structured decision output.

The fast-path planner maps to PLAN, coder maps to BUILD, and judge maps to a combined VERIFY/REVIEW requirement set. This lets both product surfaces share one core policy without changing their state machines.

### Task features

The router derives a closed set of task features from explicit stage inputs and inexpensive deterministic evidence:

- artifact size and estimated context demand;
- number and types of touched files;
- languages and frameworks already detected in the repository;
- work kind: feature, bug fix, refactor, migration, test-only, documentation, configuration, release, or unknown;
- risk signals: authentication, authorization, secrets, payments, persistence, concurrency, infrastructure, dependency changes, or public API changes;
- failure signals: compile error, test assertion, crash, timeout, race, performance regression, flaky test, or checker-only design rejection;
- multimodal requirement when image input is actually present.

Deterministic classification may return `unknown`; unknown is a valid conservative state. A later optional classifier may fill this schema, but it may not create new feature names or model candidates.

## Stage and feature suitability

The following mapping expresses what the system should optimize, not a permanent ranking of brands.

| Stage | Work features that matter most | Strong candidate characteristics | Required separation |
| --- | --- | --- | --- |
| DEFINE / planner | ambiguous product request, large repository, cross-cutting requirements | requirements, architecture, long context, clarification discipline | may match PLAN; must not implement |
| PLAN | multi-file feature, migration, public contract, complex dependency order | architecture, repository comprehension, precise validation | must not implement |
| BUILD / coder | source edits, refactors, tests, migrations, framework-specific work | coding, tool use, context fit, reliable test iteration | cannot approve its own output |
| VERIFY / judge | acceptance criteria, deterministic tests, regression proof | verification, structured output, evidence discipline | must differ from BUILD identity; prefer different family |
| DEBUG | failing tests, compiler errors, runtime crashes, races, performance symptoms | debugging, causal reasoning, code/log comprehension | read-only and different from BUILD identity |
| REVIEW | compare PRD and plan to diff; security, architecture, performance | review, architecture, long context, adversarial stance | must differ from BUILD; provider-family diversity preferred |
| SHIP | release evidence, residual risk, rollback | release, review, structured output | read-only; publication remains human-gated |

## Provisional mapping for the current local registry

The local registry provides objective metadata but not trusted quality benchmarks. Therefore these are seed mappings to validate, not immutable claims.

- `anthropic/claude-fable-5` is a reasonable DEFINE/PLAN and large-diff REVIEW seed because Pi reports a one-million-token context window and 128K maximum output. Its actual quality scores must come from a built-in profile with documented provenance and later local evaluation.
- Direct Anthropic Opus, Sonnet, and Fable models are alternate architect, debugger, reviewer, and shipper candidates when profiled. Smaller Haiku models are natural economy candidates for triage or low-risk verification, not automatic choices for complex approval.
- `openai-codex/gpt-5.5` is a reasonable BUILD seed because it is already the product's configured coding model on a coding-agent provider. It must become a preference, not a hard architectural rule.
- `openai-codex/gpt-5.6-sol`, `terra`, and `luna` are eligible only through explicit profiles or evaluated family rules. Their names alone do not establish which one is premium, balanced, or economical.
- OpenRouter exposes many viable families and aliases. It should participate when the user's policy permits gateway models, cost metadata is known, and the profile confidence is sufficient. `openrouter/auto` may be an explicit user choice but is not a transparent default because it hides the resolved model unless the adapter records it.
- When BUILD uses an OpenAI-family model, the default checker preference should favor an eligible non-OpenAI family. When BUILD uses Anthropic, the inverse applies. If no diverse checker exists, policy decides whether to allow same-family/different-model fallback or fail closed.

For an initial shadow evaluation on this machine, retain `anthropic/claude-fable-5` as the DEFINE/PLAN seed and `openai-codex/gpt-5.5` as the BUILD seed. Compare the direct Claude Fable, Opus, and Sonnet families as independent VERIFY/DEBUG/REVIEW candidates for an OpenAI BUILD. Compare the GPT-5.6 Codex family as independent checker candidates for an Anthropic BUILD. Do not encode a permanent ordering among Opus, Sonnet, Fable, Sol, Terra, or Luna until repository-specific evaluations support it. This gives the project a safe baseline and a genuine cross-family experiment without turning unverified model branding into architecture.

## Routing policy

### Modes

`quality` maximizes stage capability and evidence confidence within hard cost ceilings. `balanced` trades modest quality score for lower estimated cost and latency. `economy` selects the least expensive candidate above stage minimums. `pinned` uses only explicit stage pins. `custom` accepts project-defined weights.

Default mode is `balanced` for interactive runs and remains configurable. High-risk REVIEW and SHIP apply a quality floor even in economy mode.

### Eligibility

A model is eligible only when it is callable on the active surface; accepts all required input types; supports required structured tools through that surface; has enough context and output capacity; satisfies provider allow/deny, privacy, and cost rules; has sufficient profile confidence; and satisfies maker/checker separation. BUILD also requires mutation-capable agent tools, but that is a stage environment constraint rather than a model property.

### Scoring

For each eligible model, pure core policy computes:

    capability fit
    + task-feature fit
    + profile-confidence bonus
    + bounded observed-evidence adjustment
    + provider-diversity bonus
    - estimated cost penalty
    - latency penalty when available
    - fallback/recent-failure penalty

Scores are integer basis points to avoid floating-point drift. Tie breakers are explicit pin order, higher confidence, lower estimated cost, provider/model lexical order. Every component is present in the explanation.

### Thinking level

Thinking level is selected independently from model identity. Stage policy defines a target range, the adapter reports supported levels, and budget policy clamps the choice. DEFINE/PLAN/DEBUG/REVIEW normally prefer high reasoning; simple BUILD and VERIFY work may use medium or high; high-risk work may require `xhigh` or `max` only when the model and budget support it. Unsupported levels are clamped and journaled, never silently assumed.

### Fallback

The router returns an ordered candidate list. The adapter attempts each candidate and records model-not-found, authentication, rate-limit, provider, or unsupported-feature failure categories without persisting secrets. A fallback never relaxes hard safety constraints. If no eligible model remains, the run pauses with a report of constraints and remediation choices. It does not quietly use an arbitrary model.

## Proposed configuration

Existing `roles.*` exact configs remain compatible as pins/fallbacks during migration. New configuration is additive:

    {
      "routing": {
        "mode": "balanced",
        "allowInferredProfiles": false,
        "separation": {
          "checkerMustDifferFromBuilder": true,
          "preferDifferentProviderFamily": true,
          "requireDifferentProviderFamilyFor": ["review", "ship"]
        },
        "limits": {
          "maxEstimatedUsdPerRun": 8,
          "maxAttemptsPerStage": 3
        },
        "stages": {
          "build": {
            "prefer": ["openai-codex/gpt-5.5"],
            "minimumScores": { "coding": 75, "structuredOutput": 60 }
          },
          "review": {
            "minimumScores": { "review": 80, "architecture": 70 }
          }
        },
        "profiles": {
          "my-provider/my-model": {
            "family": "my-model-family",
            "confidence": 90,
            "scores": { "coding": 85, "debugging": 80, "review": 65 }
          }
        }
      }
    }

Repository configuration may set model policy and profiles but must not define trusted provider endpoints or credentials. User config wins for explicit deny rules and spending ceilings so an untrusted repository cannot loosen them. Project config may tighten user safety policy but cannot broaden it.

## Core interfaces

`src/core/modelRouting.ts` will own pure shared types and selection. The target interfaces are:

    export interface DiscoveredModel {
      provider: string;
      model: string;
      family?: string;
      api?: string;
      callable: boolean;
      reasoning: boolean;
      supportedThinking: ThinkingLevel[];
      input: Array<"text" | "image">;
      contextWindow: number;
      maxOutputTokens: number;
      cost?: ModelCost;
    }

    export interface RoutingRequest {
      stage: RoutingStage;
      task: TaskFeatures;
      models: readonly DiscoveredModel[];
      profiles: Readonly<Record<string, ModelCapabilityProfile>>;
      policy: RoutingPolicy;
      priorSelections: readonly ModelSelectionIdentity[];
      evidence?: RoutingEvidenceSnapshot;
    }

    export interface RankedModelCandidate {
      identity: ModelSelectionIdentity;
      thinking: ThinkingLevel;
      score: number;
      scoreBreakdown: ScoreComponent[];
      profile: ResolvedProfileSummary;
    }

    export interface RoutingDecision {
      stage: RoutingStage;
      policyVersion: string;
      eligible: RankedModelCandidate[];
      excluded: ExcludedCandidate[];
      taskFeatures: TaskFeatures;
    }

`rankModels(request)` is pure. Adapter modules normalize Pi or MCP data and perform model switching. Core must never read credentials, call providers, inspect Pi registries, or write artifacts.

## Durable state and explainability

Each model selection record expands to include routing mode, policy version, profile version/provenance, task features, eligible rank, score breakdown, exclusions summary, selected thinking level, attempted candidates, and fallback reason. Large candidate lists may live in `routing.jsonl` while `state.json` retains the active selection summary. `journal.md` keeps a concise human-readable line.

The UI shows stage, selected model, why it won, estimated per-turn price band when known, and separation status. A `/lifecycle models` or equivalent read-only command shows ranked and excluded candidates without starting paid model work. A dry-run command must make routing testable before users trust automation.

## Evaluation and hill-climbing loop

Every completed stage emits a local trace containing model identity, profile/policy version, token and cost observations when available, duration, verdict, fallback count, BUILD iteration, rejection category, and final run outcome. It must not record prompts containing secrets or full source by default.

Evaluation metrics include plan approval/revision rate, first-pass verification rate, false approval discovered later, rejection usefulness, debug-to-fix convergence, total BUILD passes, total cost, time to accepted result, structured-tool compliance, and human override rate. Because a checker verdict is not ground truth, the evidence model weights downstream outcomes more strongly than self-reported approval.

The first hill-climbing release produces recommendations only. It may say that a profile is underperforming for a stage or that a cheaper candidate meets the same quality floor. Applying a change requires explicit user review, writes a versioned policy update, and supports rollback. No unattended loop edits its own production scoring weights.

## Cost, limits, and circuit breakers

Routing must estimate cost from prompt-size bands and Pi cost metadata when available. Unknown cost is a policy state, not zero. User-level daily and per-run ceilings override project settings. The loop stops or asks before crossing a ceiling. It exits early when no work is present, caps fallbacks and BUILD attempts, and avoids re-running full planning after transient provider errors.

Circuit breakers include three failed model switches in one stage, repeated identical checker rejection without changed evidence, no improvement after configured BUILD passes, cost ceiling reached, unavailable required independent checker, corrupt routing state, and policy/profile version mismatch on resume. Every breaker creates an actionable handoff in durable state.

## Security and trust boundaries

Project files are untrusted input. They cannot add provider credentials, redirect endpoints, weaken user deny rules, raise user cost ceilings, or disable mandatory separation set by the user. Profile strings and model metadata are data, not prompt instructions. Routing explanations redact secrets and endpoint headers. Read-only stages retain the existing edit/write and reviewed-bash guards regardless of model selection.

A model selected through an opaque gateway must expose the resolved model identity when possible. If it cannot, strict separation treats its family as unknown and policy determines whether it is eligible. Publication, commit, and PR behavior remains separately gated; routing never grants action authority.

## Surface behavior

Pi uses `ctx.modelRegistry.getAvailable()` and normalizes the full `Model` metadata. It may use `isUsingOAuth()` only to categorize cost/auth policy without persisting tokens. Pi remains the source of truth for local callability.

The MCP server cannot read Pi's registry. It receives a configured MCP model catalog built from trusted user configuration and provider capabilities. Exact planner/judge roles remain valid through migration. Repository config cannot redirect MCP credentials.

Cursor's Markdown-only fallback cannot switch models programmatically. It should render the same ranked recommendation and ask the user to switch when needed. It must preserve maker/checker separation in instructions and artifacts.

## Migration and compatibility

Phase 1 adds the pure model catalog, profiles, policy, dry-run, and explanations while preserving exact legacy behavior behind `routing.engine: "legacy"`. Existing configurations remain valid.

Before active Phase 2 starts, complete the paid interactive validation still pending in `plans/0003-loop-engineering-lifecycle.md`. This establishes a trustworthy baseline for comparison and prevents a new router from hiding defects in the recently shipped lifecycle.

Phase 2 adopts capability routing for lifecycle stages and BUILD. A role pin wins when explicitly configured; otherwise automatic policy ranks local candidates. The fast path migrates planner, coder, and judge to the same core router without changing its Plan -> Code -> Judge state machine. This intentionally changes the current `AGENTS.md` invariant that BUILD is always GPT-5.5. Approval of this PRD authorizes a separately reviewed update to that invariant: BUILD must use a configured or capability-selected implementer, while checker independence remains mandatory. The runtime change and the documentation contract change must land together.

Phase 3 records metrics and provides report-only recommendations. Automatic policy promotion remains out of scope.

Phase 4 brings MCP and Cursor semantics to parity and changes the fresh-install default to capability routing only after shadow-mode comparisons and manual paid-model validation meet acceptance criteria.

## Functional requirements

FR1. The router uses only models proven callable by the active adapter.

FR2. The router supports every lifecycle stage plus fast planner, coder, and judge mappings.

FR3. Users can pin, prefer, deny, and profile provider/model identities and families.

FR4. User policy can set mode, cost limits, profile confidence, context requirements, and separation strength.

FR5. BUILD is dynamically selectable and no longer architecturally pinned to GPT-5.5.

FR6. VERIFY, judge, DEBUG, REVIEW, and SHIP cannot select the exact BUILD model; configured stages can require a different family.

FR7. The decision contains ordered eligible candidates, excluded candidates with reasons, score breakdowns, and selected thinking level.

FR8. Adapters record switch failures and try only the ordered eligible list.

FR9. Resume uses the persisted policy/profile version or pauses for explicit migration; it never silently re-routes a completed stage under a new policy.

FR10. A read-only dry-run command explains routing without invoking a paid model.

FR11. Unknown metadata, unknown cost, and unknown profile confidence have explicit conservative behavior.

FR12. Runtime evidence and policy recommendations are local, versioned, inspectable, and human-approved.

## Acceptance criteria

1. With Fable and all GPT-5.6 candidates removed from a test registry, lifecycle routing still selects suitable configured models when profiles and hard requirements permit.
2. With several available models, the same normalized request produces byte-for-byte equivalent ranked identities and score components across repeated runs.
3. A BUILD selection prevents the exact same model from VERIFY, judge, DEBUG, REVIEW, and SHIP; strict policy also prevents the same family.
4. A model with the highest capability score is excluded when it violates context, cost, privacy, input, or separation constraints, and the dry-run explains the exclusion.
5. Explicit pins reproduce legacy fixed-role behavior.
6. Unsupported thinking levels are clamped with a journal explanation.
7. Pi fallback tries only eligible candidates and persists failure categories.
8. Existing lifecycle state-machine, read-only tool, restoration, approval, and publication tests remain green.
9. Fast `/orchestrate` retains its existing transitions while using shared routing.
10. MCP ignores project endpoint/key overrides and can use a trusted configured catalog.
11. A shadow-mode report compares legacy and capability choices without switching models.
12. Routing evidence can produce a recommendation but cannot mutate active policy without explicit approval.

## Success metrics

The primary metric is accepted outcomes per dollar within the same safety level. Supporting metrics are fewer “model unavailable” aborts, lower manual route configuration, first-pass verifier success, fewer total BUILD passes, useful rejection rate, lower fallback rate, lower cost for low-risk work, and zero maker/checker identity violations. Quality metrics take precedence over raw throughput.

## Risks and mitigations

Capability profiles can become stale. Mitigate with versions, provenance, confidence, last-validated date, user overrides, and evaluation reports.

Local evidence can reinforce a weak checker that approves everything. Weight downstream failures and human overrides more than raw approval rate, and never let evidence bypass hard constraints.

Cost estimates may be wrong or missing. Treat unknown as configurable conservative cost and reconcile with observed usage when available.

Zero cost metadata may mean subscription-backed access rather than unlimited free usage. Preserve authentication/cost provenance where the adapter can safely identify it, and apply request or usage limits independently from dollar estimates.

Provider-family identity can be ambiguous through gateways and aliases. Normalize explicit family metadata and fail closed under strict separation.

Task classification can overfit. Keep the feature schema small, accept `unknown`, expose explanations, and make model-based classification optional.

Dynamic routing can make runs less reproducible. Persist the complete decision and policy/profile versions, support pins, and reuse saved selections on resume unless unavailable.

## Delivery plan map

Implementation is deliberately split into four local ExecPlans under `plans/`, which are not committed:

1. `plans/0004-capability-routing-foundation.md` introduces normalized discovery, profiles, configuration, pure eligibility/scoring, and dry-run explanations.
2. `plans/0005-adopt-routing-across-pi-workflows.md` integrates the router into lifecycle and fast Pi paths, including dynamic BUILD and hard maker/checker separation.
3. `plans/0006-routing-evidence-budgets-and-improvement.md` adds durable traces, cost controls, circuit breakers, shadow comparisons, and human-reviewed recommendations.
4. `plans/0007-routing-mcp-cursor-rollout.md` brings policy semantics to MCP and Cursor, completes migration, documentation, packaging, and release validation.

Each plan is independently verifiable and keeps the existing state machines authoritative.

The plans are not four fully independent parallel projects. Their safe dependency graph is:

    Plan 0003 paid baseline ---------+
                                      +--> Plan 0005 active Pi adoption --> Plan 0006 evidence/budgets --+
    Plan 0004 routing foundation ----+                                                        |          |
                                      +--> Plan 0007 MCP/Cursor prototypes --------------------+----------+--> Plan 0007 rollout decision

Plan 0003's remaining paid baseline and Plan 0004 can run concurrently because one validates existing behavior while the other builds shadow-only pure policy. Plan 0005 must wait for both. After Plan 0005 freezes the active selection and decision schemas, Plan 0006 production work and bounded Plan 0007 MCP/Cursor adapter prototypes may use separate worktrees in parallel. Plan 0007's final integration, migration, documentation, and default-engine decision must wait for Plan 0006 because those surfaces must incorporate the final budget, evidence, and rollback contracts.

Within any parallel wave, each coding agent uses a separate branch worktree. One lane owns each shared file. In particular, `src/core/config.ts`, `src/core/modelRouting.ts`, `src/index.ts`, `extensions/lifecycle.ts`, `src/lifecycle/artifacts.ts`, `README.md`, and `AGENTS.md` must never be edited concurrently by two lanes. Interface-owning changes merge first; dependent lanes rebase and run the full validation contract before integration.

## Open product decisions

Before capability routing becomes the fresh-install default, maintainers must choose the built-in profile distribution mechanism, the minimum evidence sample count for recommendations, the default treatment of unknown OpenRouter cost/profile data, and whether strict different-family review is the default or an opt-in. The plans use conservative defaults: built-in versioned profiles, ten completed stage samples before recommendations, unknown cost treated as non-economy, and different-family preference with exact-model separation required.

## Sources and repository evidence

External research: [Addy Osmani](https://addyosmani.com/blog/loop-engineering/), [LangChain](https://www.langchain.com/blog/the-art-of-loop-engineering), and [cobusgreyling/loop-engineering](https://github.com/cobusgreyling/loop-engineering).

Repository evidence: `src/core/config.ts`, `src/core/lifecycleRouting.ts`, `extensions/lifecycle.ts`, `extensions/orchestrator.ts`, `mcp/llm.ts`, `mcp/server.ts`, `src/core/lifecycle.ts`, `src/core/loop.ts`, and the corresponding files under `test/`.
