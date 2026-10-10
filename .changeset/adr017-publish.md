---
"@actor-kit/worker": minor
"@actor-kit/test": minor
---

Outbound event stream (ADR-017 §3): `publish: { queue, events }` sends each emitted event named in `events` to the Queue binding `queue`. Each gets an outbox row under its effect id (service `__publish`, reserved) with retries, dead letters and redrive, written with the transition and sent after commit. Body: `{ actorType, actorId, seq, index, name, payload, at, causationId, correlationId, idempotencyKey }`, `idempotencyKey = ${actorType}/${actorId}/${effectId}`. `publish.events` must name declared events (type-checked and validated at definition). `simulate()` collects them: `sim.published(queue)`. The auction example publishes `BidPlaced` and `AuctionClosed` to `AUCTION_EVENTS`.
