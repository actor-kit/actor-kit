# @actor-kit/projection

Read models for [Actor Kit](https://actorkit.dev): a Cloudflare Queue consumer that applies the
events actors publish into D1 **once and in order per actor**, and rebuilds a read model from actor
journals (ADR-019 E).

```typescript
import { projection } from "@actor-kit/projection";

export const totals = projection({
  queue: "lot-events",
  db: (env: Env) => env.READ_DB,
  apply: (event, { db }) =>
    event.name === "Placed" ? [db.prepare("INSERT INTO placed (lot, position) VALUES (?, ?)").bind(event.actorId, event.position)] : [],
  reset: ({ db }) => [db.prepare("DELETE FROM placed")],
});

export default { queue: (batch, env) => totals.queue(batch, env) };
```

- Duplicates (position at or before the actor's cursor) are acked, not applied.
- Each event's statements run in one D1 batch with its cursor row.
- An event that arrives before an earlier one is buffered in D1 until the gap fills.
- A failing `apply` retries that actor's messages; an invalid body is retried into the dead letter queue.
- `rebuild(env, { source, actors })` replays journals (via `actorJournalSource` or `studioJournalSource`)
  with the live positions.

Docs: https://actorkit.dev/concepts/projections/
