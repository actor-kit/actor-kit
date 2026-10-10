---
"@actor-kit/core": minor
"@actor-kit/worker": minor
"@actor-kit/test": minor
---

Idempotency keys that cannot collide across actors (ADR-016 §1). An effect id (`seq:index`) is unique only within one actor, so using it alone as a payment idempotency key let two rooms at the same journal position collide.

- A service's third argument is now `effect = { actorType, actorId, effectId, idempotencyKey, attempt, signal }`, with `idempotencyKey = ${actorType}/${actorId}/${effectId}`. Use `effect.idempotencyKey` downstream.
- Forwards carry the same fields (without the signal) to the target: `send(caller, callerType, message, delivery)`, parsed at the RPC boundary (`invalid_delivery` otherwise). The target's handler reads them as `ctx.delivery` (undefined for direct messages); they are journaled as the `delivery` fact, so replay hands them back.
- `simulate()` delivers forwards with `ctx.delivery`; `testActor`'s `send(..., { delivery })` sets `ctx.delivery`.
- New exports: `EffectInfo`, `DeliveryInfo` (`@actor-kit/worker`, `@actor-kit/core`), and `idempotencyKey`, `effectInfo`, `deliveryInfo`, `DeliveryInfoSchema` (`@actor-kit/worker/testing`).
