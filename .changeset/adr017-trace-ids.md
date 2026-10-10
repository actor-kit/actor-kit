---
"@actor-kit/worker": minor
"@actor-kit/test": minor
"@actor-kit/studio": minor
---

Causation and correlation ids on every journal event (ADR-017 §4).

- `events` gains `correlation_id` and `causation_id` (migration `0015_trace_ids`); `readJournal()` returns them as `correlationId` / `causationId` (absent on older rows).
- A client or service message (and init, lifecycle, migrate, restore) starts a flow: its correlation id is its own id, `${actorType}/${actorId}/${seq}`, with no causation. Service results, timer firings and forwards received continue the declaring event's flow, caused by the effect (`${actorType}/${actorId}/${seq}:${index}`); link updates continue the source event's flow, caused by that event.
- Forwards carry the flow to the target in a fourth `send()` argument; link pushes in a sixth `__receiveLinkUpdate()` argument. Both are parsed at the RPC boundary; anything else starts a new flow.
- `simulate()` records the same ids. Studio shows an entry's flow and cause, linking to the causing event (in this actor, or another actor's timeline opened at it with `?entry=N`).
