# 012: SQLite Storage Layer

**Priority**: P0
**Status**: Proposal
**Consolidates**: [004 (Event Timestamps)](./004-event-timestamps.md), [006 (Event Log)](./006-event-log.md), [009 (Observability)](./009-observability.md)
**Affects**: `createMachineServer.ts`, `wrangler.toml` migration, types, new modules

## Problem

Actor-kit's current persistence layer has four compounding issues:

### 1. Snapshot-only persistence with no event history

There is no record of what events produced the current state. No audit trail, no time-travel debugging, no replay capability. Proposal 006 addressed this but proposed storing events via `storage.put("event:${seq}", entry)` — one KV entry per event, with manual key-range scans and manual pruning. This is workable but clunky compared to a real query engine.

### 2. Broken `getSnapshot()` for persistence

Actor-kit currently persists state using `actor.getSnapshot()`:

```typescript
// src/createMachineServer.ts (current)
#setupStatePersistence(actor: Actor<TMachine>) {
  actor.subscribe(() => {
    const fullSnapshot = actor.getSnapshot();
    this.#persistSnapshot(fullSnapshot).catch(() => {});
  });
}
```

XState distinguishes between two snapshot methods:

- **`actor.getSnapshot()`** — the live in-memory snapshot for rendering (context + state value)
- **`actor.getPersistedSnapshot()`** — the full serializable snapshot including XState internals (history states, child actor state, delayed transition timers, done data)

