---
title: Projections (read models)
description: Keep a D1 read model of the events actors publish, applied once and in order, and rebuild it from journals.
---

An actor's state answers questions about one actor. Questions across many (a leaderboard, "every
open auction", a search index) need a **read model**: a table kept up to date from the events actors
[publish](/concepts/domain-events/#publishing-to-a-queue) to a Queue. `@actor-kit/projection` is the consumer
that keeps one in D1 (ADR-019 E).

```bash
pnpm add @actor-kit/projection
```

```typescript
import { projection } from "@actor-kit/projection";
import { z } from "zod";

const Placed = z.object({ amount: z.number() });

export const leaderboard = projection({
  queue: "auction-events", // the queue name in wrangler config
  db: (env: Env) => env.READ_DB, // a D1 binding
  apply: (event, { db }) => {
    if (event.name !== "BidPlaced") return [];
    const { amount } = Placed.parse(event.payload);
    return [
      db.prepare("INSERT INTO high_bids (auction, amount) VALUES (?, ?) ON CONFLICT(auction) DO UPDATE SET amount = MAX(amount, excluded.amount)")
        .bind(event.actorId, amount),
    ];
  },
  reset: ({ db }) => [db.prepare("DELETE FROM high_bids")],
});

export default {
  async queue(batch, env) {
    await leaderboard.queue(batch, env);
  },
};
```

```toml
[[queues.consumers]]
queue = "auction-events"
```

`apply` returns D1 statements instead of running them: the projection runs them **in one batch with
the event's cursor row**, so the read model and "what has been applied" never disagree, even when a
Worker dies halfway. Create the read-model tables yourself (a D1 migration); the projection creates
its own bookkeeping tables (`actor_kit_projection_cursor`, `actor_kit_projection_buffer`, or a
prefix you pass as `table`).

## Once, and in order per actor

Queues deliver at least once and in no particular order. Every published event carries `position`:
that actor's published events numbered 1, 2, 3... with no gaps (`seq` skips transitions that publish
nothing). Per actor, the projection:

| The event's position is... | What happens |
|---|---|
| at or before the last applied | a duplicate: acked, not applied |
| the next one | applied with its cursor row, then any buffered events that now follow |
| further ahead | buffered in D1 and acked; applied when the missing event arrives |

`apply` sees `{ actorType, actorId, seq, position, name, payload, at, causationId, correlationId }`,
the same live and in a rebuild. A body that is not a published event is retried (so it ends in the
queue's dead letter queue); when `apply` or the batch fails, that actor's messages are retried after
`retryDelaySeconds` (default 5) and nothing of theirs is applied. `leaderboard.buffered(env)` lists
actors waiting on an earlier event: the producer's outbox retries and dead-letters a send, so a gap
that stays is an outbox dead letter to redrive in Studio.

Two consumers racing on the same event apply it once: the second batch fails on the cursor row and
the projection moves on.

## Rebuild

`rebuild()` empties the read model (`reset`) and replays actors' journals into it through the
[journal query](/studio/setup/) (ADR-019 F), with the positions the actors assigned, so live
consumption continues afterwards without double-applying anything:

```typescript
import { actorJournalSource, studioJournalSource } from "@actor-kit/projection";

// In the same Worker as the actors: the __journal RPC.
await leaderboard.rebuild(env, {
  source: actorJournalSource((type) => (type === "auction" ? env.AUCTION : undefined)),
  actors: [{ actorType: "auction", actorId: "a-1" }],
});

// From anywhere, through Studio behind Cloudflare Access.
const source = studioJournalSource({
  baseUrl: "https://game.example.com",
  headers: { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret },
});
```

A rebuild needs each actor's journal complete from `init` (no `journal: false`, no pruning with
`keep`) and refuses one that is not. It sees the journal as Studio does, so fields named in
`studio.redact` come back redacted: keep them out of read models you will rebuild. Positions match
the live ones as long as `publish.events` has not changed; `at` is the journal event's time, which
can differ from the live message's by a few milliseconds. Do not run a rebuild while the consumer is
live on the same database.
