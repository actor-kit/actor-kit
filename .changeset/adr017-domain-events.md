---
"@actor-kit/core": minor
"@actor-kit/worker": minor
"@actor-kit/test": minor
"@actor-kit/studio": minor
---

Domain events (ADR-017 §2).

- Actors declare `events` (name → Zod schema). `ctx.emit(name, payload)` in message and timer handlers parses the payload and records the event; an undeclared name or invalid payload fails the transition.
- `setup({ events })` returns `message()` / `timer()` helpers with `ctx.emit` typed by the declared events, and `events` for the actor definition.
- Emitted events are stored on the journal row (`emitted`, migration `0016_emitted`); a transition that only emits is still journaled. `replayJournal()` fails with `JournalEmittedDivergenceError` at the first event that differs.
- `testActor` returns `emitted`; `simulate()` exposes `sim.events()`. Studio's timeline shows each entry's events, redacted.
- The auction example emits `BidPlaced`, `BidIgnored` and `AuctionClosed`.