From the [XState docs on persistence](https://stately.ai/docs/persistence):

> To persist the state of an actor, you should use `actor.getPersistedSnapshot()`:
> ```ts
> const persistedSnapshot = actor.getPersistedSnapshot();
> ```
> Do not use `actor.getSnapshot()` for persistence, as it may contain non-serializable values and internal state that is not meant to be persisted.

This means actor-kit is silently losing XState internal state on every DO restart. In Piqolo, this likely explains the object-spread persistence hacks — when XState internals change but context doesn't, `getSnapshot()` returns an object that compares as "unchanged," so persistence is skipped.

### 3. No server-authoritative event timestamps

Events have no framework-injected timestamp or sequence number. Guards that use `Date.now()` produce non-deterministic results on replay. Clients can fake timestamps (Trivia Jam's speed-based scoring uses client-provided `Date.now()`).

### 4. No structured observability

Only basic `DEBUG_LEVEL` console logging. No way to trace event-to-transition causality, measure processing latency, or query historical transitions.

## Solution: DO SQLite as the unified storage layer

Cloudflare Durable Objects support [SQLite storage](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage-sql/) as a first-class alternative to KV. Switching to SQLite gives us:

- **Structured queries** over events and snapshots (no manual key-range management)
- **Transactional writes** (event + snapshot in one atomic operation)
- **Built-in indexing** for time-range and type-filtered queries
- **Automatic storage management** (Cloudflare handles compaction)

Combined with XState's `inspect` API for capturing transitions, and `getPersistedSnapshot()` for correct serialization, this addresses all four problems in a single initiative.

### workers-qb for type-safe queries

Rather than hand-writing SQL strings, use [workers-qb](https://github.com/nickreese/workers-qb) (specifically `DOQB` for Durable Object SQLite) for type-safe query building:

```typescript
import { DOQB } from 'workers-qb';

const qb = new DOQB(this.ctx.storage.sql);

// Type-safe insert
await qb.insert({
  tableName: 'events',
  data: {
    seq: this.eventSequence,
    timestamp: Date.now(),
    type: event.type,
    caller_id: event.caller.id,
    caller_type: event.caller.type,
    payload: JSON.stringify(redactedPayload),
    state_value: JSON.stringify(nextSnapshot.value),
    checksum: nextChecksum,
  },
}).execute();

// Type-safe query with filtering
const results = await qb.fetchAll({
  tableName: 'events',
  fields: '*',
  where: {
    conditions: ['seq > ?1', 'type IN (?2, ?3)'],
    params: [afterSeq, 'ADD_TODO', 'DELETE_TODO'],
  },
  limit: 100,
  orderBy: 'seq ASC',
}).execute();
```

## Proposed Schema

### `events` table

Append-only log of every event processed by the actor (post-guard).

```sql
CREATE TABLE IF NOT EXISTS events (
  seq           INTEGER PRIMARY KEY,   -- monotonically increasing
  timestamp     INTEGER NOT NULL,      -- server-side Date.now()
  type          TEXT    NOT NULL,       -- event type (e.g. "ADD_TODO")
  caller_id     TEXT    NOT NULL,       -- who sent it
  caller_type   TEXT    NOT NULL,       -- "client" | "service" | "system"
  payload       TEXT,                   -- JSON event data (redacted)
  state_value   TEXT    NOT NULL,       -- JSON XState state value after transition
  checksum      TEXT    NOT NULL,       -- snapshot checksum after transition
  duration_ms   REAL                    -- event processing time
);

CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_caller ON events(caller_id, caller_type);
```

### `snapshots` table

Periodic persisted snapshots tagged with their event sequence.

```sql
CREATE TABLE IF NOT EXISTS snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  seq           INTEGER NOT NULL,      -- event seq that produced this snapshot
  timestamp     INTEGER NOT NULL,      -- when snapshot was taken
  checksum      TEXT    NOT NULL,       -- snapshot checksum
  data          TEXT    NOT NULL,       -- JSON from getPersistedSnapshot()
  FOREIGN KEY (seq) REFERENCES events(seq)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_seq ON snapshots(seq);
```

### `meta` table

Actor-level metadata that persists across restarts.

```sql
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Stored keys:
-- "last_seq"       -> current event sequence number
-- "schema_version" -> migration version for forward compatibility
-- "actor_type"     -> the actor type name
-- "created_at"     -> first initialization timestamp
```

## Event Timestamps and Sequencing

Every event processed by the actor gets server-injected `_timestamp` and `_seq` before reaching the XState machine:

```typescript
// Before (current):
this.actor.send({ ...event, caller, storage: this.ctx.storage, env: this.env });

// After:
private eventSequence = 0;

private sendEvent(event: TEvent, caller: Caller) {
  this.eventSequence++;
  this.actor.send({
    ...event,
    caller,
    storage: this.ctx.storage,
    env: this.env,
    _timestamp: Date.now(),
    _seq: this.eventSequence,
  });
}
```

Type additions:

```typescript
// In types.ts
export type BaseActorKitEvent<TEnv> = {
  caller: Caller;
  storage: ActorKitStorage;
  env: TEnv;
  _timestamp: number;
  _seq: number;
  requestInfo?: RequestInfo;
};
```

The `_seq` counter is persisted in the `meta` table and restored on DO restart:

```typescript
// On initialization:
const row = qb.fetchOne({
  tableName: 'meta',
  fields: 'value',
  where: { conditions: ['key = ?1'], params: ['last_seq'] },
}).execute();
this.eventSequence = row ? parseInt(row.results.value, 10) : 0;

// After each event:
await qb.insert({
  tableName: 'meta',
  data: { key: 'last_seq', value: String(this.eventSequence) },
  onConflict: { column: 'key', data: { value: String(this.eventSequence) } },
}).execute();
```

Framework-injected `_timestamp` is always server-authoritative. If a client sends a `_timestamp` field, it is overwritten:

```typescript
// Client sends:
client.send({ type: "SUBMIT_ANSWER", value: "Paris" })

// Machine receives:
{
  type: "SUBMIT_ANSWER",
  value: "Paris",
  caller: { id: "player-1", type: "client" },
  _timestamp: 1710000000000,  // Server-injected, not client-provided
  _seq: 42,
}
```

Guards can safely use `_timestamp` for deterministic time-based logic:

```typescript
guards: {
  isWithinTimeWindow: ({ context, event }) => {
    const deadline = context.public.currentQuestion.startTime
      + (context.public.settings.answerTimeWindow * 1000);
    return event._timestamp <= deadline;
  },
}
```

## Observability via XState Inspect API

Instead of custom lifecycle hooks (as proposed in 009), use XState's built-in `inspect` callback. This captures all internal events — transitions, actions, guards, invocations — with zero custom instrumentation:

```typescript
import { createActor } from 'xstate';

const actor = createActor(machine, {
  input,
  snapshot: restoredSnapshot,
  inspect: (inspectionEvent) => {
    if (inspectionEvent.type === '@xstate.event') {
      this.#recordEvent(inspectionEvent);
    }
    if (inspectionEvent.type === '@xstate.snapshot') {
      this.#recordTransition(inspectionEvent);
    }
    if (inspectionEvent.type === '@xstate.actor') {
      this.#recordActorLifecycle(inspectionEvent);
    }
  },
});
```

### What the inspect API captures

| Inspect Event Type | What It Contains | Stored In |
|---|---|---|
| `@xstate.event` | Event object, source actor, target actor | `events` table |
| `@xstate.snapshot` | Full snapshot after transition, source event | `snapshots` table (periodic) |
| `@xstate.actor` | Actor creation/stop, actor ID, parent ref | `events` table (lifecycle entries) |

### Recording transitions to SQLite

```typescript
#recordEvent(inspectionEvent: InspectionEvent) {
  if (inspectionEvent.type !== '@xstate.event') return;

  const event = inspectionEvent.event;
  const startTime = performance.now();

  // After transition completes (in the snapshot inspector):
  const durationMs = performance.now() - startTime;
  const nextSnapshot = this.actor.getSnapshot();
  const checksum = this.#calculateChecksum(nextSnapshot);

  qb.insert({
    tableName: 'events',
    data: {
      seq: event._seq,
      timestamp: event._timestamp,
      type: event.type,
      caller_id: event.caller?.id ?? 'system',
      caller_type: event.caller?.type ?? 'system',
      payload: JSON.stringify(this.#redactEvent(event)),
      state_value: JSON.stringify(nextSnapshot.value),
      checksum,
      duration_ms: durationMs,
    },
  }).execute();
}
```

### Querying observability data

```typescript
// Recent events for an actor
const recent = await qb.fetchAll({
  tableName: 'events',
  fields: '*',
  orderBy: 'seq DESC',
  limit: 50,
}).execute();

// Events by type in a time range
const answers = await qb.fetchAll({
  tableName: 'events',
  fields: '*',
  where: {
    conditions: ['type = ?1', 'timestamp BETWEEN ?2 AND ?3'],
    params: ['SUBMIT_ANSWER', startTime, endTime],
  },
}).execute();

// Slow transitions (> 100ms)
const slow = await qb.fetchAll({
  tableName: 'events',
  fields: '*',
  where: {
    conditions: ['duration_ms > ?1'],
    params: [100],
  },
  orderBy: 'duration_ms DESC',
}).execute();
```

Exposed via HTTP endpoint (service callers only):

```
GET /api/todo/{id}/events?after=42&limit=100&types=ADD_TODO,DELETE_TODO
Authorization: Bearer <service-token>
```

## Fixing `getPersistedSnapshot()`

The most impactful single change: switch from `getSnapshot()` to `getPersistedSnapshot()` for all persistence operations.

### Before (current, broken)

```typescript
// src/createMachineServer.ts
#setupStatePersistence(actor: Actor<TMachine>) {
  actor.subscribe(() => {
    const fullSnapshot = actor.getSnapshot();  // WRONG for persistence
    this.#persistSnapshot(fullSnapshot).catch(() => {});
  });
}

async #persistSnapshot(snapshot: SnapshotFrom<TMachine>) {
  if (
    this.lastPersistedSnapshot &&
    compare(this.lastPersistedSnapshot, snapshot).length === 0
  ) {
    return;
  }
  await this.storage.put(PERSISTED_SNAPSHOT_KEY, JSON.stringify(snapshot));
  this.lastPersistedSnapshot = snapshot;
}
```

### After (correct)

```typescript
#setupStatePersistence(actor: Actor<TMachine>) {
  actor.subscribe(() => {
    const persistedSnapshot = actor.getPersistedSnapshot();
    this.#persistSnapshot(persistedSnapshot).catch(() => {});
  });
}

async #persistSnapshot(snapshot: Snapshot<unknown>) {
  const data = JSON.stringify(snapshot);
  const checksum = await this.#calculateChecksum(snapshot);

  if (checksum === this.lastPersistedChecksum) return;

  // Atomic write: snapshot + meta update in one SQL transaction
  this.ctx.storage.sql.exec('BEGIN');
  try {
    const qb = new DOQB(this.ctx.storage.sql);

    await qb.insert({
      tableName: 'snapshots',
      data: {
        seq: this.eventSequence,
        timestamp: Date.now(),
        checksum,
        data,
      },
    }).execute();

    await qb.insert({
      tableName: 'meta',
      data: { key: 'last_seq', value: String(this.eventSequence) },
      onConflict: { column: 'key', data: { value: String(this.eventSequence) } },
    }).execute();

    this.ctx.storage.sql.exec('COMMIT');
    this.lastPersistedChecksum = checksum;
  } catch (err) {
    this.ctx.storage.sql.exec('ROLLBACK');
    throw err;
  }
}
```

### Restoration also uses persisted snapshot

```typescript
// Current (loads from KV):
const snapshotString = await this.storage.get(PERSISTED_SNAPSHOT_KEY);
const snapshot = JSON.parse(snapshotString);
const actor = createActor(machine, { snapshot, input });

// After (loads from SQLite):
const qb = new DOQB(this.ctx.storage.sql);
const row = await qb.fetchOne({
  tableName: 'snapshots',
  fields: 'data',
  orderBy: 'seq DESC',
  limit: 1,
}).execute();

if (row?.results) {
  const snapshot = JSON.parse(row.results.data);
  const actor = createActor(machine, { snapshot, input });
} else {
  const actor = createActor(machine, { input });
}
```

## Migration Path: KV to SQLite

### Wrangler config change

```toml
# Before (wrangler.toml):
[durable_objects]
bindings = [
  { name = "TODO", class_name = "Todo" }
]

[[migrations]]
tag = "v1"
new_classes = ["Todo"]

# After:
[durable_objects]
bindings = [
  { name = "TODO", class_name = "Todo" }
]

[[migrations]]
tag = "v1"
new_classes = ["Todo"]

[[migrations]]
tag = "v2"
new_sqlite_classes = ["Todo"]
```

The `new_sqlite_classes` migration tells Cloudflare to enable SQLite for the DO class. Existing KV data remains accessible via `this.ctx.storage.get()` during the transition.

### Backward-compatible initialization

On first boot after migration, check for legacy KV snapshot and migrate it:

```typescript
async #initializeStorage() {
  const qb = new DOQB(this.ctx.storage.sql);

  // Create tables (idempotent)
  this.ctx.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS events (
      seq           INTEGER PRIMARY KEY,
      timestamp     INTEGER NOT NULL,
      type          TEXT    NOT NULL,
      caller_id     TEXT    NOT NULL,
      caller_type   TEXT    NOT NULL,
      payload       TEXT,
      state_value   TEXT    NOT NULL,
      checksum      TEXT    NOT NULL,
      duration_ms   REAL
    );
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_caller ON events(caller_id, caller_type);

    CREATE TABLE IF NOT EXISTS snapshots (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      seq           INTEGER NOT NULL,
      timestamp     INTEGER NOT NULL,
      checksum      TEXT    NOT NULL,
      data          TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_seq ON snapshots(seq);

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Check for legacy KV snapshot
  const schemaVersion = this.ctx.storage.sql.exec(
    "SELECT value FROM meta WHERE key = 'schema_version'"
  ).one();

  if (!schemaVersion) {
    // First boot on SQLite — check for KV data
    const legacySnapshot = await this.ctx.storage.get(PERSISTED_SNAPSHOT_KEY);
    if (legacySnapshot) {
      // Migrate KV snapshot to SQLite
      await qb.insert({
        tableName: 'snapshots',
        data: {
          seq: 0,
          timestamp: Date.now(),
          checksum: 'migrated-from-kv',
          data: typeof legacySnapshot === 'string'
            ? legacySnapshot
            : JSON.stringify(legacySnapshot),
        },
      }).execute();

      // Clean up KV entry
      await this.ctx.storage.delete(PERSISTED_SNAPSHOT_KEY);
    }

    // Mark migration complete
    await qb.insert({
      tableName: 'meta',
      data: { key: 'schema_version', value: '1' },
    }).execute();

    await qb.insert({
      tableName: 'meta',
      data: { key: 'created_at', value: String(Date.now()) },
    }).execute();
  }
}
```

### Rolling window for events

To prevent unbounded storage growth, prune old events beyond a configurable window:

```typescript
async #pruneOldEvents() {
  if (!this.maxEvents) return;

  const cutoff = this.eventSequence - this.maxEvents;
  if (cutoff <= 0) return;

  this.ctx.storage.sql.exec(
    'DELETE FROM events WHERE seq <= ?',
    cutoff
  );
}
```

### Configuration

```typescript
import { createAnalyticsEngineSink, createConsoleSink } from "actor-kit/sinks";

export const Todo = createMachineServer({
  machine: todoMachine,
  schemas: { /* ... */ },
  options: {
    persisted: true,
    sqlite: {
      eventLog: true,             // Enable SQLite event logging (default: false)
      maxEvents: 10_000,          // Rolling window size (0 = unlimited)
      redact: ["storage", "env"], // Fields to strip from logged events
    },
    eventSinks: (env) => [
      // CF Analytics Engine — free, built-in, queryable via SQL API
      createAnalyticsEngineSink(env.EVENTS),
      // Console — dev/debugging
      createConsoleSink(),
    ],
  },
});
```

Note: `getPersistedSnapshot()` and SQLite migration happen regardless of `sqlite` options — they are correctness fixes, not optional features.

## Event Sink Adapters

SQLite is the **source of truth** for state persistence and replay. Event sinks are **projections** — fire-and-forget streams to external analytics/observability systems. This follows the CQRS pattern: one write model (SQLite), many read models (sinks).

```
XState Machine
     │
     ├─ inspect callback (every event, snapshot, microstep)
     │
     ▼
  Event Router (in createMachineServer)
     │
     ├─► DO SQLite (always, sync) ── state persistence, replay
     │     via workers-qb DOQB
     │
     └─► EventSink[] (pluggable, async) ── analytics, audit, debugging
           ├─ AnalyticsEngineSink (CF built-in)
           ├─ PostHogSink
           ├─ ConsoleSink (dev)
           └─ custom
```

### The `ActorEventSink` interface

```typescript
// In actor-kit/types
interface ActorEvent {
  actorType: string;
  actorId: string;
  seq: number;
  timestamp: number;
  type: string;
  callerId: string;
  callerType: string;
  stateValue: string;
  checksum: string;
  payload?: Record<string, unknown>;
}

interface ActorEventSink {
  send(events: ActorEvent[]): void | Promise<void>;
}
```

Sinks receive batches of `ActorEvent` objects. They can be sync or async — the framework calls them with `Promise.resolve(sink.send(events)).catch(...)` so failures never block state transitions.

### Built-in sinks

#### CF Analytics Engine (recommended default)

Free, built into Workers, queryable via SQL API. Designed for high-volume event data with no external service required.

```typescript
// actor-kit/sinks
export function createAnalyticsEngineSink(
  dataset: AnalyticsEngineDataset
): ActorEventSink {
  return {
    send(events) {
      for (const event of events) {
        dataset.writeDataPoint({
          indexes: [event.actorId],
          blobs: [
            event.actorType,
            event.type,
            event.callerId,
            event.callerType,
            event.stateValue,
            JSON.stringify(event.payload ?? {}),
          ],
          doubles: [event.seq, event.timestamp],
        });
      }
    },
  };
}
```

Query via CF SQL API:

```sql
SELECT blob2 as event_type, count() as count
FROM EVENTS
WHERE index1 = 'game-123'
  AND timestamp > now() - interval '1 hour'
GROUP BY event_type
ORDER BY count DESC
```

Wrangler config:

```toml
[[analytics_engine_datasets]]
binding = "EVENTS"
```

#### Console sink (dev/debugging)

```typescript
export function createConsoleSink(): ActorEventSink {
  return {
    send(events) {
      for (const event of events) {
        console.log(
          `[${event.actorType}:${event.actorId}] ${event.type} → ${event.stateValue} (seq:${event.seq})`
        );
      }
    },
  };
}
```

#### PostHog sink

```typescript
export function createPostHogSink(opts: {
  apiKey: string;
  host: string;
}): ActorEventSink {
  return {
    async send(events) {
      await fetch(`https://${opts.host}/capture/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: opts.apiKey,
          batch: events.map((e) => ({
            event: e.type,
            distinct_id: e.callerId,
            timestamp: new Date(e.timestamp).toISOString(),
            properties: {
              actor_type: e.actorType,
              actor_id: e.actorId,
              state: e.stateValue,
              seq: e.seq,
              ...e.payload,
            },
          })),
        }),
      });
    },
  };
}
```

#### Custom sink

```typescript
eventSinks: (env) => [
  {
    send(events) {
      // Write to ClickHouse, Kafka, R2, a webhook — anything
    },
  },
],
```

### Why SQLite is NOT an adapter

If someone swaps out SQLite for an external store, they lose:
- **Event replay** — state recovery from events requires local, fast, indexed queries
- **Transactional consistency** — event + snapshot must be atomic within one DO
- **Offline recovery** — DO restarts before network is available
- **Checkpoint snapshots** — fast restore without replaying all events

SQLite is the write model. Sinks are read model projections. They're independent: you can have `eventLog: true` without any sinks (local-only), sinks without `eventLog` (stream-only, no local replay), or both.

### Sink failure handling

Sinks are best-effort. A failing sink never blocks state transitions:

```typescript
// In createMachineServer.ts
#fanOutToSinks(events: ActorEvent[]) {
  for (const sink of this.eventSinks) {
    try {
      Promise.resolve(sink.send(events)).catch((err) => {
        console.error(`[actor-kit] EventSink error:`, err);
      });
    } catch (err) {
      console.error(`[actor-kit] EventSink error:`, err);
    }
  }
}
```

## Event Replay from Checkpoint

With events stored in SQLite and snapshots tagged with sequence numbers, point-in-time reconstruction becomes straightforward:

```
Event Log:     [e1] [e2] [e3] [e4] [e5] [e6] [e7] [e8] [e9] [e10]
Snapshots:           S1              S2              S3
                     (seq 2)         (seq 5)         (seq 8)
