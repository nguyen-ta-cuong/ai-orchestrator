# AI Orchestrator setup

This guide installs AI Orchestrator for Pi, Cursor with MCP, or Cursor without MCP. For day-to-day operation after installation, see the [user guide](user-guide.md).

## Requirements

- Node.js 20 or newer.
- Pi workflows: Pi installed, with the models you intend to use authenticated in Pi's local registry.
- Cursor with MCP: trusted provider credentials and at least one trusted planner/checker model.
- Git is recommended. The lifecycle coordinates one active run per Git worktree and checker prompts use the current diff.

Choose one setup:

| Environment | Install command | Credentials |
| --- | --- | --- |
| Pi | `pi install npm:ai-orchestrator` | Managed by Pi |
| Cursor with MCP | `npx ai-orchestrator install-cursor` | Trusted user MCP config |
| Cursor without MCP | `npx ai-orchestrator install-cursor --no-mcp` | None used by AI Orchestrator |

## Install for Pi

Install the published package after reviewing it; Pi packages and their extensions run with full system access:

```sh
pi install npm:ai-orchestrator
```

For a source checkout, install dependencies first and give Pi the absolute package path:

```sh
cd /absolute/path/to/ai-orchestrator
npm install
npm run build
pi install /absolute/path/to/ai-orchestrator
```

Start or restart Pi in the repository where you want to work. Pi discovers the packaged `extensions/` and `skills/` directories. Confirm discovery without invoking a model:

```text
/lifecycle-models plan
```

Pi uses its own authenticated model registry and ignores all `mcp.*` configuration. If preview reports no eligible model, authenticate or configure the intended model in Pi, then inspect the exclusions shown by `/lifecycle-models <stage>`.

## Install for Cursor

Run the installer from the Cursor project:

```sh
npx ai-orchestrator install-cursor
```

A fresh install creates:

```text
.cursor/rules/ai-orchestrator.mdc
.cursor/skills/orchestrate/SKILL.md
.cursor/mcp.json                     only when absent
```

The installer never overwrites customized rule, skill, or MCP files. When `.cursor/mcp.json` already exists, merge the printed server snippet manually. The published `npx` install writes a portable version-pinned MCP command.

To install from a source checkout, build it and run its installer from the target Cursor project:

```sh
cd /absolute/path/to/ai-orchestrator
npm install
npm run build

cd /path/to/your-project
node /absolute/path/to/ai-orchestrator/bin/ai-orchestrator.js install-cursor
```

A source-checkout install writes machine-specific absolute paths; do not commit those paths for teammates.

Other installation modes:

```sh
# Install under ~/.cursor instead of the current project
npx ai-orchestrator install-cursor --global

# Install instructions only; do not create mcp.json
npx ai-orchestrator install-cursor --no-mcp
```

Restart or reload Cursor after installation. For MCP mode, enable the `ai-orchestrator` server and confirm that these tools are available:

- `orchestrator_models`
- `orchestrator_plan`
- `orchestrator_judge`

### Configure trusted MCP providers and models

Secure the trusted user directory and config file **before** adding provider credentials. This creates a private `{}` file only when one does not already exist:

```sh
mkdir -p ~/.ai-orchestrator
chmod 700 ~/.ai-orchestrator
if [ ! -e ~/.ai-orchestrator/config.json ]; then
  (umask 077 && printf '{}\n' > ~/.ai-orchestrator/config.json)
fi
chmod 600 ~/.ai-orchestrator/config.json
```

Edit `~/.ai-orchestrator/config.json`. Provider endpoints, API keys, model catalogs, profiles, and the active MCP routing engine belong in this trusted user file—not in repository config.

The following is a minimal capability-routing shape. Replace the provider URL, API type, model metadata, prices, and capability claims with values verified for your provider:

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
          "verification": 8000,
          "review": 8000,
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

Set the referenced environment variable in the environment that launches Cursor:

```sh
export ACME_API_KEY='replace-me'
```

An API key may instead be a literal value, but the user config then contains credentials and must retain private permissions. AI Orchestrator preserves credential-safe permissions when it applies or rolls back trusted-user routing recommendations.

Supported MCP APIs are `anthropic-messages`, `openai-responses`, and `openai-completions`. Provider URLs must use HTTPS. API-key references must be an exact `$ENV_VAR`; `${VAR}` and shell expressions are rejected.

Start with `"engine": "capability-shadow"` if you already have working exact `roles.planner` and `roles.judge` routes and want observational previews before activation. A fresh catalog-only setup should use `"capability"`; shadow mode still calls the exact legacy routes.

### Verify MCP routing

In Cursor:

1. Call `orchestrator_models` for `stage: "plan"` and confirm the expected eligible candidate and privacy/cost policy.
2. Call `orchestrator_plan` with a harmless task and repository context.
3. Record the exact Cursor coding model as canonical `provider/model`.
4. Call `orchestrator_models` for `stage: "fast-judge"` with that `coderIdentity` and verify independent checking is satisfied.

The MCP server can route only its server-side planner and checker. It cannot switch Cursor's selected coding model.

## Build and validate a source checkout

Run validation serially because the build cleans and regenerates `dist/`:

```sh
npm install
npm test
npx tsc --noEmit
npm run build
npm pack --dry-run
```

Do not run `npm test` concurrently with `npm run build` or `npm pack`; packaged-binary tests may read `dist/` while it is being regenerated.

## Update or remove

Update or remove the Pi package, then restart Pi:

```sh
pi update npm:ai-orchestrator
pi remove npm:ai-orchestrator
```

`pi update` by itself updates Pi, not installed packages. Use `pi update --extensions` to update all unpinned installed packages.

For Cursor, re-run the installer after an npm version update. Customized files are reported, not overwritten; review and merge new guidance manually. To remove it:

- Delete only the AI Orchestrator server entry and installed rule/skill under project `.cursor/`; preserve unrelated servers, rules, and skills.
- Remove global installation from `~/.cursor/` with the same care.
- After all Pi and Cursor installations are removed, delete `~/.ai-orchestrator/config.json` only if no other installation needs its provider credentials or routing policy.
- Review and remove `~/.ai-orchestrator/<routing.evidence.userStoreDir>/` when its budget, evidence, recommendation records, and possible `events.jsonl.quarantine` history are no longer required. The default directory is `routing-evidence`; also check previously configured locations after a path change.
- Do not delete `<git-worktree>/.ai-orchestrator/{active-run.json,current.lock}` or `<run-start-cwd>/<lifecycle.artifactsDir>/` for an active lifecycle run unless you intend to abandon its durable state. The artifact directory defaults to `.ai-orchestrator/runs`, but it is relative to the directory where the run started. Remove terminal run artifacts only after retaining any evidence your project requires.

## Next steps

- Read the [user guide](user-guide.md) for workflows, approvals, resume, routing operations, and publication gates.
- Read the [README configuration reference](../README.md#configuration-and-trust-boundaries) for all catalog and routing fields.
- For setup failures, use the [README troubleshooting section](../README.md#troubleshooting).
