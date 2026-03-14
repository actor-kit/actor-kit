# 004: Event Timestamping at Ingestion

**Priority**: P1
**Status**: Proposal
**Affects**: `createMachineServer.ts`, types, schemas

## Problem

Actor-kit doesn't stamp events with a server-authoritative timestamp. This creates two problems:

1. **Non-deterministic guards**: If a guard uses `Date.now()`, replaying the same events at a different time produces different state. This blocks event sourcing (see 006).

2. **No canonical ordering**: When multiple clients send events concurrently, there's no server-assigned ordering beyond "whatever the DO processed first." This matters for scoring in games — Trivia Jam calculates speed-based scores using `answer.timestamp` which is set client-side (`Date.now()` in the browser). A cheating client could fake timestamps.

## Current Behavior

```typescript
// In createMachineServer.ts — events are forwarded as-is
this.actor.send({
  ...event,
  caller,
  storage: this.ctx.storage,
  env: this.env,
});
// No timestamp added by framework
```

Developers add their own timestamps in actions:

```typescript
// Trivia Jam: client-provided timestamp
{ type: "SUBMIT_ANSWER", value: "Paris", timestamp: Date.now() }

// Piqolo: server-side in action
actions: assign(({ context }) =>
  produce(context, (draft) => {
    draft.public.lastSync = Date.now();  // Action-level, not event-level
  })
)
```

## Proposed API

### Automatic `_timestamp` on every event

The framework injects `_timestamp: number` (server-side `Date.now()`) on every event before it reaches the XState machine:

```typescript
// Developer sends:
client.send({ type: "SUBMIT_ANSWER", value: "Paris" })

// Machine receives:
{
  type: "SUBMIT_ANSWER",
  value: "Paris",
  caller: { id: "player-1", type: "client" },
  _timestamp: 1710000000000,  // Server-injected
  storage: /* ... */,
  env: /* ... */,
}
```

### Usage in guards (safe for future replay)

```typescript
guards: {
  isWithinTimeWindow: ({ context, event }) => {
    const deadline = context.public.currentQuestion.startTime
      + (context.public.settings.answerTimeWindow * 1000);
    return event._timestamp <= deadline;  // Deterministic: uses server timestamp
  },
}
```

### Event sequence numbers

In addition to timestamps, assign a monotonically increasing sequence number:

```typescript
{
  type: "SUBMIT_ANSWER",
  _timestamp: 1710000000000,
  _seq: 42,  // 42nd event processed by this actor instance
  // ...
}
```

This provides total ordering even when timestamps collide (same millisecond).

## Implementation

### Key files to change

| File | Change |
|------|--------|
| `src/createMachineServer.ts` | Inject `_timestamp` and `_seq` before `actor.send()` |
| `src/types.ts` | Add `_timestamp` and `_seq` to `BaseActorKitEvent` |
| `src/schemas.ts` | Add optional `_timestamp`/`_seq` to event schemas |

### Code change in `createMachineServer.ts`

```typescript
// Current:
this.actor.send({ ...event, caller, storage, env });

// Proposed:
private eventSequence = 0;

// In event handler:
this.eventSequence++;
this.actor.send({
  ...event,
  caller,
  storage: this.ctx.storage,
  env: this.env,
  _timestamp: Date.now(),
  _seq: this.eventSequence,
});
```

### Type change

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

### Sequence number persistence

The `_seq` counter must survive DO restarts. Store it alongside the snapshot:

```typescript
await this.ctx.storage.put(PERSISTED_SNAPSHOT_KEY, {
  ...serializedSnapshot,
  lastSeq: this.eventSequence,
});
```

On resume:

```typescript
const persisted = await this.ctx.storage.get(PERSISTED_SNAPSHOT_KEY);
this.eventSequence = persisted?.lastSeq ?? 0;
```

## Test Plan

### Unit tests (`create-machine-server.test.ts`)

1. **Every event gets `_timestamp`**
   - Act: Send client event via WebSocket
   - Assert: Machine receives event with `_timestamp` close to `Date.now()`

2. **Every event gets `_seq`**
   - Act: Send 3 events
   - Assert: `_seq` values are 1, 2, 3

3. **System events also get timestamps**
   - Act: INITIALIZE, CONNECT, DISCONNECT
   - Assert: All have `_timestamp` and `_seq`

4. **Sequence survives restart**
   - Setup: Send 5 events, simulate DO restart
   - Act: Send event after restart
   - Assert: `_seq` is 6 (not 1)

5. **Timestamp is server-side (not client-provided)**
   - Act: Send event with a `_timestamp` field already set
   - Assert: Framework overwrites it with server time

6. **Guards can use `_timestamp`**
   - Setup: Machine with time-window guard
   - Act: Send event within window, then outside window
   - Assert: Guard passes/fails based on `_timestamp`

### Mutation testing targets

- `_timestamp` injection (must not be omitted)
- `_seq` increment (must be exactly +1)
- `_seq` persistence on restart
- Overwrite of client-provided `_timestamp`