```

To reconstruct state at seq 7:

```typescript
async #reconstructAtSeq(targetSeq: number): Promise<Snapshot<unknown>> {
  const qb = new DOQB(this.ctx.storage.sql);

  // Find nearest snapshot before target
  const snapshotRow = await qb.fetchOne({
    tableName: 'snapshots',
    fields: '*',
    where: { conditions: ['seq <= ?1'], params: [targetSeq] },
    orderBy: 'seq DESC',
    limit: 1,
  }).execute();

  if (!snapshotRow?.results) {
    throw new Error(`No snapshot found before seq ${targetSeq}`);
  }

  const baseSnapshot = JSON.parse(snapshotRow.results.data);
  const baseSeq = snapshotRow.results.seq;

  if (baseSeq === targetSeq) return baseSnapshot;

  // Replay events from baseSeq+1 to targetSeq
  const events = await qb.fetchAll({
    tableName: 'events',
    fields: '*',
    where: {
      conditions: ['seq > ?1', 'seq <= ?2'],
      params: [baseSeq, targetSeq],
    },
    orderBy: 'seq ASC',
  }).execute();

  // Create a temporary actor from the snapshot and replay
  const replayActor = createActor(this.machine, { snapshot: baseSnapshot });
  replayActor.start();

  for (const event of events.results) {
    const parsed = JSON.parse(event.payload);
    replayActor.send({ ...parsed, type: event.type });
  }

  const result = replayActor.getPersistedSnapshot();
  replayActor.stop();
  return result;
}
```

## Implementation Plan

### Phase 1: Core (correctness fixes)

1. Switch `getSnapshot()` to `getPersistedSnapshot()` in `#setupStatePersistence` and `#persistSnapshot`
2. Add `_timestamp` and `_seq` injection in event processing
3. Persist `_seq` in meta table
4. Add `new_sqlite_classes` migration guide to docs

