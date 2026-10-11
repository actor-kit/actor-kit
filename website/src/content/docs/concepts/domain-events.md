---
title: Domain events
description: Record what happened, not only what was asked for, with typed ctx.emit.
---

The journal records every accepted message. **Domain events** record what the actor decided it
means (ADR-017): `BidPlaced`, or `BidIgnored` for a bid that changed nothing.

## Declaring and emitting

```typescript
import { setup } from "@actor-kit/worker";
import { z } from "zod";

const auction = setup({
  events: {
    BidPlaced: z.object({ bidder: z.string(), amount: z.number() }),
    BidIgnored: z.object({ bidder: z.string(), amount: z.number(), reason: z.literal("too_low") }),
  },
});

export const Auction = auction.actor("auction", {
  // ...input, init, roles, views
  messages: {
    BID: auction.message(z.object({ amount: z.number() }), (s: State, { amount }, ctx) => {
      if (amount <= highest(s)) {
        ctx.emit("BidIgnored", { bidder: ctx.caller, amount, reason: "too_low" });
        return s;
      }
      ctx.emit("BidPlaced", { bidder: ctx.caller, amount });
      return { ...s, bids: [...s.bids, { bidder: ctx.caller, amount }] };
    }),
  },
});
```

- `setup({ events })` gives `message()` and `timer()` helpers whose `ctx.emit` is typed by the
  declared events: an unknown name or a wrong payload is a type error. `auction.actor()` takes the
  events from the kit, so the definition does not repeat them.
- The payload is parsed by the event's schema when emitted. An undeclared event or an invalid
  payload fails the transition.
- Emitted events are stored on the journal row of the transition that emitted them (`emitted`).
  A transition that changes nothing but emits is still journaled.

## Testing

- `testActor(contract).send(...)` returns `emitted`.
- `simulate()` exposes `sim.events()`: every actor's events, in commit order, with the seq.
- `replayJournal()` checks that replay emits the same events, in order, and throws
  `JournalEmittedDivergenceError` at the first difference, so it also catches handler drift.

## Studio

The timeline lists each entry's emitted events (payloads redacted like message payloads).

## Publishing to a queue

```typescript
import { queue, setup } from "@actor-kit/worker";

const auction = setup({
  env: z.object({ AUCTION_EVENTS: queue() }),
  events: { /* BidPlaced, AuctionClosed, ... */ },
});

auction.actor("auction", {
  publish: { queue: "AUCTION_EVENTS", events: ["BidPlaced", "AuctionClosed"] },
  // ...
});
```

```toml
# wrangler.toml
[[queues.producers]]
binding = "AUCTION_EVENTS"
queue = "auction-events"
```

Each emitted event named in `publish.events` (a type error if it is not declared in the kit's
`events`; with an `env`, `publish.queue` must be one of its bindings)
gets an outbox row under its effect id, in the same transaction as the state, and is sent to the
Queue binding after commit, with the outbox's retries, dead letters and redrive. Studio's Outbox
panel lists the rows under the service `__publish`. The message body:

```typescript
{ actorType, actorId, seq, index, name, payload, at, causationId, correlationId, idempotencyKey }
```

`idempotencyKey` is `${actorType}/${actorId}/${seq}:${index}` and is stable across retries:
consumers dedupe on it. `simulate()` delivers published messages at once and lists them with
`sim.published("AUCTION_EVENTS")`.
