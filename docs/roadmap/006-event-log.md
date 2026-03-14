# 006: Optional Event Log

**Priority**: P2
**Status**: Proposal
**Affects**: `createMachineServer.ts`, new module, types

## Problem

Actor-kit is snapshot-only. There is no record of what events produced the current state. This blocks:

- **Audit trails**: Who did what, when? (compliance, debugging)
- **Time-travel debugging**: Step through event history to find bugs
- **Replay**: Reconstruct state from events after a schema migration
- **Analytics**: Query event streams for usage patterns

## Proposed API

### Opt-in event logging

```typescript
export const Todo = createMachineServer({
  machine: todoMachine,
  schemas: { /* ... */ },
  options: {
    persisted: true,
    eventLog: {
      enabled: true,
      storage: "do",          // "do" (Durable Object storage) or "external"
      maxEvents: 10_000,      // Rolling window (oldest pruned)
      redact: ["storage", "env"],  // Fields to strip before logging
    },
  },
});
```

### Event log entry shape

```typescript
interface EventLogEntry {
  seq: number;                     // From 004 (event sequence)
  timestamp: number;               // From 004 (server timestamp)
  type: string;                    // Event type
  caller: { id: string; type: string };
  payload: Record<string, unknown>; // Event data (redacted)
  prevChecksum: string;            // State before
  nextChecksum: string;            // State after
  stateValue: StateValue;          // XState state after transition
}
```

### Reading the log

```typescript
// New method on ActorServer
const entries = await actorServer.getEventLog({
  after: 42,       // After seq 42
  limit: 100,
  types: ["ADD_TODO", "DELETE_TODO"],  // Filter by event type
});
```

Exposed via HTTP endpoint:

```
GET /api/todo/{id}/events?after=42&limit=100&types=ADD_TODO,DELETE_TODO
Authorization: Bearer <service-token>
```

Only `service` caller type can read the event log (not `client`).

### External storage adapter

For production at scale, log to an external store instead of DO storage:

```typescript
eventLog: {
  enabled: true,
  storage: "external",
  adapter: {
    write: async (entries: EventLogEntry[]) => {
      await db.insert(eventLogTable).values(entries);
    },
    read: async (query) => {
      return db.select().from(eventLogTable).where(/* ... */);
    },
  },
}
```

## How Event Sourcing Would Work

### The hybrid model

Actor-kit should NOT become a pure event-sourced system. Instead:

1. **Snapshots remain the primary state** — fast, cheap, sufficient for recovery
2. **Event log is supplementary** — for audit, debugging, replay
3. **Snapshots are tagged with event sequence** — you know which events produced which snapshot

```
Event Log:        [e1] [e2] [e3] [e4] [e5] [e6] [e7] [e8] [e9] [e10]
Snapshots:              S1              S2              S3
                        (seq 2)         (seq 5)         (seq 8)
```

### Replay from checkpoint

To reconstruct state at seq 7:
1. Load snapshot S2 (seq 5)
2. Replay events e6, e7 against the machine
3. Result: state at seq 7

### Deterministic replay requirements

For replay to produce identical state, events must carry all non-deterministic inputs:

| Non-determinism | Solution |
|-----------------|----------|
| `Date.now()` in guards | Use `event._timestamp` (see 004) |
| `crypto.randomUUID()` in actions | Log the generated UUID in the event log entry |
| External API calls in actors | Log the response, replay from log |
| `Math.random()` | Seed-based PRNG with seed stored per-actor |

Guards that depend on `_timestamp` are deterministic on replay because the original timestamp is preserved in the event log.

### What about guards that reject events?

During live processing:
```
Event received → Guard evaluates → PASS → Transition + log event
                                 → FAIL → Event dropped (not logged)
```

During replay:
```
Event from log → Skip guard → Apply transition directly
```

This is the "command vs event" distinction:
- **Command**: "User wants to submit answer" (may be rejected by guard)
- **Event**: "Answer was accepted" (guard already passed; always applies)

The event log stores events (post-guard), not commands (pre-guard).

## Implementation

### Storage in DO

Events stored as a list in DO storage:

```typescript
// Key format: `event:{seq}`
await this.ctx.storage.put(`event:${entry.seq}`, entry);

// Pruning: delete events older than maxEvents
const oldestAllowed = this.eventSequence - this.maxEvents;
if (oldestAllowed > 0) {
  const keysToDelete = [];
  for (let i = lastPrunedSeq + 1; i <= oldestAllowed; i++) {
    keysToDelete.push(`event:${i}`);
  }
  await this.ctx.storage.delete(keysToDelete);
}
```

### Hook into transition

```typescript
// In createMachineServer.ts, after actor.send():
if (this.eventLogEnabled) {
  const nextSnapshot = this.actor.getSnapshot();
  const nextChecksum = this.calculateChecksum(nextSnapshot);

  await this.logEvent({
    seq: event._seq,
    timestamp: event._timestamp,
    type: event.type,
    caller: { id: event.caller.id, type: event.caller.type },
    payload: this.redactEvent(event),
    prevChecksum: this.lastChecksum,
    nextChecksum,
    stateValue: nextSnapshot.value,
  });
}
```

## Test Plan

### Unit tests

1. **Events logged after transition**
   - Act: Send event to machine with `eventLog.enabled: true`
   - Assert: `storage.put("event:1", ...)` called with correct entry

2. **Redacted fields stripped**
   - Setup: `redact: ["storage", "env"]`
   - Act: Send event
   - Assert: Logged entry has no `storage` or `env` fields

3. **Rolling window prunes old events**
   - Setup: `maxEvents: 5`
   - Act: Send 8 events
   - Assert: Events 1-3 deleted, events 4-8 present

4. **Rejected events (guard fail) not logged**
   - Setup: Machine with guard that rejects event
   - Act: Send event that fails guard
   - Assert: No event log entry created

5. **Event log readable via getEventLog()**
   - Act: Send 5 events, call `getEventLog({ after: 2, limit: 2 })`
   - Assert: Returns events 3 and 4

6. **Checksums track state transitions**
   - Act: Send 3 events
   - Assert: Each entry's `nextChecksum` equals the next entry's `prevChecksum`

7. **Event log disabled by default**
   - Setup: No `eventLog` option
   - Act: Send events
   - Assert: No `event:*` keys in storage