### Phase 2: Event Log + SQLite

5. Add `workers-qb` dependency
6. Create SQLite schema (events, snapshots, meta tables) via `#initializeStorage`
7. Record events to `events` table after each transition
8. Implement rolling window pruning
9. Add event query endpoint for service callers
10. KV-to-SQLite migration path

### Phase 3: Event Sinks

11. Define `ActorEventSink` interface and `ActorEvent` type
12. Implement sink fan-out in `#fanOutToSinks` (fire-and-forget, error-safe)
13. Ship `createAnalyticsEngineSink` and `createConsoleSink` as built-in sinks
14. Ship `createPostHogSink` as example/community sink
15. Wire sinks into the inspect callback alongside SQLite logging

### Phase 4: Observability

16. Wire up XState `inspect` callback in `createActor()`
17. Record transition durations
18. Add query helpers for slow transitions, event-type filtering, time-range queries

### Key files to change

| File | Change |
|------|--------|
| `src/createMachineServer.ts` | `getPersistedSnapshot()`, `_timestamp`/`_seq` injection, SQLite schema init, event logging, inspect callback |
| `src/types.ts` | Add `_timestamp`, `_seq` to `BaseActorKitEvent`; add `SqliteOptions` config type |
| `src/schemas.ts` | Add optional `_timestamp`/`_seq` to event schemas |
| `src/constants.ts` | Add table names, schema version constant |
| `package.json` | Add `workers-qb` dependency |

