---
"@actor-kit/worker": patch
"@actor-kit/test": patch
---

Timers: a payload is parsed with the timer's schema once, when the timer fires, in the Durable Object, `simulate()` and `replayJournal()` alike. A timer scheduled without a payload under an `.optional()` schema now fires (it was dropped as "received null" in production while `simulate()` passed it `null`), and schemas with transforms apply them once.
