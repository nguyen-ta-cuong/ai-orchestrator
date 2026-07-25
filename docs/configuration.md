# Configuration reference

AI Orchestrator combines built-in defaults with trusted user policy and repository policy. This reference explains which settings affect Pi, Cursor MCP, durable execution, routing, and publication.

## Precedence

Configuration is merged in this order:

1. Built-in defaults.
2. `~/.ai-orchestrator/config.json`.
3. `<project>/.ai-orchestrator.json`.

The last source normally wins, but an untrusted project is not allowed to expand trusted authority. On the MCP surface, project config cannot:

- add or change `mcp.providers` or `mcp.models`;
- select the legacy planner or judge that receives trusted credentials;
- broaden trusted privacy rules, remove trusted deny rules, raise cost or execution ceilings, or weaken maker/checker separation;
- redirect the trusted MCP run store;
- activate graph execution unless trusted user config permits project activation;
- grant parallel source writes, commits, pull requests, or publication.

Project policy may tighten those controls. Pi resolves models and credentials through Pi and ignores `mcp.*`.

## Top-level settings

| Setting | Purpose | Built-in default |
| --- | --- | --- |
| `execution` | Graph engine and global execution limits | `graph-shadow` |
| `roles` | Exact legacy role identities and explicit Pi pins | See [role defaults](#role-defaults) |
| `loop` | BUILD pass and rejection caps | 3 passes; re-plan after 2 rejections |
| `approval` | Plan/spec approval policy | Required |
| `judge` | Whether checking runs the detected test command | `true` |
| `lifecycle` | Repository run-artifact path | `.ai-orchestrator/runs` |
| `build` | BUILD integration policy | No per-task commit |
| `routing` | Capability policy, evidence, budgets, and legacy lifecycle candidates | `capability-shadow` |
| `ship` | Commit and pull-request offer policy | Ask |
| `mcp` | Trusted providers, model catalog, and durable run storage | Empty model catalog |

Invalid values fail validation, unrecognized execution-limit fields are rejected, and prototype-pollution keys are dropped.

## A conservative starting configuration

Create user config with private permissions:

```sh
mkdir -p ~/.ai-orchestrator
chmod 700 ~/.ai-orchestrator
if [ ! -e ~/.ai-orchestrator/config.json ]; then
  (umask 077 && printf '{}\n' > ~/.ai-orchestrator/config.json)
fi
chmod 600 ~/.ai-orchestrator/config.json
```

Start with a small policy and add only metadata you have verified:

```json
{
  "execution": {
    "engine": "graph-shadow",
    "allowProjectGraph": false
  },
  "routing": {
    "engine": "capability-shadow",
    "privacy": {
      "allowed": ["local", "private"],
      "allowUnknown": false,
      "providers": {
        "acme": "private"
      }
    },
    "separation": {
      "checkerMustDifferFromBuilder": true,
      "preferDifferentProviderFamily": true,
      "requireDifferentProviderFamilyFor": ["review", "ship"]
    }
  },
  "ship": {
    "commit": "ask",
    "openPr": "ask"
  }
}
```

This does not configure an MCP model. See [Trusted MCP providers and models](#trusted-mcp-providers-and-models) when Cursor should call server-side planners or checkers.

## Model-routing engine

`routing.engine` and `execution.engine` are independent.

| `routing.engine` | Active selection | Use |
| --- | --- | --- |
| `legacy` | Exact configured roles and legacy lifecycle candidate lists | Compatibility rollback |
| `capability-shadow` | Exact routes remain active; capability candidates are ranked observationally | Fresh-install default |
| `capability` | Eligible capability candidates are ranked and tried in order | Reviewed opt-in |

Capability routing never treats a name as proof of ability. It uses callable model facts, explicit profiles, stage requirements, task features, privacy, cost, and separation policy.

### Routing policy fields

| Field | Meaning |
| --- | --- |
| `version` | Policy identity persisted with decisions |
| `mode` | `quality`, `balanced`, `economy`, `pinned`, or `custom` |
| `allowInferredProfiles` | Allow low-confidence generated profiles when stage floors permit |
| `unknownCost` | `exclude`, `penalize`, or `allow` |
| `privacy.allowed` | Allowed classes from `local`, `private`, and `public` |
| `privacy.allowUnknown` | Whether unknown privacy classification is eligible |
| `privacy.providers` | Trusted provider privacy classifications |
| `deny.providers/models/families` | Hard exclusions |
| `separation.checkerMustDifferFromBuilder` | Exclude the exact latest maker |
| `separation.preferDifferentProviderFamily` | Add a diversity preference |
| `separation.requireDifferentProviderFamilyFor` | Checker stages that must prove different family |
| `limits.maxEstimatedUsdPerRun` | Candidate-level estimated cost ceiling |
| `limits.maxAttemptsPerStage` | Candidate attempt cap |
| `stages.<stage>` | Stage-specific requirements, pins, preferences, weights, and thinking |

Routing stages are `define`, `plan`, `build`, `verify`, `debug`, `review`, `ship`, and `fast-judge`.

Each stage accepts:

```json
{
  "prefer": ["provider/model", "family:preferred-family"],
  "pins": [],
  "requiredInput": ["text"],
  "minimumContextWindow": 16000,
  "minimumOutputTokens": 2000,
  "requiresReasoning": false,
  "minimumProfileConfidence": 2500,
  "minimumScores": {
    "architecture": 5000
  },
  "weights": {
    "architecture": 5,
    "requirements": 2
  },
  "thinking": "high"
}
```

Pins and preferences accept exact `provider/model` identities or `family:<family-name>`. Scores and confidence use integer basis points from `0` to `10000`.

### Profiles

A profile declares subjective capability evidence that the provider registry cannot prove:

```json
{
  "routing": {
    "profiles": {
      "team/reasoning-model": {
        "family": "acme-reasoning",
        "confidence": 9000,
        "provenance": "user",
        "version": "team-eval-v1",
        "scores": {
          "requirements": 8500,
          "architecture": 9000,
          "coding": 6500,
          "debugging": 8000,
          "verification": 8200,
          "review": 8400,
          "release": 7800,
          "structuredOutput": 9000,
          "longContext": 8500,
          "speed": 6000,
          "economy": 5000
        }
      }
    }
  }
}
```

Verify these claims yourself. A profile is trusted policy, not model-supplied prose.

## Routing budgets and circuit breakers

The default routing budgets are:

| Setting | Default |
| --- | ---: |
| `maxEstimatedUsdPerStage` | 3 |
| `maxEstimatedUsdPerRun` | 8 |
| `maxObservedUsdPerRun` | 8 |
| `maxEstimatedUsdPerDay` | 24 |
| `maxObservedUsdPerDay` | 24 |
| `maxPaidFallbacksPerRun` | 2 |
| `allowUnknownCost` | `true` |

Default circuit breakers are:

| Setting | Default |
| --- | ---: |
| `maxSelectionFailures` | 3 |
| `repeatedRejectionFingerprintLimit` | 2 |
| `maxBuildPassesWithoutImprovement` | 3 |
| `requireIndependentChecker` | `true` |

Pi persists a private budget ledger even when analytical recommendation evidence is disabled. Unknown observed usage stays unknown; it is never converted to zero. Corrupt or ambiguous budget state fails closed.

Routing evidence defaults to:

```json
{
  "routing": {
    "evidence": {
      "enabled": true,
      "userStoreDir": "routing-evidence",
      "shadowComparisons": true,
      "minRecommendationSamples": 10
    }
  }
}
```

The directory must remain beneath `~/.ai-orchestrator/`. Evidence contains bounded identities, versions, typed outcomes, and usage/cost fields—not prompts, source, diffs, credentials, provider responses, endpoints, or repository remotes.

## Graph-execution engine

| `execution.engine` | Transition authority | Use |
| --- | --- | --- |
| `legacy` | Pure reducers only | Emergency compatibility rollback |
| `graph-shadow` | Reducer decision remains active and is checked against the compiled graph | Fresh-install default |
| `graph` | The graph runner executes the reducer-selected valid edge | Trusted-user evaluation |

Set active graph mode only in trusted user config:

```json
{
  "execution": {
    "engine": "graph",
    "allowProjectGraph": false
  }
}
```

`allowProjectGraph: true` permits a repository to request graph mode; it does not permit the repository to raise limits or grant parallel writes. Restore `graph-shadow` for immediate rollback, or `legacy` if the shadow check itself must be disabled.

The default global limits are deliberately finite:

| Limit | Default |
| --- | ---: |
| Graph steps | 256 |
| Attempts per node | 4 |
| Plan versions | 3 |
| Graph nodes / edges | 256 / 1024 |
| Ready width | 32 |
| Total / model / provider concurrency | 8 / 4 / 4 |
| Wall time | 24 hours |
| Estimated / observed cost | 100 / 100 USD |
| Input / output tokens | 10,000,000 / 2,000,000 |
| Side-effect attempts | 32 |
| Human wait | Allowed, at most 7 days |
| Repeated no-progress fingerprints | 3 |
| Run-transition back edge | 256 |

Project config may lower these trusted ceilings. Execution limits are frozen into durable run authority so resume cannot silently gain a larger budget.

To verify canonical local rollout evidence:

```sh
ai-orchestrator graph-rollout-report 1.2.3
```

Exit status `0` means the trusted release record proves every retirement gate, `2` means a valid evidence-backed no-go, and `1` means invalid or missing evidence. The command reads only fixed files under `~/.ai-orchestrator/graph-releases/<release-version>/`, makes no network call, and changes no configuration.

## Trusted MCP providers and models

`mcp.providers` and `mcp.models` belong in `~/.ai-orchestrator/config.json`. They are ignored when supplied by a project.

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

Supported provider APIs are:

- `anthropic-messages`
- `openai-responses`
- `openai-completions`

Base URLs must use HTTPS. `apiKey` may be a literal or an exact `$ENV_VAR` reference. `${VAR}`, command substitution, and other shell syntax are rejected; AI Orchestrator does not execute configuration.

Catalog fields:

| Field | Meaning |
| --- | --- |
| `provider`, `model` | Required unique identity |
| `family` | Optional maker/checker separation family |
| `reasoning` | Whether the model satisfies reasoning requirements |
| `supportedThinking` | Supported levels from `off` through `max` |
| `input` | Supported `text` and/or `image` input |
| `contextWindow`, `maxOutputTokens` | Hard eligibility limits |
| `cost` | USD per million input/output/cache tokens; all four fields are required together |
| `privacy` | `local`, `private`, `public`, or `unknown` |
| `profile` | Key in `routing.profiles`; defaults to `provider/model` |

The MCP server requests text and validates the checker response itself. It does not depend on provider-native JSON schema. Redirects, timeouts, HTTP failures, empty or truncated responses, unsupported APIs, and invalid verdict JSON are sanitized fallback categories; response bodies, URLs, headers, and credentials are not persisted in routing output.

## Durable MCP run storage

Defaults:

```json
{
  "mcp": {
    "runs": {
      "userStoreDir": "mcp-runs",
      "projectMirror": false,
      "terminalRetentionDays": 30
    }
  }
}
```

The canonical store is partitioned by a digest of the canonical repository path beneath `~/.ai-orchestrator/`. It owns revisions, idempotency receipts, immutable provider-output evidence, plan versions, counters, routing, recovery lineage, and terminal state.

`projectMirror` contains only sanitized status and digests. A repository may disable a user-enabled mirror, but cannot enable or redirect one. `terminalRetentionDays` is policy metadata in the current release; terminal authority is not silently deleted.

## Role defaults

Built-in role identities are compatibility defaults or Pi preferences, not universal model requirements:

| Role | Default |
| --- | --- |
| Planner, judge, spec, verifier, reviewer, debugger, shipper | `anthropic/claude-fable-5`, `xhigh` |
| Coder / lifecycle BUILD | `openai-codex/gpt-5.5`, `xhigh` |

Legacy lifecycle candidate lists prefer Fable for DEFINE, PLAN, and SHIP, and GPT-5.6 Sol for VERIFY, REVIEW, and DEBUG, followed by the remaining built-in candidates. Pi filters candidates through its callable local registry. Explicit user or project role identities act as pins under Pi capability policy; built-in identities remain preferences.

The built-in `fable` MCP provider URL is intentionally invalid. Configure a real endpoint in trusted user config before using it.

## Loop, artifacts, and SHIP

```json
{
  "loop": {
    "maxCoderIterations": 3,
    "plannerEscalationAfterRejections": 2
  },
  "approval": {
    "requirePlanApproval": true
  },
  "judge": {
    "runTests": true
  },
  "lifecycle": {
    "artifactsDir": ".ai-orchestrator/runs"
  },
  "build": {
    "commitPerTask": false
  },
  "ship": {
    "commit": "ask",
    "openPr": "ask"
  }
}
```

Lifecycle artifact paths must be relative and contained in the project. `ship.commit` accepts `ask`, `never`, or `auto`; `ship.openPr` accepts `ask` or `never`. These settings determine whether the UI may offer an action. Every actual commit or pull request still requires fresh confirmation for the current run.

SHIP never pushes. Pull-request creation requires an already-pushed upstream whose tip matches local `HEAD`.

## Migration and rollback

To move from exact MCP roles to active capability routing:

1. Keep working `roles.planner` and `roles.judge` entries for rollback.
2. Add verified provider and model entries to trusted user config.
3. Add profiles and optional exact stage pins.
4. Keep `routing.engine: "capability-shadow"`.
5. Preview `plan` and `fast-judge` with `orchestrator_models`, including the real Cursor `coderIdentity`.
6. Change trusted user config to `"capability"` only after the candidates, exclusions, costs, and separation are correct.

Return to `"legacy"` to restore exact role selection. AI Orchestrator never rewrites the configuration automatically.

For an unfinished Pi lifecycle whose routing policy changed, use `/lifecycle migrate-routing` and confirm the change. Previous decisions remain preserved as evidence.

## Related guides

- [Setup](setup.md)
- [User guide](user-guide.md)
- [Capability-aware routing](adaptive-capability-model-routing-prd.md)
- [Structured graph architecture](graph-architecture.md)