### New files

| File | Purpose |
|------|---------|
| `src/sqlite.ts` | Schema definitions, migration logic, query helpers |
| `src/eventLog.ts` | Event logging, redaction, pruning logic |
| `src/sinks.ts` | `ActorEventSink` interface, built-in sink implementations |
| `src/sinks/analytics-engine.ts` | CF Analytics Engine sink |
| `src/sinks/console.ts` | Console sink for dev/debugging |
| `src/sinks/posthog.ts` | PostHog sink |

## Test Plan

### Unit tests

1. **`getPersistedSnapshot()` used for persistence (not `getSnapshot()`)**
   - Setup: Machine with child actor / history state
   - Act: Transition to state with internal XState data
   - Assert: Persisted data includes XState internals (children, history)

2. **Every event gets `_timestamp` and `_seq`**
   - Act: Send 3 client events via WebSocket
   - Assert: Machine receives events with `_timestamp` close to `Date.now()` and `_seq` values 1, 2, 3

3. **`_seq` survives DO restart**
   - Setup: Send 5 events, simulate DO restart (destroy + recreate)
   - Act: Send event after restart
   - Assert: `_seq` is 6 (not 1)

4. **Framework overwrites client-provided `_timestamp`**
   - Act: Send event with `_timestamp: 0`
   - Assert: Machine receives event with `_timestamp` close to `Date.now()`

