# @actor-kit/core

## 0.2.0

First v2 pre-release, published under the `next` tag.

### Minor Changes

- 113a787: Restore (ADR-015 D3, ADR-013 step 3): `__restore({ toSeq })` (Studio action `restore`, mutate scope) appends a `restore` event and puts the actor back to journal seq `toSeq`: the state is folded from the newest checkpoint at or before it (checksum-verified), the timers pending then come back with their original deadlines, effects declared only by undone transitions become dead letters with the reason, and service results recorded after `toSeq` are redelivered as new events without calling the service. `foldJournal`/`replayJournal` replay restore events. Checkpoints store the pending timers; service journal events carry their `effectId`; timeline entries carry their journal `seq`, and Studio offers "Restore to here" on them. On wake, a snapshot that lags the journal is rebuilt from it.
- 186c0d7: Durable timers (ADR-015 D2): declare `timers: { name: timer(schema, handler) }`, schedule from message, lifecycle and timer handlers with `ctx.schedule(name, { in | at, key, payload })` and cancel with `ctx.cancel(key)`. Timers are persisted with their deadline in the same transaction as the state, share one Durable Object alarm with outbox retries, fire late ones in order with `ctx.lateBy`, each in its own transaction and journal event (`cause_type: "timer"`), and work with `journal: false`. Studio gets a Timers tab (name, key, due in, redacted payload) with an admin-only "Fire now". `testActor()` records `schedules` and `cancels`.
- 5feb791: Idempotency keys that cannot collide across actors (ADR-016 §1). An effect id (`seq:index`) is unique only within one actor, so using it alone as a payment idempotency key let two rooms at the same journal position collide.

  - A service's third argument is now `effect = { actorType, actorId, effectId, idempotencyKey, attempt, signal }`, with `idempotencyKey = ${actorType}/${actorId}/${effectId}`. Use `effect.idempotencyKey` downstream.
  - Forwards carry the same fields (without the signal) to the target: `send(caller, callerType, message, delivery)`, parsed at the RPC boundary (`invalid_delivery` otherwise). The target's handler reads them as `ctx.delivery` (undefined for direct messages); they are journaled as the `delivery` fact, so replay hands them back.
  - `simulate()` delivers forwards with `ctx.delivery`; `testActor`'s `send(..., { delivery })` sets `ctx.delivery`.
  - New exports: `EffectInfo`, `DeliveryInfo` (`@actor-kit/worker`, `@actor-kit/core`), and `idempotencyKey`, `effectInfo`, `deliveryInfo`, `DeliveryInfoSchema` (`@actor-kit/worker/testing`).

- 9ecb99d: Domain events (ADR-017 §2).

  - Actors declare `events` (name → Zod schema). `ctx.emit(name, payload)` in message and timer handlers parses the payload and records the event; an undeclared name or invalid payload fails the transition.
  - `setup({ events })` returns `message()` / `timer()` helpers with `ctx.emit` typed by the declared events, and `events` for the actor definition.
  - Emitted events are stored on the journal row (`emitted`, migration `0017_emitted`); a transition that only emits is still journaled. `replayJournal()` fails with `JournalEmittedDivergenceError` at the first event that differs.
  - `testActor` returns `emitted`; `simulate()` exposes `sim.events()`. Studio's timeline shows each entry's events, redacted.
  - The auction example emits `BidPlaced`, `BidIgnored` and `AuctionClosed`.

- 3bf5148: States with typed locals (ADR-017 §1): optional `initial` + `states`. The persisted state is `{ shared, phase, local, stateTimers }`; handlers return `ctx.stay(shared, local?)`, `ctx.goto(phase, shared, input?)` or the shared state; exit drops the local and cancels `scope: "state"` timers; `enter` builds the next local. Messages are accepted only in their states plus top-level ones (`wrong_state` otherwise, before guards). `setup({ events, states })` and `quiz.in(phase)` give typed `local`, `stay`, `goto` and `enter`. `simulate()` and replay run them through the step core; Studio marks phase changes. New `examples/quiz` contract.
- e2988d8: Initial v0.1.0 release of Actor Kit.

  Actors on the edge — each actor is a Cloudflare Durable Object with a mailbox, private state, and behavior you define. Binary state sync with per-client views.

  Key features:
  - `defineActor()` + `createActorClass()` for typed actor definitions with contracts
  - Flat messages with role-based guards for authorization
  - Binary-first sync with `schema()` builder, delta encoding, and per-role views
  - Worker-trust auth model via `withCallerIdentity()` (JWT auth available as opt-in)
  - Contract-derived client SDK (`actorClient(contract)`), React hooks (`actorContext(contract)`), test harness (`testActor(contract)`), and DO-to-DO refs (`createRef(contract)`)
  - Sync-only message handlers with Immer `produce()` for state mutations
  - Transactional side effects via `emit()` → SQLite outbox
  - Sequential and parallel state machines
  - Durable timers via `after` and `tick` handlers

### Patch Changes

- 60e1b11: - Zod 4: `message()` infers the payload from the schema's output; empty payloads (`z.object({})`) type as `{ type: K }`. New shared `ContractMessages` / `MessageEvent` types in `@actor-kit/core`.
  - Client: `client.role` is seeded from `initialView.role`, so role-branching UIs render the correct branch during SSR.
  - Studio: live updates survive Durable Object hibernation; connections show role and connected time; manual connect is always available.
  - Storybook: peer range now includes `@storybook/react` 10.
