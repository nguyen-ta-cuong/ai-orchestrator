# AI Orchestrator

AI Orchestrator helps a coding task move through deliberate, separate roles instead of asking one agent to plan, implement, and approve its own work. It supports a lightweight **Plan → Code → Judge** loop for Pi and Cursor, plus a durable Pi-only lifecycle for larger work.

The package gives you three ways to use the workflow:

- **Pi extension:** `/orchestrate` plans, waits for approval, implements, and asks an independent judge for a structured verdict while switching the active Pi model for each role.
- **Pi lifecycle:** `/lifecycle` persists specification, plan, diagnosis, state, and journal files on disk, adds independent verification, DEBUG, review, and shipping stages, and can resume after a Pi restart.
- **Cursor:** an MCP server gives Cursor planning and judging tools; an instructions-only install is available when MCP servers are not allowed.

The working tree is never reverted automatically. By default, plans require approval, the fast loop stops after three coder passes, and two consecutive rejections trigger re-planning.

## Requirements

- Node.js 20 or newer.
- For Pi workflows: [Pi](https://github.com/badlogic/pi-mono) installed with the models you intend to use authenticated locally.
- For Cursor with MCP: API credentials for the planner and judge providers.
- Git is recommended: the judge reviews Git diffs and the lifecycle records durable run artifacts per worktree.

## Choose a workflow

| Where you work | Install | Start with | Best for |
| --- | --- | --- | --- |
| Pi | `pi install …` | `/orchestrate <task>` | A fast, approval-gated implementation loop |
| Pi | `pi install …` | `/lifecycle <task>` | Larger work that benefits from durable stages and resume |
| Cursor with MCP | `ai-orchestrator install-cursor` | Ask Cursor to use `orchestrator_plan` | Separate planner/judge model calls from Cursor's coder |
| Cursor without MCP | `ai-orchestrator install-cursor --no-mcp` | Follow the installed skill | Organizations that prohibit MCP servers |

## Install for Pi

Install the published package:

```sh
pi install npm:ai-orchestrator
```

For a local checkout, give Pi the absolute package path instead:

```sh
pi install /absolute/path/to/ai-orchestrator
```

Pi discovers `extensions/` and `skills/` from the package. Start or restart Pi in the repository you want to change, then use one of the commands below.

### Fast Plan → Code → Judge loop

```text
/orchestrate add a --version flag to the CLI
```

The extension switches among the configured planner, coder, and judge models. It presents a plan for approval, lets the coder edit and test, then requires the judge to return an `approve` or `reject` verdict. A rejection sends concrete fixes back to the coder; after two consecutive rejections it requests a revised plan. It stops after three total coder passes and leaves the tree untouched for you to inspect.

Useful commands:

```text
/orchestrate <task>          Start an approval-gated run
/orchestrate --yolo <task>   Skip the plan-approval gate for this run
/orchestrate-stop            Cancel the run and restore your prior Pi model
```

`--yolo` skips only the approval gate. It does not bypass testing, the judge, or the iteration cap.

### Durable lifecycle

Use the lifecycle when you want an explicit specification, a reviewable plan, independent checking, and recovery after interruption:

```text
/lifecycle add a --version flag to the CLI
```

The normal path is:

```text
DEFINE → approve → PLAN → approve → BUILD → VERIFY → REVIEW → SHIP
                                           ↘ reject → DEBUG → BUILD / PLAN / failed
```

Each lifecycle run records durable evidence under `.ai-orchestrator/runs/<run-id>/`:

```text
spec.md       approved problem definition and acceptance criteria
plan.md       approved implementation plan
debug.md      read-only diagnosis after a failed verification or review
state.json    current phase, counters, model selections, and recovery state
journal.md    transitions, verdicts, and routing decisions
```

These commands let you control or continue a lifecycle run:

```text
/lifecycle [--yolo] <task>   Create and automatically drive a full run
/lifecycle resume            Continue the active run from its saved phase
/lifecycle-stop              Stop, restore model/tools, and preserve artifacts
/lifecycle-models [stage]    Preview legacy and capability routing without invoking a model
/spec [--yolo] <idea>        Run DEFINE only
/plan                        Run the currently pending PLAN stage
/build                       Run the currently pending BUILD stage
/test                        Run the currently pending VERIFY stage
/debug                       Run the currently pending DEBUG stage
/review                      Run the currently pending REVIEW stage
/ship                        Run the currently pending SHIP stage
```

Standalone stage commands refuse to skip or rewind the saved phase. An interrupted active run can be continued with `/lifecycle resume`. `/lifecycle-stop` deliberately cancels the run and releases its active pointer; it preserves the run directory for inspection, but that stopped run cannot be resumed.

For lifecycle runs, BUILD uses the configured coder (GPT-5.5 by default). DEFINE, PLAN, VERIFY, REVIEW, DEBUG, and SHIP choose the first available model from the configured local Fable/GPT-5.6 preference order. The chosen model and any fallback are written to `state.json` and `journal.md`.

VERIFY, REVIEW, DEBUG, and SHIP are read-only. DEBUG diagnoses the root cause and recommends a smallest safe fix; it does not edit code or consume a BUILD iteration. SHIP never pushes. A commit or pull request requires both the appropriate configuration and explicit interactive confirmation unless configured otherwise.

## Install for Cursor

The installer copies the Cursor rule and shared `orchestrate` skill into the current project. By default it also writes a local MCP configuration when one does not already exist.

From a published package, run this in the Cursor project:

```sh
npx ai-orchestrator install-cursor
```

From a source checkout, build the MCP server first, then run the installer from the target project:

```sh
cd /absolute/path/to/ai-orchestrator
npm install
npm run build

cd /path/to/your-project
node /absolute/path/to/ai-orchestrator/bin/ai-orchestrator.js install-cursor
```

The default install creates or updates these files only when it is safe to do so:

```text
.cursor/rules/ai-orchestrator.mdc
.cursor/skills/orchestrate/SKILL.md
.cursor/mcp.json                     only when it does not already exist
```

Existing customized rule, skill, and MCP files are never overwritten. If `.cursor/mcp.json` already exists, the installer prints a snippet for you to merge. Its generated local MCP entry uses an absolute path, so do not commit that generated entry for teammates. The portable, version-pinned example is [cursor/mcp.json](cursor/mcp.json).

Use `--global` to install the rule and skill under `~/.cursor/` instead of the current project:

```sh
npx ai-orchestrator install-cursor --global
```

### Use Cursor with MCP

After installing, restart or reload Cursor and make sure the `ai-orchestrator` MCP server is enabled. Select your coder model in Cursor (for example, GPT-5.5 with high reasoning); Cursor cannot switch its own model automatically.

For a non-trivial task, ask Cursor to follow the installed AI Orchestrator workflow. It will:

1. Call `orchestrator_plan` and show you the proposed plan.
2. Wait for your explicit approval before editing.
3. Implement and test using Cursor's active coder model.
4. Collect `git diff`, `git diff --staged`, and relevant test output.
5. Call `orchestrator_judge` with that evidence.
6. Follow the returned next action: retry coding, request a revised plan, finish, or stop with the remaining fixes.

The MCP server deliberately does **not** read or modify your project files. Cursor supplies the task, approved plan, diff, test output, and loop counters. The server owns the counter calculation and returns `nextIteration` and `nextConsecutiveRejections`; Cursor must use those returned values rather than inventing its own loop state.

### Use Cursor without MCP

If your organization does not permit MCP servers, install only the rule and skill:

```sh
npx ai-orchestrator install-cursor --no-mcp
```

The instructions-only workflow still requires plan approval, implementation, tests, and a judge-style review. It asks you to switch models at phase boundaries when possible, but continues with the current model if you decline. Because no external judge tool is available, this path has weaker model separation than Pi or Cursor with MCP.

## Configuration

Configuration is merged in this order:

1. Built-in defaults.
2. User config: `~/.ai-orchestrator/config.json`.
3. Project config: `<project>/.ai-orchestrator.json`.

Project configuration is appropriate for model roles, loop limits, and lifecycle behavior. It can safely travel with a repository if that suits your team. MCP provider definitions are different: when the MCP server runs, it intentionally ignores project-level `mcp.providers` so a cloned repository cannot redirect your credentials to an untrusted endpoint. Put MCP endpoints and keys in the user config instead.

### Common project configuration

Create `.ai-orchestrator.json` in the repository to override roles or loop behavior. This example uses a single locally configured Pi provider for the fast loop:

```json
{
  "roles": {
    "planner": { "provider": "anthropic", "model": "claude-fable-5", "thinking": "xhigh" },
    "coder": { "provider": "openai-codex", "model": "gpt-5.5", "thinking": "xhigh" },
    "judge": { "provider": "anthropic", "model": "claude-fable-5", "thinking": "xhigh" }
  },
  "loop": {
    "maxCoderIterations": 3,
    "plannerEscalationAfterRejections": 2
  },
  "approval": { "requirePlanApproval": true }
}
```

Pi resolves the `provider` and `model` values through its local model registry. Configure authentication and provider endpoints in Pi itself; Pi ignores `mcp.providers`.

Thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Every configured role needs `provider`, `model`, and `thinking`.

### Lifecycle configuration

The lifecycle defaults to `.ai-orchestrator/runs`, asks before committing or opening a PR, and does not commit after every task. Override these settings in project config when needed:

```json
{
  "lifecycle": { "artifactsDir": ".ai-orchestrator/runs" },
  "build": { "commitPerTask": false },
  "ship": { "commit": "ask", "openPr": "ask" },
  "routing": {
    "lifecycle": {
      "enabled": true,
      "stages": {
        "define": [
          { "provider": "anthropic", "model": "claude-fable-5", "thinking": "xhigh" }
        ],
        "plan": [
          { "provider": "anthropic", "model": "claude-fable-5", "thinking": "xhigh" }
        ],
        "verify": [
          { "provider": "openai-codex", "model": "gpt-5.6-sol", "thinking": "xhigh" }
        ],
        "review": [
          { "provider": "openai-codex", "model": "gpt-5.6-sol", "thinking": "xhigh" }
        ],
        "debug": [
          { "provider": "openai-codex", "model": "gpt-5.6-sol", "thinking": "xhigh" }
        ],
        "ship": [
          { "provider": "anthropic", "model": "claude-fable-5", "thinking": "xhigh" }
        ]
      }
    }
  }
}
```

Each legacy routing stage must have at least one candidate. These lists drive `legacy` and `capability-shadow`; arrays replace the default list for that stage rather than merging by position. Set `routing.lifecycle.enabled` to `false` to use only the corresponding fixed lifecycle role (`spec`, `planner`, `verifier`, `reviewer`, `debugger`, or `shipper`).

`ship.commit` can be `ask`, `never`, or `auto`; `ship.openPr` can be `ask` or `never`. Even `auto` never pushes, and interactive approval is still required before opening a PR.

### Capability routing

Capability routing is shared by the durable lifecycle and the fast Plan → Code → Judge loop. Set `routing.engine` to `"capability"` to make it active for every role, including BUILD. The conservative fresh default remains `"capability-shadow"`, which keeps legacy selection active while exposing the read-only ranking preview. Set `"legacy"` for the one-setting rollback.

In capability mode, a `roles.*` provider or model written in user or project config is an exact pin. An untouched built-in role (including `openai-codex/gpt-5.5` for BUILD) is only a tie-breaking preference. Checkers cannot select the exact latest BUILD identity; strict family separation can additionally be required per stage. Each lifecycle run stores a compact selection summary in `state.json`, an explanation in `journal.md`, and the full append-only decision and fallback trace in `routing.jsonl`.

Run the read-only preview with any lifecycle stage or `fast-judge`:

```text
/lifecycle-models review
```

The report shows the locally available legacy choice, ordered capability candidates, selected thinking level, score components, and typed exclusions. It ends with `Shadow only; no model invoked or selected.` The command waits for the current agent to become idle, reads `ctx.modelRegistry.getAvailable()`, and does not switch models, call an LLM, start a run, or write lifecycle artifacts.

Profiles contain subjective, user-overridable policy claims. All capability scores and confidence values are integer basis points from `0` through `10000`; for example, `8000` represents 80%. Objective facts such as callability, text/image input, reasoning support, context, output limit, and cost come from Pi metadata instead.

```json
{
  "routing": {
    "engine": "capability",
    "mode": "balanced",
    "allowInferredProfiles": false,
    "unknownCost": "penalize",
    "deny": {
      "providers": [],
      "models": ["untrusted/opaque-model"],
      "families": []
    },
    "limits": {
      "maxEstimatedUsdPerRun": 8,
      "maxAttemptsPerStage": 3
    },
    "separation": {
      "checkerMustDifferFromBuilder": true,
      "preferDifferentProviderFamily": true,
      "requireDifferentProviderFamilyFor": ["review", "ship"]
    },
    "stages": {
      "review": {
        "prefer": ["my-provider/my-reviewer"],
        "minimumScores": { "review": 8000, "architecture": 7000 }
      }
    },
    "profiles": {
      "my-provider/my-reviewer": {
        "family": "independent-review-family",
        "confidence": 9000,
        "provenance": "project",
        "version": "team-eval-v1",
        "scores": {
          "architecture": 8000,
          "verification": 8500,
          "review": 9000,
          "structuredOutput": 9000,
          "longContext": 8000
        }
      }
    }
  }
}
```

Modes are `quality`, `balanced`, `economy`, `pinned`, and `custom`. Hard constraints always run before scoring. Unknown profiles are excluded unless `allowInferredProfiles` is enabled; inferred profiles start with zero confidence and do not satisfy normal stage floors. Unknown cost follows `unknownCost: "exclude" | "penalize" | "allow"` and is never treated as free. User-level deny lists, cost/attempt ceilings, and separation requirements cannot be weakened by project configuration; a project may only add denials or tighten those limits. To reproduce the old behavior exactly, use `"engine": "legacy"`; to keep capability ranking observational, use `"capability-shadow"`.

### MCP provider configuration

Put provider credentials in `~/.ai-orchestrator/config.json`, not the repository. The server supports `anthropic-messages`, `openai-responses`, and `openai-completions` request formats.

```json
{
  "mcp": {
    "providers": {
      "anthropic": {
        "baseUrl": "https://api.anthropic.com/v1",
        "api": "anthropic-messages",
        "apiKey": "$ANTHROPIC_API_KEY"
      },
      "openai": {
        "baseUrl": "https://api.openai.com/v1",
        "api": "openai-responses",
        "apiKey": "$OPENAI_API_KEY"
      }
    }
  }
}
```

`baseUrl` must be HTTPS. An `apiKey` may be a literal secret or an exact `$ENV_VAR` reference; shell syntax such as `${KEY}` is rejected. Set the named environment variable in the environment that starts Cursor. The default Fable provider URL is intentionally invalid until you supply the endpoint for your Fable service.

## Defaults and safety behavior

| Setting | Default |
| --- | --- |
| Planner / judge | `anthropic/claude-fable-5` at `xhigh` |
| Coder / lifecycle BUILD preference | `openai-codex/gpt-5.5` at `xhigh` |
| Fast-loop coder passes | 3 |
| Rejections before re-plan | 2 consecutive |
| Plan approval | Required |
| Lifecycle commit | Ask |
| Lifecycle PR | Ask; never push |

Legacy/shadow lifecycle selection prefers Fable for DEFINE, PLAN, and SHIP, and GPT-5.6 Sol for VERIFY, REVIEW, and DEBUG. Capability mode instead ranks the callable Pi registry against per-stage profiles, task evidence, policy limits, and maker/checker separation, then records typed fallback reasons.

## Development and validation

Clone the repository and install dependencies:

```sh
npm install
npm test
npx tsc --noEmit
npm run build
npm pack --dry-run
```

`npm run build` clears generated `dist/` output before compiling, so repeated builds do not package deleted modules. A source checkout must be built before running `bin/ai-orchestrator-mcp.js` directly.

## Troubleshooting

### Pi says a model is unavailable

The model must exist and be authenticated in Pi's local registry. Check Pi's model list and either configure the requested provider/model there or change the project role/routing configuration to a model you can use. The lifecycle records fallback attempts in its journal.

### Cursor cannot connect to the MCP server

For a source checkout, run `npm run build` before installing or launching the server. Restart Cursor after changing `.cursor/mcp.json`. If you installed into a project with an existing MCP file, merge the installer’s printed snippet rather than expecting it to overwrite the file.

### The MCP server reports a missing API key or invalid provider

Set the named environment variable and put the provider endpoint in `~/.ai-orchestrator/config.json`. Do not place secrets or `mcp.providers` in the repository config: MCP intentionally ignores project-level providers as a credential-protection boundary.

### Cursor does not have orchestrator tools

Verify the MCP server is enabled in Cursor. If MCP is unavailable by policy, run `ai-orchestrator install-cursor --no-mcp` and follow the installed manual workflow instead.

### A run stopped or Pi was restarted

Use `/orchestrate-stop` to cancel a fast loop. For an interrupted lifecycle run that remains active, use `/lifecycle resume` to continue from disk. Use `/lifecycle-stop` to cancel a lifecycle run and preserve its artifacts for inspection; stopping releases the active run pointer, so that run cannot be resumed.

## Package contents

The published package includes the Pi extensions and skills, Cursor rule and MCP snippet, installer and MCP binaries, TypeScript source, and compiled MCP runtime. It intentionally excludes plans and tests.

## License

ISC.
