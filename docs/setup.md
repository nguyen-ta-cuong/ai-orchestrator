# Set up AI Orchestrator

Install AI Orchestrator in Pi, Cursor with MCP, or Cursor without MCP. After installation, continue to the [user guide](user-guide.md).

## Requirements

- Node.js 20 or newer.
- Ripgrep (`rg`) for bounded BUILD-worker search.
- Git, strongly recommended for diff review and lifecycle worktree coordination.
- Pi workflows: Pi with the models you intend to use authenticated in its local registry.
- Cursor with MCP: a trusted provider credential and at least one planner/checker model that is independent of the Cursor coder.

| Environment | Install | Credentials |
| --- | --- | --- |
| Pi | `pi install npm:@miracle3010/ai-orchestrator` | Managed by Pi |
| Cursor with MCP | `npx @miracle3010/ai-orchestrator install-cursor` | Trusted user config |
| Cursor without MCP | `npx @miracle3010/ai-orchestrator install-cursor --no-mcp` | None used by AI Orchestrator |

## Pi

Pi packages and extensions run with system access. Review the package before installing it:

```sh
pi install npm:@miracle3010/ai-orchestrator
```

Restart Pi in the repository where you want to work. Confirm that the package and local model registry are visible without invoking a model:

```text
/lifecycle-models plan
```

Then run a small approved task:

```text
/orchestrate add a focused unit test for the existing parser
```

Pi uses its own authenticated model registry and ignores `mcp.*`. If no eligible model is shown:

1. Authenticate the intended provider/model in Pi.
2. Run `/lifecycle-models <stage>` again.
3. Read the exact exclusion reason.
4. Add or adjust a profile, pin, preference, privacy rule, cost rule, or stage floor in user/project configuration.

Built-in names are preferences and compatibility defaults, not required models.

### Install a source checkout in Pi

```sh
cd /absolute/path/to/ai-orchestrator
npm install
npm run build
pi install /absolute/path/to/ai-orchestrator
```

Pi discovers `extensions/` and `skills/` from the package manifest.

## Cursor with MCP

Run the installer from the Cursor project:

```sh
npx @miracle3010/ai-orchestrator install-cursor
```

A fresh install creates:

```text
.cursor/
├── mcp.json
├── rules/
│   └── ai-orchestrator.mdc
└── skills/
    └── orchestrate/
        └── SKILL.md
```

The installer:

- writes only missing files;
- leaves customized rule, skill, and MCP files untouched;
- prints an MCP server snippet when `.cursor/mcp.json` already exists;
- uses a portable version-pinned `npx` server command when invoked from the published package.

Restart or reload Cursor, enable the `ai-orchestrator` server, and confirm that these eight tools are available:

```text
orchestrator_models
orchestrator_run_start
orchestrator_run_get
orchestrator_run_advance
orchestrator_run_recover
orchestrator_run_cancel
orchestrator_plan
orchestrator_judge
```

Prefer `orchestrator_run_*`. Those tools persist server-owned state across MCP restarts. `orchestrator_plan` and `orchestrator_judge` are compatibility tools for clients that still manage their own counters and recovery.

### Configure trusted providers and models

Create a private user config without replacing an existing file:

```sh
mkdir -p ~/.ai-orchestrator
chmod 700 ~/.ai-orchestrator
if [ ! -e ~/.ai-orchestrator/config.json ]; then
  (umask 077 && printf '{}\n' > ~/.ai-orchestrator/config.json)
fi
chmod 600 ~/.ai-orchestrator/config.json
```

Provider endpoints, API keys, the MCP model catalog, capability profiles, and the active MCP routing engine belong in this trusted user file:

```text
~/.ai-orchestrator/config.json
```

Do not put them in `<project>/.ai-orchestrator.json`; the MCP loader ignores project provider and model entries.

This example defines one server-side model. Replace every capability, limit, price, family, URL, and API type with metadata you have verified:

```json
{
  "mcp": {
    "providers": {
      "acme": {
        "baseUrl": "https://api.acme.example/v1",
        "api": "openai-responses",
        "apiKey": "$ACME_API_KEY"
      }
    },
    "models": [
      {
        "provider": "acme",
        "model": "reasoning-model",
        "family": "acme-reasoning",
        "reasoning": true,
        "supportedThinking": ["off", "low", "medium", "high"],
        "input": ["text"],
        "contextWindow": 128000,
        "maxOutputTokens": 8192,
        "privacy": "private",
        "cost": {
          "input": 3,
          "output": 15,
          "cacheRead": 0.3,
          "cacheWrite": 3.75
        },
        "profile": "team/reasoning-model"
      }
    ]
  },
  "routing": {
    "engine": "capability",
    "privacy": {
      "allowed": ["local", "private"],
      "allowUnknown": false,
      "providers": {
        "acme": "private"
      }
    },
    "profiles": {
      "team/reasoning-model": {
        "family": "acme-reasoning",
        "confidence": 9000,
        "provenance": "user",
        "version": "team-eval-v1",
        "scores": {
          "architecture": 9000,
          "verification": 8500,
          "review": 8500,
          "structuredOutput": 9000,
          "longContext": 8500
        }
      }
    },
    "stages": {
      "plan": {
        "pins": ["acme/reasoning-model"]
      },
      "fast-judge": {
        "pins": ["acme/reasoning-model"]
      }
    }
  }
}
```

Expose the key to the process that launches Cursor:

```sh
export ACME_API_KEY='replace-me'
```

Supported APIs are:

- `anthropic-messages`
- `openai-responses`
- `openai-completions`

Provider URLs must use HTTPS. An API key may be a literal or an exact `$ENV_VAR` reference. `${VAR}` and shell expressions are rejected.

Use `routing.engine: "capability"` for a new catalog-only setup. `capability-shadow` still calls the exact legacy planner/judge roles, so use it only when those routes are already configured and working and you want to compare capability ranking before activation.

See the [configuration reference](configuration.md) for multiple candidates, family separation, budgets, storage, and rollback.

### Verify the MCP path

In Cursor:

1. Call `orchestrator_models` with `stage: "plan"` and a harmless task.
2. Confirm the eligible candidate, score, privacy, and cost treatment.
3. Select a coding-capable Cursor model and record its exact `provider/model` identity.
4. Call `orchestrator_models` with `stage: "fast-judge"` and that `coderIdentity`.
5. Confirm that maker/checker separation is satisfied.
6. Start a small run with `orchestrator_run_start`, inspect the returned plan, and approve it only if correct.

The MCP server routes only its server-side planner and checker. It cannot inspect your repository or switch Cursor’s selected host model.

### Install a source checkout in Cursor

Build the package first, then run the installer from the target project:

```sh
cd /absolute/path/to/ai-orchestrator
npm install
npm run build

cd /path/to/your-project
node /absolute/path/to/ai-orchestrator/bin/ai-orchestrator.js install-cursor
```

This local install writes machine-specific absolute paths. Do not commit them unchanged for teammates.

## Cursor without MCP

Install only the workflow rule and skill:

```sh
npx @miracle3010/ai-orchestrator install-cursor --no-mcp
```

No MCP file is created. The installed instructions require:

1. a written and approved plan;
2. a recorded coding-model identity;
3. implementation and tests;
4. a manually selected independent checker;
5. bounded retry/re-plan counters;
6. a fail-closed stop when independent checking cannot be proven.

Markdown cannot switch models or enforce the state machine. You own the handoffs and records.

## Global Cursor installation

Install beneath `~/.cursor/` instead of the current project:

```sh
npx @miracle3010/ai-orchestrator install-cursor --global
```

Project-local rules may still change Cursor behavior. Review both scopes.

## Validate a source checkout

Run these commands serially because the build cleans `dist/`:

```sh
npm install
npm test
npx tsc --noEmit
npm run build
npm pack --dry-run
```

Do not run tests concurrently with `npm run build` or `npm pack`.

## Update

Update or remove the Pi package, then restart Pi:

```sh
pi update npm:@miracle3010/ai-orchestrator
pi remove npm:@miracle3010/ai-orchestrator
```

For Cursor, run the installer again after updating the npm version. Customized files are reported but not overwritten; merge reviewed changes manually.

## Remove

Remove only the files and entries owned by AI Orchestrator:

- the `ai-orchestrator` entry in `.cursor/mcp.json`;
- `.cursor/rules/ai-orchestrator.mdc`;
- `.cursor/skills/orchestrate/`;
- the equivalent global files under `~/.cursor/`, if installed.

Before deleting durable data:

- stop or finish any active lifecycle run;
- retain run artifacts required by your project;
- inspect `~/.ai-orchestrator/mcp-runs/`, `routing-evidence/`, and `graph-releases/`;
- keep `config.json` while any installation needs its credentials or policy.

Never delete an active `.ai-orchestrator/active-run.json`, `current.lock`, or run directory merely to bypass a blocked state. Resolve or explicitly abandon the run.

## Next

- [Run your first workflow](user-guide.md)
- [Configure routing and execution](configuration.md)
- [Understand the graph runtime](graph-architecture.md)
