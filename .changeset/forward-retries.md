---
"@actor-kit/worker": minor
"@actor-kit/studio": minor
---

Forwards retry like executions: `link(Contract, { retry: { attempts, backoff } })` (default 3 tries), failed tries wait as `retrying` on the shared alarm, the last failure is a dead letter, and Studio's redrive takes forwards by effect id. Studio's Outbox lists forwards beside executions.
