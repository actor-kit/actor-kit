---
"@actor-kit/core": minor
"@actor-kit/worker": minor
"@actor-kit/test": minor
"@actor-kit/studio": patch
---

ADR-019 B: scoped invocations. `ctx.execute(service, input, { scope: "state" })` makes a call owned by the state that made it: leaving that state cancels it (row `cancelled`, try aborted), and a result that still arrives goes to the service's new `onStale(state, result, input, ctx)` or is journaled as `service.stale` (new cause type, shown in Studio) and ignored. In actors with states, service callbacks run at the state that owns their call and may `stay`/`goto` (typed via `kit.service()`), so sagas step forward from `onDone` and compensate from `onError`; see `examples/checkout-saga` and the Sagas recipe. `simulate().resolve()` delivers late results of such calls to `onStale`. Fix: a row cancelled after the outbox drain listed it is no longer started (`startAttempt` returns null for it).
