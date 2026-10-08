---
"@actor-kit/test": minor
"@actor-kit/worker": patch
---

`simulate()` in `@actor-kit/test` (ADR-015 D4): many actors on a virtual clock with effects as data. Transitions run through the runtime's step core; services wait in `pendingEffects()` until the test resolves or rejects them; forwards are delivered; `advance()` fires timers like `alarm()`; `ctx.id()`/`ctx.random()` are seeded; `branch()` copies a simulation; every simulated journal verifies with `replayJournal()`.

Lifecycle journal events now record `callerConnections` (payload `{ callerConnections }`), so a handler that reads it replays exactly; older `{}` events still replay.
