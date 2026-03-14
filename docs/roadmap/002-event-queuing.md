# 002: Event Queuing Before Connection

**Priority**: P0
**Status**: Completed — [PR #11](https://github.com/actor-kit/actor-kit/pull/11) (2026-03-14)
**Affects**: `createActorKitClient.ts`

## Problem

When a client sends events before the WebSocket connection is established, they are silently dropped. From Piqolo's `fromActorKit.ts`:

```typescript
} else {
  // 4b. If websocket is not ready, log a warning.
  console.warn(`Parsed event successfully, but WebSocket connection not established...`);
  // TODO... add a queue?
}
```

This causes data loss in fast interactions — especially on slow networks or during reconnection. If a user submits an answer in a trivia game during a brief reconnect, that answer vanishes.

## Current Behavior

```
1. Client created with initialSnapshot
2. User interacts immediately (sends event)
3. WebSocket not yet connected → event lost
4. WebSocket connects → client is in sync with server but user's action was never sent
```

## Proposed API

No API change needed — this should be automatic. Events sent before connection (or during reconnection) should queue and replay on connect.

```typescript
// This already works — no change to developer code
const client = createActorKitClient({ ... });
client.send({ type: "SUBMIT_ANSWER", value: 42 }); // Queued, not dropped
client.connect(); // Queue replays after handshake
```

### Configuration (optional)

```typescript
const client = createActorKitClient({
  // ... existing options
  queueOptions: {
    maxSize: 100,          // Max queued events (default: 100)
    maxAgeMs: 30_000,      // Drop events older than 30s (default: 30000)
  },
});
```

## Implementation

### Key files to change

| File | Change |
|------|--------|
| `src/createActorKitClient.ts` | Add event queue, drain on connect/reconnect |

### Code sketch

```typescript
// In createActorKitClient.ts

interface QueuedEvent<T> {
  event: T;
  timestamp: number;
}

// Inside the client factory:
const eventQueue: QueuedEvent<ClientEventFrom<TMachine>>[] = [];
const maxQueueSize = options?.queueOptions?.maxSize ?? 100;
const maxQueueAge = options?.queueOptions?.maxAgeMs ?? 30_000;

function send(event: ClientEventFrom<TMachine>) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event));
  } else {
    // Queue instead of dropping
    if (eventQueue.length >= maxQueueSize) {
      eventQueue.shift(); // Drop oldest
    }
    eventQueue.push({ event, timestamp: Date.now() });
  }
}

function drainQueue() {
  const now = Date.now();
  while (eventQueue.length > 0) {
    const queued = eventQueue.shift()!;
    if (now - queued.timestamp <= maxQueueAge) {
      ws!.send(JSON.stringify(queued.event));
    }
    // else: expired, drop silently
  }
}

// In the WebSocket onopen handler:
ws.addEventListener("open", () => {
  // ... existing handshake logic
  drainQueue();
});
```

### Edge cases

1. **Reconnection**: Queue drains on each successful reconnect. Events from the disconnect window are replayed.
2. **Queue overflow**: Oldest events dropped first (FIFO). Configurable max.
3. **Stale events**: Events older than `maxAgeMs` are silently dropped on drain. A trivia answer from 30s ago is probably irrelevant.
4. **Server-side deduplication**: If the server already processed an event (e.g., during a brief disconnect where the server didn't notice), the machine's guards handle idempotency. This is the developer's responsibility via guard logic, not the framework's.

## Test Plan

### Unit tests (`create-actor-kit-client.test.ts`)

1. **Events queue when disconnected**
   - Setup: Create client, don't connect
   - Act: `send({ type: "ADD_TODO", text: "test" })`
   - Assert: No WebSocket send, event stored in internal queue

2. **Queue drains on connect**
   - Setup: Create client, send 3 events while disconnected
   - Act: Connect
   - Assert: All 3 events sent via WebSocket in order after handshake

3. **Queue drains on reconnect**
   - Setup: Connect, disconnect (simulate network drop), send 2 events
   - Act: Reconnect
   - Assert: 2 events sent after reconnection handshake

4. **Queue respects maxSize**
   - Setup: Client with `maxSize: 2`
   - Act: Send 5 events while disconnected
   - Assert: Only last 2 events in queue (oldest 3 dropped)

5. **Stale events dropped on drain**
   - Setup: Send event, advance clock by 31 seconds
   - Act: Connect
   - Assert: Stale event not sent

6. **Events sent normally when connected**
   - Setup: Connect client
   - Act: Send event
   - Assert: Sent immediately via WebSocket, queue remains empty

7. **Queue order preserved**
   - Setup: Send events A, B, C while disconnected
   - Act: Connect
   - Assert: Server receives A, B, C in that order

### Mutation testing targets

- Queue-vs-send branch (is WebSocket open?)
- maxSize overflow logic
- maxAgeMs expiry check
- drainQueue iteration
