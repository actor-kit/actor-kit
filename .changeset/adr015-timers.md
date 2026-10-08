---
"@actor-kit/core": minor
"@actor-kit/worker": minor
"@actor-kit/test": minor
"@actor-kit/studio": minor
---

Durable timers (ADR-015 D2): declare `timers: { name: timer(schema, handler) }`, schedule from message, lifecycle and timer handlers with `ctx.schedule(name, { in | at, key, payload })` and cancel with `ctx.cancel(key)`. Timers are persisted with their deadline in the same transaction as the state, share one Durable Object alarm with outbox retries, fire late ones in order with `ctx.lateBy`, each in its own transaction and journal event (`cause_type: "timer"`), and work with `journal: false`. Studio gets a Timers tab (name, key, due in, redacted payload) with an admin-only "Fire now". `testActor()` records `schedules` and `cancels`.
