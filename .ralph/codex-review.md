# Codex Review — Task 2: Create @actor-kit/worker

## Findings

- [P2] Split non-DO helpers out of the worker entrypoint — packages/worker/src/index.ts:4-15
  Importing `createAccessToken`, `parseActorRoute`, or `message` from this package in Node will try to resolve `cloudflare:workers`.
  **Disposition**: By design — @actor-kit/worker IS the CF Workers package per backlog. Same behavior as existing `actor-kit` main export. Not a regression.

- [P2] Preserve callback schemas when normalizing request configs — packages/core/src/types.ts:42-47
  `normalizeRequest()` drops Zod schemas from CallbackDef.
  **Disposition**: Pre-existing code from Task 1 (core package). Not introduced by this task.

- [P2] Check live WebSockets before stopping the tick loop — packages/worker/src/actor.ts:908-910
  `connections.size` can be 0 after hibernation while sockets still exist.
  **Disposition**: Pre-existing code from packages/actor-kit/src/core/actor.ts. Faithful copy — fixing would be a behavioral change outside scope.

## Verdict
No regressions introduced. All findings are pre-existing or by-design.
