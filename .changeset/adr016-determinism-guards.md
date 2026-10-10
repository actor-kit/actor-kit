---
"@actor-kit/worker": minor
"@actor-kit/test": minor
---

Determinism guards in the test harness (ADR-016 §5). While a handler (message, lifecycle, timer, `init`, `onDone`, `onError`, link callbacks) runs under `testActor()`, `simulate()` or `replayJournal()`, `Date.now`, argument-less `new Date()`/`Date()`, `performance.now`, `Math.random`, `crypto.randomUUID` and `crypto.getRandomValues` throw `NondeterminismError` (exported from `@actor-kit/test` and `@actor-kit/worker/testing`) naming `ctx.now()`/`ctx.random()`/`ctx.id()`. Globals are restored afterwards, even when the handler throws. A service's `fn` is exempt; the Workers runtime never patches globals (the step core runs handlers through an optional `StepFacts.guard`, which only the harness sets). `replayJournal()` now reports such a handler as `NondeterminismError` instead of a checksum divergence.
