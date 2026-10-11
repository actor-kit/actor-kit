---
title: History (the journal)
description: Every transition is journaled; replay, restore, pruning and the R2 archive.
---

Every transition that persists state also appends one row to the actor's **journal**, in the same SQLite
transaction (ADR-013): what caused it (a message, a timer, a service result...), what the handler read from
the outside world (`ctx.now()`, `ctx.id()`, `ctx.random()`), the events it emitted, and a checksum of the
state it produced. A checkpoint of the whole state is written every `checkpointEvery` transitions.

The journal powers:

- **Replay**: `replayJournal(contract, journal)` (`@actor-kit/test`) re-runs it through today's handlers and
  checks every checksum and emitted event, so handler drift fails a test.
- **Restore**: Studio's "restore to here" puts an actor back to an earlier transition (ADR-015).
- **Rebuilds**: a version with `rebuild: "replay"` rebuilds the state from the whole journal.
- **Studio's timeline**, and causation/correlation ids across actors.

## Configuration

```typescript
kit.actor("room", {
  // omitted: journal on, keep everything, checkpoint every 100
  journal: false,                                               // off
  journal: { keep: 50_000, checkpointEvery: 100 },               // prune: older rows are deleted
  journal: { keep: 50_000, archive: "JOURNAL_ARCHIVE" },         // prune, archiving to R2 first
});
```

With `keep`, the journal is cut at the newest checkpoint at or before `lastSeq - keep`; everything before it
goes. The actor's own SQLite storage is capped per object (10 GB), so a long-lived actor should prune.

## Archiving to R2

With `archive` naming an R2 binding (`r2_buckets` in wrangler.jsonc), what pruning removes is first written to
the bucket, one NDJSON **segment** per cut, at `actorType/actorId/<fromSeq>-<toSeq>.ndjson`: the checkpoint it
starts from, the checkpoints inside it, then its events. Only once the segment is in R2 are the rows deleted
locally. If R2 is down (or the binding is missing) nothing is deleted, and the next transition tries again.

Readers fetch segments on demand: a restore to an old transition reads the segment that holds it, a rebuild
reads them all, and `readFullJournal(sql, bucket, { from })` (`@actor-kit/worker/testing`) gives you the
archived and local journal as one, for `replayJournal()` or your own analysis.

Studio's actor header shows where the history lives: the archived ranges and their size, the local range, and
the object's storage, with a warning at 80% of the per-object limit.

Segments are append-only history: don't delete or edit them while the actor may need them (a restore to a
transition whose segment is gone fails with `archive_missing`). Use an R2 lifecycle rule only for history you
are sure you will never restore to.
