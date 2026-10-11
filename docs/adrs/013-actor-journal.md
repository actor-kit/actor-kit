# ADR 013: Actor Journal — Snapshot Cache + Append-Only Events

**Date**: 2026-10-07
**Status**: Accepted (steps 1–4 implemented; step 3, restore, built as ADR-015 D3; step 4, migrate, as ADR-015 D5's version chain)
**Depends on**: ADR-003 (transactional outbox), ADR-010 (services and execute), ADR-011 (links)
**Replaces**: the unbuilt CDC `change_log` in [phase-5-cf-integration.md](../specs/phase-5-cf-integration.md)

## Context

An actor's state lives in one SQLite row (`snapshots`, `id = 1`) that every transition overwrites. On wake, the row is read and, if `version` changed, passed through the author's `migrate(persisted, fromVersion)`. Nothing else survives:

- **A bad deploy that corrupts state can't be undone.** The corrupted row is the only copy.
- **Migrations can only patch the current blob.** A field derived from history (when did each member join?) can only be guessed, because the history was never kept.
- **Restore to a point in time** exists only through the Studio timeline: the last 500 after-states, and only when Studio is enabled.

actor-kit v1 has the same shape with a weaker migration: it writes `getSnapshot()` to a KV blob and runs `xstate-migrate` on boot, which keeps only the `add` operations of a JSON diff. Removed, renamed and retyped fields pass through silently.

v2 is well placed for event sourcing:

- Handlers are synchronous plain reducers, `(state, payload, ctx) => state`. A Promise return throws (`message-router.ts`). State is a left fold over accepted messages.
- Payloads are parsed by Zod before the handler runs, so an event is the parsed payload plus who sent it.
- Messages, connect, disconnect and init already commit state, executions, links and forwards in one `transactionSync`. An event row written there is exactly as durable as the state.

What breaks replay is anything a handler reads that isn't in the event: `Date.now()`, `Math.random()`, `crypto.randomUUID()`, service results arriving through `onDone`/`onError`, link views arriving through `link.onUpdate`, the targets of an `unlink(name)` that removes every link, and the link views `init` fetches. Three example handlers (auction, chat-room, todo-list) call `Date.now()` or `crypto.randomUUID()` directly.

Two more gaps had to be closed first:

- `onDone`/`onError`, `link.onUpdate` and `link.onError` persist state **outside** a transaction, as does auto-spawn's `init`.
- The state checksum is a 32-bit shift hash marked "replace with xxhash64". Replay verification with a 32-bit hash can miss a divergence.

### Decisions taken with Jon (2026-10-07 grilling)

| Question | Decision |
|----------|----------|
| Opt in or always on? | **Always on**, `journal: false` opts out. |
| Retention | **Keep every event by default.** Pruning is opt-in (`journal: { keep }`), and it never deletes past the newest checkpoint it needs. Pruning silently limits bug-fix replay, restore and replay-migration to the kept window, so it must be a choice, not a default. At ~1 KB/event, a DO's 10 GB limit holds ~10M events. |
| What is restore for? | **Bad deploys and debugging** (Studio, operators). Not player-facing undo: linked actors are not notified, and undo in a game stays an app-level message. |
| v1 games | Stay on `xstate-migrate`. The journal is v2-only. |
| Checksum | **xxHash64 in pure TypeScript** in `@actor-kit/core`, synchronous, no dependency, checked against the reference test vectors. Matches what `binary-protocol.md` already specifies. |
| Deterministic context | `ctx.now()`, `ctx.id()`, `ctx.random()` on **every** handler: messages, lifecycle, `init`, and a new trailing `ctx` argument on `onDone`, `onError`, `link.onUpdate`, `link.onError` and `link.onUnlink`. |
| Immer | CLAUDE.md claimed state changes use Immer `produce()`. No package imports Immer; handlers are plain reducers. The doc is corrected and the unused dependency dropped. |

## Decision

Keep the snapshot as a cache. Add an append-only journal beside it, written in the same `transactionSync` as the snapshot, the outbox and the links. The journal is the source of truth for history; the snapshot is the fast path on wake.

### Tables

```sql
CREATE TABLE events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  cause_type     TEXT NOT NULL,     -- see "Causes" below
  name           TEXT,              -- message type, service name or link name
  payload        TEXT NOT NULL,     -- JSON, after Zod parsing
  caller         TEXT,
  caller_type    TEXT,
  role           TEXT,
  facts          TEXT NOT NULL,     -- JSON, see "Facts"
  code_version   INTEGER NOT NULL,  -- def.version when written
  state_checksum TEXT NOT NULL,     -- xxh64 of the serialized after-state
  created_at     INTEGER NOT NULL,
  correlation_id TEXT,              -- ADR-017 §4: the flow (`type/id/seq` of the event that started it)
  causation_id   TEXT,              -- ADR-017 §4: the event or effect that caused this one (NULL: starts a flow)
  emitted        TEXT               -- ADR-017 §2: JSON array of { name, payload } (NULL: none)
);

CREATE TABLE journal_checkpoints (
  seq      INTEGER PRIMARY KEY,     -- after-state of this event
  version  INTEGER NOT NULL,
  state    TEXT NOT NULL,           -- serialize(state) as JSON
  checksum TEXT NOT NULL
);
```

A checkpoint is written every `checkpointEvery` events (default 100). Checkpoints let a pruned journal still replay, and give step 3 a bounded replay on wake.

### Causes

| `cause_type` | `name` | `payload` | Replay applies |
|---|---|---|---|
| `init` | — | parsed input | `def.init(payload, ctx)` |
| `message` | message type | parsed payload | `handler(state, payload, ctx)` + `onUnlink` for recorded unlinks. **No guard**: only accepted messages are journaled, and replay never asks again. |
| `lifecycle.connect` / `lifecycle.disconnect` | — | `{ callerConnections }` (`{}` in events written before ADR-015) | `lifecycle.connect/disconnect(state, { caller, callerType, callerConnections }, ctx)` |
| `service.onDone` | service | `{ input, result, effectId }` | `onDone(state, result, input, ctx)` |
| `service.onError` | service | `{ input, error: { message }, effectId }` | `onError(state, error, input, ctx)` |
| `link.onUpdate` | link | `{ sourceId, view }` | `onUpdate(state, view, sourceId, ctx)` |
| `link.onError` | link | `{ targetId, error: { message, code } }` | `onError(state, error, targetId, ctx)` |
| `migrate` | — | `{ fromVersion, toVersion }` | Version bump (ADR-015 D5): always checkpointed; replay across older versions starts there |
| `restore` | — | `{ toSeq }` | State (and pending timers) as they were after `toSeq` (ADR-015 D3); replayed by `foldJournal`. |
| `timer` | timer name | `{ id, key, payload, fireAt, lateBy }` | `timers[name].handler(state, payload, { key, lateBy, ...ctx })` (ADR-015 D2) |

Every transition that persists state appends exactly one event. A rejected message (no role, validation, guard) appends nothing.

### Facts

Facts are what the handler read from the outside world, captured at write time so replay never asks again:

```ts
type Facts = {
  now?: number;            // ctx.now(): one timestamp per event, stable across calls
  ids?: string[];          // ctx.id(): crypto.randomUUID() live, in call order
  randoms?: number[];      // ctx.random(): Math.random() live, in call order
  unlinked?: { name: string; ids: string[] }[]; // targets of unlink(name) with no id
  linkViews?: { name: string; id: string; view: unknown }[]; // views init's ctx.link() returned
};
```

Service results and link views are not facts; they are the event's payload. On replay, a handler that calls `ctx.id()` or `ctx.random()` more times than recorded fails loudly as non-deterministic.

### Side effects never re-run

`ctx.execute`, `ctx.link`, `ctx.unlink` and `ctx.forward` are no-ops on replay. The outbox already records executions and forwards with their status; replay only rebuilds state.

### Restore (step 3, built by ADR-015 D3)

`stub.__restore({ toSeq })` appends a `restore` event whose after-state is the fold up to `toSeq`. It never deletes history, so undoing a restore is another restore. Restore does not notify linked actors (decision above). Pending timers, effects and recorded results are handled as ADR-015 D3 describes; checkpoints also store the pending timers so a fold can start from one.

### Configuration

```ts
defineActor("chat-room", {
  journal: false,                                  // opt out entirely
  journal: { keep: 50_000, checkpointEvery: 100 }, // opt into pruning
  // omitted: journal on, keep everything, checkpoint every 100
});
```

With `keep`, events at or below the newest checkpoint `B` with `B <= lastSeq - keep` are deleted with older checkpoints. Replay of a pruned journal starts from checkpoint `B`.

With `journal: { keep, archive: "R2_BINDING" }` (ADR-019 D), those rows go to R2 first: after the commit, the
runtime writes them as one NDJSON segment (`actorType/actorId/<fromSeq>-<toSeq>.ndjson`: the base checkpoint,
the checkpoints inside, then the events, each line `{ kind, row }`), and only then deletes them locally and
records the segment in the `journal_archive` table (`from_seq`, `to_seq`, `key`, `bytes`, `archived_at`).
Restore and rebuilds by replay fetch the segments they need (`readFullJournal`). A failed put deletes nothing.

### Verification: `replayJournal()` (step 2)

`@actor-kit/test` exports `replayJournal(contract, journal)`. It folds the journal through the contract's current handlers (from `init`, or from the base checkpoint of a pruned journal), recomputes the checksum after every event and throws on the first divergence, naming the `seq`, cause and both checksums. `readJournal(sql)` in `@actor-kit/worker/testing` reads and Zod-parses the two tables from a DO's storage. Every example actor runs through both in the integration suite, which is how hidden non-determinism is found.

### Order of work

1. **Record** (this ADR): tables, append in every transaction, deterministic ctx, transactional `onDone`/`onError`/link callbacks/auto-spawn, xxHash64.
2. **Verify** (this ADR): `readJournal` + `replayJournal` over every example actor.
3. **Restore**: snapshot `last_seq`, replay-on-wake from the last checkpoint, `__restore({ toSeq })`, Studio "restore to here", timeline rebased on the journal.
4. **Migrate**: `upcast` on message definitions, rebuild-by-replay on a breaking `version` bump, R2 archive for pruned events. Until then, a journal that spans a `version` bump replays only under the handlers that wrote it.

## Consequences

### Positive

- History survives every transition. A bad deploy can be fixed by correcting the handler and replaying (step 3).
- Fields derived from history become exact in a migration, because the facts were captured (step 4).
- `ctx.now()`/`ctx.id()`/`ctx.random()` make handlers deterministic by construction; `replayJournal` in CI catches the ones that aren't.
- Service and link callbacks now persist atomically, closing a crash window where state and its event could disagree.
- The state checksum becomes a real 64-bit hash, as the binary protocol doc already specified.

### Negative

- One more row written per transition, plus a checkpoint row every 100. Storage grows without bound unless `keep` is set.
- Authors must use `ctx.now()`/`ctx.id()`/`ctx.random()` instead of the globals. Lint can flag the globals later; until then, `replayJournal` is the check.
- `onDone`, `onError`, `onUpdate` and `onUnlink` gain a trailing argument. Existing callbacks keep working; the signature is longer.
- Changing the checksum algorithm changes every view checksum. A client holding a pre-upgrade checksum gets one full snapshot on reconnect instead of an ack.

### Neutral

- The Studio timeline kept its own table until ADR-017 §5, which made it a view over `events` and dropped the table.
- `runtime/cdc.ts` (the unbuilt CDC delta log) is superseded: a delta log can't replay through new code; an event log can.
- A journal that spans a `version` bump doesn't replay under the new handlers until step 4 adds upcasters.

## Addendum: the format frozen for 0.3 (ADR-018 F, 2026-10-11)

- **Emitted events across versions.** A `versions` step may declare `emitted: { Name: (old) => new }` and
  `renames: { Old: "New" }`, both keyed by the event's name before that step (payload upcast first, then
  the rename). Replay upcasts each entry's recorded `emitted` from the version that wrote it before
  comparing them with what the handlers emit now. A rebuild by replay (`rebuild: "replay"`) still skips
  checksums, but now compares emitted events (upcast), so handler drift during a rebuild is caught.
  `upcastEmitted(def, event)` gives journal readers the events in the current vocabulary.
- **Rejections are not journaled.** A refused message is a row in `rejections` (code, message name,
  caller, role, payload hash, time; the newest 1000 kept) plus a count per code in `rejection_counts`
  (never pruned) and a `actor_kit.message.rejected` log line. Nothing replays them; the payload is never
  stored. Studio shows the counts (`__inspect().rejections`). Migration `0018_rejections`.
- **Every callback can emit.** `lifecycle.connect`/`disconnect`, service `onDone`/`onError` and link
  `onUpdate`/`onError`/`onUnlink` get `ctx.emit`, with the same effect index rules as handlers. A callback
  transition that only emits is still journaled, and its published events get outbox rows like any other.
- **Restore notifies links**: the `restore` entry's commit pushes the restored view to link subscribers
  (verified by `tests/integration/journal-format.test.ts`).
