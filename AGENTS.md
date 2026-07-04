# AGENTS.md — ai-orchestrator

Guidance for coding agents (Codex, pi, Cursor) implementing and maintaining this repository.

The authoritative, living specification is `plans/0001-ai-orchestrator.md` (an ExecPlan; **never commit files under `plans/`**). Read it fully before implementing anything. This file is the condensed map: architecture, folder layout, build order, and rules.

## What this project is

An AI orchestrator that automates a **Plan → Code → Judge** loop across different models:

- **Planner/Architect**: high-reasoning model (default `fable` @ thinking `xhigh`) writes an implementation plan.
- **Human gate**: user approves the plan (default on; `--yolo` skips).
- **Coder**: coding model (default `gpt-5.5` @ `xhigh`) implements the plan with file edits and commands.
- **Judge**: the planner model again reviews `git diff` + test results, returns a structured verdict.
- **Loop policy**: on reject → coder retries with feedback; after **2 consecutive rejections** → escalate back to the planner (re-plan); hard cap **3 total coder iterations** → fail with a report.

All role→model mappings are **user-configurable**; Fable/GPT-5.5 are only shipped defaults.

It ships as **one npm package** with three delivery surfaces:

1. **Pi package** — `extensions/` + `skills/` auto-discovered by `pi install`; an `/orchestrate` command switches the live session's model per phase.
2. **MCP server** — `ai-orchestrator-mcp` stdio binary for Cursor; exposes `orchestrator_plan` and `orchestrator_judge`. Cursor's own agent is the coder (nothing can switch Cursor's model programmatically).
3. **Cursor skill/rules bundle (no MCP)** — for orgs that ban MCP; pure Markdown instructions drive the same loop, prompting the user to switch models manually.

## Architecture

    ┌──────────────────────────────────────────────────────────┐
    │                     src/core/  (PURE)                    │
    │  loop.ts (state machine) · config.ts · prompts.ts        │
    │  tests.ts (test-command detection)                       │
    │  — no pi, no MCP, no fs side effects beyond config read —│
    └───────▲──────────────────▲──────────────────▲────────────┘
            │                  │                  │
    ┌───────┴────────┐ ┌───────┴────────┐ ┌───────┴───────────┐
    │ extensions/    │ │ mcp/           │ │ skills/ + cursor/ │
    │ orchestrator.ts│ │ server.ts      │ │ SKILL.md, .mdc    │
    │ (pi surface)   │ │ llm.ts (fetch) │ │ (instruction-only)│
    └────────────────┘ └────────────────┘ └───────────────────┘

Core design rules:

- **`src/core/` is pure and shared.** The loop state machine (`nextPhase(state, event, config)`) is the single source of truth for loop policy. Both the pi extension and the MCP server's `nextAction` computation call it. Never duplicate loop logic in a surface.
- **State machine phases**: `idle → planning → awaiting_approval → coding → judging → (coding | replanning | done | failed)`. State is JSON-serializable (`OrchestratorState` in the ExecPlan).
- **Config precedence**: built-in defaults ← `~/.ai-orchestrator/config.json` ← `<project>/.ai-orchestrator.json`. `$ENV_VAR` interpolation for `mcp.providers.*.apiKey` only — never shell execution.
- **Pi surface** resolves role models against the user's local pi model registry (`ctx.modelRegistry.find(provider, id)`); it ignores the `mcp.providers` config block. API keys/endpoints are pi's problem.
- **MCP surface** calls planner/judge models itself via a minimal `fetch`-based client (`mcp/llm.ts`, `anthropic-messages` + `openai-responses`/`openai-completions`, ~150 lines max, no per-provider SDKs). It never touches the caller's filesystem: the Cursor agent supplies `diff` and `testOutput`.
- **Judge verdicts are structured, never parsed from prose**: a `judge_verdict` tool on pi (with `terminate: true`), a JSON tool response on MCP.

## Folder structure

    ai-orchestrator/
    ├── AGENTS.md                     # this file (committed)
    ├── README.md                     # user-facing install/config docs (Milestone 5)
    ├── package.json                  # name "ai-orchestrator"; keywords ["pi-package","mcp","cursor"];
    │                                 # bins: ai-orchestrator-mcp, ai-orchestrator; type: module
    ├── tsconfig.json                 # nodenext / es2022 / strict / outDir dist
    ├── plans/                        # ExecPlans — NOT committed
    │   └── 0001-ai-orchestrator.md
    ├── src/core/                     # pure shared logic (unit-tested)
    │   ├── loop.ts                   # Phase, OrchestratorState, LoopEvent, nextPhase()
    │   ├── config.ts                 # loadConfig(cwd): defaults + user + project merge, $ENV interp
    │   ├── prompts.ts                # plannerPrompt, replanPrompt, coderPrompt, judgePrompt
    │   └── tests.ts                  # detectTestCommand(cwd): npm test / pytest / cargo test / go test
    ├── extensions/
    │   └── orchestrator.ts           # pi extension: /orchestrate, /orchestrate-stop, model switching,
    │                                 # judge_verdict tool, tool gating, state persistence, UI status
    ├── skills/
    │   └── orchestrate/
    │       └── SKILL.md              # Agent-Skills-standard skill; shared verbatim by pi AND Cursor;
    │                                 # includes "Without orchestrator tools" fallback section
    ├── mcp/
    │   ├── server.ts                 # McpServer + StdioServerTransport; orchestrator_plan/_judge tools
    │   └── llm.ts                    # minimal provider client (fetch); AI_ORCH_FAKE_LLM=1 stub hook
    ├── cursor/
    │   ├── rules/ai-orchestrator.mdc # Cursor rule driving the loop (MCP path + no-MCP fallback)
    │   └── mcp.json                  # snippet users merge into .cursor/mcp.json
    ├── bin/
    │   ├── ai-orchestrator-mcp.js    # #!/usr/bin/env node → dist/mcp/server.js
    │   └── ai-orchestrator.js        # installer CLI: install-cursor [--no-mcp] [--global]
    └── test/
        ├── loop.test.ts              # loop policy: caps, escalation, yolo, counter resets
        ├── config.test.ts            # precedence + $ENV interpolation
        └── mcp.test.ts               # spawn server, raw JSON-RPC initialize/tools-list, nextAction