5. **Events logged to SQLite after transition**
   - Setup: `sqlite.eventLog: true`
   - Act: Send event
   - Assert: `events` table has row with correct seq, type, caller, checksum

6. **Rejected events (guard fail) not logged**
   - Setup: Machine with guard that rejects event
   - Act: Send event that fails guard
   - Assert: No row in `events` table

7. **Redacted fields stripped from logged events**
   - Setup: `sqlite.redact: ["storage", "env"]`
   - Act: Send event
   - Assert: `payload` column has no `storage` or `env` keys

8. **Rolling window prunes old events**
   - Setup: `sqlite.maxEvents: 5`
   - Act: Send 8 events
   - Assert: `events` table has 5 rows (seq 4-8), seq 1-3 deleted

9. **Snapshot stored with correct seq tag**
   - Act: Send 3 events
   - Assert: `snapshots` table row has `seq: 3`

10. **KV-to-SQLite migration on first boot**
    - Setup: Legacy `PERSISTED_SNAPSHOT_KEY` in KV storage
    - Act: Initialize actor (triggers `#initializeStorage`)
    - Assert: Snapshot migrated to `snapshots` table, KV key deleted, `schema_version` set

11. **Inspect callback records transition duration**
    - Setup: `sqlite.observability: true`
    - Act: Send event
    - Assert: `events` row has non-null `duration_ms`

