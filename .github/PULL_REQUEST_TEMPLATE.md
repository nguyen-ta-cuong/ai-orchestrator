## Summary

Describe the user-visible outcome and the policy or adapter that owns the behavior.

## Validation

- [ ] State-machine behavior has a focused test before adapter changes.
- [ ] `npm test` passes.
- [ ] `npx tsc --noEmit` passes.
- [ ] `npm run build` passes.
- [ ] `npm pack --dry-run` contains only intended public files.
- [ ] Security, model-cost, credential, publication, and destructive-operation changes are called out explicitly.
- [ ] Files under `plans/` are not committed.

## Release impact

Note any package metadata, Pi discovery, MCP protocol, Cursor installer, configuration, migration, or rollback impact. Write “None” when there is no release-facing change.