Import direction is one-way: `extensions/`, `mcp/`, `bin/` may import `src/core/`; `src/core/` imports nothing from them. `skills/` and `cursor/` are data-only (Markdown/JSON), no code.

## Implementation strategy (build order)

Follow the ExecPlan milestones strictly; each is independently verifiable. Update the ExecPlan's `Progress`, `Decision Log`, and `Surprises & Discoveries` sections as you go.

1. **M1 — Core** (`src/core/*`, `test/loop.test.ts`, `test/config.test.ts`). Scaffold package, tsconfig, deps. Get `npm test` and `npx tsc --noEmit` green. Everything else depends on this.
2. **M2 — Pi extension** (`extensions/orchestrator.ts`, `skills/orchestrate/SKILL.md`). Before writing code, read the pi docs at
   `~/.nvm/versions/node/v24.16.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` (fully), plus `examples/extensions/plan-mode/` and `examples/extensions/structured-output.ts` there. Validate manually per the ExecPlan transcript in a scratch repo, with roles pointed at a **cheap model** via project config. Verify the real default model ids against `pi --list-models` and record them in the ExecPlan Decision Log.
3. **M3 — MCP server** (`mcp/*`, `bin/*`, `cursor/*`, `test/mcp.test.ts`). Consult `node_modules/@modelcontextprotocol/sdk/README.md` for the current registration API. Tests must run keyless via the `AI_ORCH_FAKE_LLM=1` stub.
4. **M4 — No-MCP Cursor fallback**: extend `SKILL.md`, conditionalize the rule, `install-cursor --no-mcp` path. Confirm pi loads the skill with zero validation warnings.
5. **M5 — Docs + packaging**: README, `npm pack --dry-run` includes `extensions/ skills/ dist/ bin/ cursor/` and excludes `plans/ test/`.

## Coding conventions

- TypeScript, ESM (`"type": "module"`), `strict: true`. Node ≥ 20.
- Runtime dependency: `@modelcontextprotocol/sdk` **only**. Dev: `typescript`, `vitest`, `@types/node`. Peer (`"*"`, provided by pi at runtime, never bundled): `@earendil-works/pi-coding-agent`, `typebox`, `@earendil-works/pi-ai`.
- In the pi extension: use `StringEnum` from `@earendil-works/pi-ai` for enum tool params (never `Type.Union` of literals — breaks Google API); guard dialogs with `ctx.hasUI`; throw from tool `execute` to signal errors; keep persisted state JSON-serializable via `pi.appendEntry("ai-orchestrator", state)`.
- The pi extension is loaded uncompiled by pi (jiti); `tsc` exists for type-checking and for building `dist/mcp/` for the bins.
- Tests: vitest, no network, no API keys. New loop behavior requires a loop test first.

## Invariants (do not break)

- Loop caps come from config, defaults 3 / 2; **only** `src/core/loop.ts` decides transitions.
- The pi extension **always restores the user's original model and thinking level** on `done`, `failed`, cancel (`/orchestrate-stop`, Esc-abort), and interrupted-session restart.
- The judge phase must not mutate files: judge tool set is read-only + `bash` + `judge_verdict`, with a `tool_call` guard blocking `edit`/`write` while `phase === "judging"`.
- The working tree is never reverted automatically on failure — the human decides.
- The installer never overwrites an existing `.cursor/mcp.json`; it prints the snippet instead.
- The orchestrator never hardcodes API keys, provider endpoints (outside config defaults), or model ids beyond config defaults.

## Commands

    npm install          # setup
    npm test             # vitest run (loop, config, mcp)
    npx tsc --noEmit     # type check
    npm run build        # tsc → dist/ (needed for bins)
    npm pack --dry-run   # packaging check

Manual pi validation (see ExecPlan Milestone 2 for the full expected transcript):

    cd /tmp/orch-demo && pi install /Users/cuongnguyen/Documents/github/ai-orchestrator && pi
    > /orchestrate <task>

## Questions policy

If a requirement is ambiguous, first check `plans/0001-ai-orchestrator.md` (especially the Decision Log). If still ambiguous, choose the conservative option, implement it, and record the decision + rationale in the ExecPlan's Decision Log rather than stalling — except for anything touching security (key handling, shell execution) or destructive behavior, which requires asking the user.