12. **Event query endpoint returns filtered results**
    - Setup: Log 10 events of mixed types
    - Act: `GET /events?after=5&types=ADD_TODO&limit=3`
    - Assert: Returns only `ADD_TODO` events with seq > 5, max 3

13. **Atomic snapshot + meta write**
    - Setup: Force error after snapshot insert but before meta update
    - Assert: Neither write persists (transaction rolled back)

14. **Tables created idempotently**
    - Act: Call `#initializeStorage` twice
    - Assert: No errors, tables exist with correct schema

### Event sink tests

15. **Sinks receive events after transition**
    - Setup: Register a mock sink via `eventSinks`
    - Act: Send event
    - Assert: Mock sink's `send()` called with `ActorEvent` containing correct actorType, actorId, seq, type

16. **Multiple sinks all receive events**
    - Setup: Register 3 mock sinks
    - Act: Send event
    - Assert: All 3 sinks called

17. **Sink failure does not block state transition**
    - Setup: Register a sink that throws
    - Act: Send event
    - Assert: State transition completes, other sinks still called

18. **Async sink failure does not block state transition**
    - Setup: Register a sink that returns a rejected promise
    - Act: Send event
    - Assert: State transition completes normally

19. **Sinks work without eventLog (stream-only mode)**
    - Setup: `eventLog: false`, one mock sink
    - Act: Send event
    - Assert: Sink called, no rows in `events` table

