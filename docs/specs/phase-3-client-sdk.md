# Phase 3: Client SDK — Specification

## Goal

Browser SDK that connects to an actor via WebSocket, decodes binary frames, and provides a typed subscribe/send API. After this phase, a browser app can connect to an actor and receive real-time binary updates.

## Prerequisites

Phase 2 complete. Binary encoding/decoding working.

## Deliverables

### 1. `connect()` function

**File**: `packages/actor-kit/src/client/connect.ts`

```typescript
import { connect } from "actor-kit/client";

const todo = await connect(TodoList, {
  host: "example.com",
  actorId: "my-list",
  accessToken: jwt,
});
```

Requirements:
- Opens WebSocket to `wss://{host}/api/{actorType}/{actorId}`
- Sends JWT as Authorization header (or query param if headers unsupported)
- Receives initial SNAPSHOT frame, decodes using actor's view schemas
- Returns a typed `ActorConnection<TView, TAllMessages>` object
- `TView` is the discriminated union of all role views (narrowed via `view.role`)
- `TAllMessages` is the **union of all message types across all roles** — role enforcement is server-side only. The client can send any message; the server rejects unauthorized ones with an error frame.

### 2. `ActorConnection` interface

```typescript
interface ActorConnection<TView, TMessages> {
  // Current view (reactive)
  readonly view: TView;

  // Subscribe to view changes
  subscribe(listener: (view: TView) => void): () => void;

  // Send a message
  send(message: TMessages): void;

  // Trigger shorthand: todo.trigger.ADD_TODO({ text: "..." })
  readonly trigger: TriggerMap<TMessages>;

  // Current role
  readonly role: string;

  // Connection state
  readonly state: "connecting" | "connected" | "disconnected" | "reconnecting";

  // Disconnect
  disconnect(): void;

  // Wait for connection
  waitForConnection(): Promise<void>;
}
```

### 3. Reconnection

Requirements:
- Exponential backoff: 1s, 2s, 4s, 8s, max 30s
- On reconnect: send `{ lastChecksum, schemaVersion }` as first message
- Handle server responses: DELTA (partial update), SNAPSHOT (full state), SCHEMA_CHANGED + SNAPSHOT
- Handle ROLE_CHANGED: role may have changed while disconnected, re-type the connection
- Handle REDIRECT: automatically connect to new actor (zone transfer)
- `onRedirect` callback for user-space transition effects

### 4. REDIRECT handling

```typescript
const zone = await connect(Zone, {
  host: "example.com",
  actorId: "plains-central",
  accessToken: jwt,
  onRedirect: (target) => {
    console.log(`Transferring to ${target.actorId}...`);
  },
});
```

Requirements:
- On REDIRECT control frame: extract target actorType + actorId
- Open new WebSocket to target actor
- Receive SNAPSHOT from new actor
- Switch `view` to new actor's state
- Close old WebSocket
- Optionally overlap connections (open new before closing old) for seamless transitions
- Fire `onRedirect` callback

### 5. Trigger shorthand

```typescript
// Instead of:
todo.send({ type: "ADD_TODO", text: "Buy milk" });

// Sugar:
todo.trigger.ADD_TODO({ text: "Buy milk" });
```

Requirements:
- `trigger` is a Proxy that constructs `{ type: key, ...payload }` and calls `send()`
- Fully typed: `trigger.ADD_TODO` expects `{ text: string }` if that's the payload schema

## Acceptance criteria

1. `connect()` establishes WebSocket and receives typed view
2. `subscribe()` fires on every view update
3. `send()` delivers message to actor, view updates arrive
4. Reconnection works: brief disconnect → reconnect → delta applied
5. REDIRECT works: receive redirect → connect to new actor → view switches
6. Connection state transitions are correct: connecting → connected → disconnected → reconnecting → connected
7. Client bundle is < 5KB gzipped (decoder + connection logic)
8. Zero `any` or `as` in client code
