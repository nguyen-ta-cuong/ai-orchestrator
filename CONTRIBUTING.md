# Contributing to AI Orchestrator

Thank you for helping improve AI Orchestrator. Changes should preserve the separation between agents that edit code and agents that decide whether the work is complete.

## Before you start

Open an issue or discussion before a large behavioral change so its public contract, model-cost policy, and security impact can be agreed on first. Small bug fixes and documentation corrections can go directly to a focused pull request.

Read `AGENTS.md` and the relevant living specification under `plans/` before changing behavior. Plans are local execution records and must never be committed.

## Architecture boundaries

- `src/core/loop.ts` alone owns fast-path transitions.
- `src/core/lifecycle.ts` alone owns durable lifecycle transitions.
- Code under `src/core/` stays pure apart from configuration file reads already owned by `config.ts`.
- VERIFY, REVIEW, DEBUG, and SHIP stay read-only. DEBUG diagnoses; BUILD edits.
- Pi resolves local models and credentials through Pi. MCP uses only its trusted user provider and model catalog.
- Repository configuration may tighten safety policy but must not redirect trusted credentials or weaken approval, testing, budget, or maker/checker gates.
- The package never pushes automatically and never rewrites, stashes, resets, cleans, or reverts the working tree.

## Development workflow

Use Node.js 20 or newer.

```sh
npm ci
npm test
npx tsc --noEmit
npm run build
npm pack --dry-run
```

Add a focused state-machine test before new transition behavior. Filesystem changes need adversarial coverage for corrupt state, stale ownership, containment, symlinks, lock contention, and cleanup. Routing changes need availability, priority, fallback, deduplication, disabled-mode, separation, and no-candidate coverage.

For Pi extension changes, validate in a disposable repository with inexpensive configured models before using production credentials. Confirm model and tool restoration on success, failure, cancellation, restart, and provider errors.

## Pull requests

Keep each pull request centered on one coherent outcome. Explain the runtime path from trigger to final behavior, include test evidence, and call out security, cost, migration, and publication effects. Do not include credentials, prompts containing private source, lifecycle run artifacts, generated package tarballs, or files under `plans/`.

By contributing, you agree that your contribution is licensed under the repository's ISC License.