20. **Analytics Engine sink writes correct data points**
    - Setup: Mock `AnalyticsEngineDataset`
    - Act: Send event through `createAnalyticsEngineSink`
    - Assert: `writeDataPoint` called with correct indexes, blobs, doubles

21. **Console sink logs in expected format**
    - Setup: Spy on `console.log`
    - Act: Send event through `createConsoleSink`
    - Assert: Log matches `[actorType:actorId] eventType → stateValue (seq:N)` format

### Integration tests

22. **Full lifecycle: boot -> events -> persist -> restart -> restore -> continue**
    - Setup: Create actor, send 5 events
    - Act: Simulate DO restart
    - Assert: Actor restores from SQLite snapshot, `_seq` continues at 6, event log preserved

23. **Replay from checkpoint produces identical state**
    - Setup: Send 10 events, snapshot at seq 5
    - Act: Reconstruct state at seq 8 via `#reconstructAtSeq`
    - Assert: Reconstructed state matches actual state after event 8

### Mutation testing targets

- `getPersistedSnapshot()` vs `getSnapshot()` (must use persisted)
- `_timestamp` injection (must not be omitted)
- `_seq` increment (must be exactly +1)
- `_seq` restoration from meta table on restart
- Client `_timestamp` overwrite
- Event log insert (must happen after transition, not before)
- Redaction of specified fields
- Rolling window deletion threshold
- KV migration detection and cleanup
- Transaction commit/rollback boundaries
- Sink fan-out (all sinks called, not just first)
- Sink error isolation (failure in one doesn't skip others)
- Sink receives correct `ActorEvent` shape (all fields populated)
