# AI Orchestrator documentation

AI Orchestrator gives AI-assisted coding work an explicit control loop: one role plans, a maker implements, an independent checker decides whether the result is acceptable, and the user owns every approval or publication boundary.

Choose the shortest guide that answers your question:

| I want to… | Read |
| --- | --- |
| Install AI Orchestrator for Pi or Cursor | [Setup](setup.md) |
| Run `/orchestrate`, `/lifecycle`, or the Cursor MCP workflow | [User guide](user-guide.md) |
| Configure models, routing, budgets, graph execution, or SHIP | [Configuration reference](configuration.md) |
| Understand graph checkpoints, BUILD DAGs, recovery, and rollout | [Structured graph architecture](graph-architecture.md) |
| Understand how model candidates are filtered and ranked | [Capability-aware routing](adaptive-capability-model-routing-prd.md) |
| Contribute code | [Contributing guide](../CONTRIBUTING.md) |
| Report a vulnerability | [Security policy](../SECURITY.md) |

## Product surfaces

| Surface | What AI Orchestrator owns | What you still own |
| --- | --- | --- |
| Pi fast path | Plan → Code → Judge state, role selection, structured verdict, bounded retries | Plan approval, repository review, publication |
| Pi lifecycle | Durable DEFINE → SHIP state, immutable BUILD graph, verification, recovery, routing evidence | Approval gates, worktree trust, candidate integration, publication |
| Cursor with MCP | Durable server-side planning/judging run, revisions, counters, checker routing, recovery lineage | Cursor coder selection, implementation, diff/test collection, approvals |
| Cursor without MCP | Installed workflow instructions | Model handoffs, records, counters, every action |

## Start here

```sh
# Pi
pi install npm:@miracle3010/ai-orchestrator

# Cursor
npx @miracle3010/ai-orchestrator install-cursor
```

Then follow [Setup](setup.md) for verification and [User guide](user-guide.md) for the first run.

## Documentation status

These documents describe the source currently shipped from `main`. Local files under `plans/` are implementation records, are deliberately not published, and are not user documentation.

Two conservative rollout defaults are intentional:

- `routing.engine: "capability-shadow"` keeps configured model routes active while ranking capability candidates for review.
- `execution.engine: "graph-shadow"` keeps the pure reducers authoritative while checking their selected transitions against compiled graphs.

The new routing and graph implementations are available, but shadow defaults stay in place until the required real-world evidence and compatibility window exist.
