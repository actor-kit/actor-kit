---
"@actor-kit/worker": minor
"@actor-kit/studio": minor
---

Effect ids and outbox retries (ADR-015 D1).

- Every execution and forward a transition declares is keyed `seq:index`: the transition's sequence number (the journal seq, or the snapshot's counter with `journal: false`) and the effect's position in that transition. The outbox sorts by (seq, index) as integers. Services get a third argument, `{ effectId, attempt }`, to use as an idempotency key; retries reuse the same id.
- Services retry: `retry: { attempts, backoff: { baseMs, factor, maxMs, jitter } }`, default 3 tries 1s then 5s apart (±20%). Rows go `pending` → `running` → `done` | `retrying` (on the DO alarm) | `failed`. `onError` now runs only after the last try. `failed` rows are dead letters, logged once as an `actor_kit.outbox.failed` wide event.
- The outbox `attempts` column now counts tries (it was always 0). Rows cut off mid-try by a crash run again on wake.
- Redrive: Studio admins (mutate scope) can move a failed row back to `pending` under the same effect id (`POST /__studio/api/actors/:type/:id/actions` `{ action: "redrive", effectId }`, or the `__redrive` RPC). The Outbox panel shows the effect id, the next try and the last error, with a Redrive button on failed rows.
