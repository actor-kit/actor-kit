---
"@actor-kit/core": minor
"@actor-kit/worker": major
"@actor-kit/test": minor
"@actor-kit/studio": patch
---

ADR-018 G: service calls with handles, result schemas and delivery modes. `ctx.execute()` returns the effect id; `ctx.cancel(effectId)` cancels a call (not yet run: never runs; in flight: aborted, late result discarded; row `cancelled`). `onDone`/`onError` get `ctx.effectId`. `result` schemas parse `fn`'s return (only the parsed value is journaled); results over `maxResultBytes` (default 128 KiB) fail as a Defect. `delivery: "at-least-once" | "at-most-once"`: an at-most-once try cut off by an eviction is an `OutcomeUnknown` dead letter; an at-least-once one counts as an `Evicted` attempt (a new built-in error). `effect.record(name, value)` attaches audit facts; one structured log line per attempt. `kit.service()` types a service's callbacks. `simulate()` parses resolved results and honours cancels.
