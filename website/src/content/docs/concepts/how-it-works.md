---
title: How It Works
description: Understand the data flow from initial page load through real-time sync.
---

Actor Kit manages four phases of the actor lifecycle: initial load, client hydration, event processing, and reconnection.

## 1. Initial page load (SSR)

Your server-side loader creates a JWT access token and fetches the initial snapshot from the Durable Object:

```
Server loader
  │
  ├─ createAccessToken({ signingKey, actorId, actorType, callerId, callerType })
  │   → JWT with jti=actorId, aud=actorType, sub=callerType-callerId
  │
  ├─ createActorFetch({ actorType, host })
  │   → HTTP GET /api/{actorType}/{actorId}?accessToken=...
  │   → Router validates JWT → spawns or retrieves DO
  │   → DO returns { checksum, snapshot } (caller-scoped)
  │
  └─ Returns to component: { accessToken, checksum, snapshot }
```

The snapshot is **caller-scoped**: it includes `public` context (shared with everyone) and `private` context (only for this caller).

## 2. Client hydration

Once the React app hydrates, the provider establishes a WebSocket connection:

```
React component
  │
  ├─ <Provider host, actorId, accessToken, checksum, initialSnapshot>
  │   → createActorKitClient({ initialSnapshot, ... })
  │
  └─ useEffect → client.connect()
      → WebSocket: wss://host/api/{actorType}/{actorId}?accessToken=...&checksum=...
      → Server validates JWT
      → If checksum matches: no initial payload (client is current)
      → If checksum differs: full snapshot sent
      → Ongoing: JSON Patch operations for each state change
```

The checksum handshake avoids sending redundant data. If the client already has the latest state from SSR, the WebSocket connection starts clean with no initial payload.

## 3. Event processing

When a client sends an event, the Durable Object processes it through the XState machine and broadcasts diffs:

```
Client                          Durable Object
  │                               │
  │ send({ type: "ADD_TODO" })    │
  │ ────────WSS──────────────▶    │
  │                               │ 1. Parse event (Zod schema)
  │                               │ 2. Validate caller (JWT claims)
  │                               │ 3. Augment: { ...event, caller, storage, env }
  │                               │ 4. actor.send(augmentedEvent)
  │                               │ 5. XState transitions (guards → actions → state)
  │                               │ 6. getSnapshot() → calculateChecksum()
  │                               │ 7. For each connected WebSocket:
  │                               │    a. Create caller-scoped snapshot
  │                               │    b. Compare with last sent checksum
  │                               │    c. If different: compute JSON Patch diff
  │                               │    d. Send patch operations
  │                               │ 8. If persisted: storage.put(snapshot)
  │  ◀──────JSON Patch────────    │
  │                               │
  │ applyPatch(state, ops)        │
  │ → useSyncExternalStore        │
  │ → React re-render             │
```

Key details:
- Events are **augmented** with `caller`, `storage`, and `env` before reaching the machine. Your guards and actions can use these to enforce access control.
- Each WebSocket gets a **caller-scoped diff**. Different callers may receive different patches for the same transition.
- Persistence happens **after** broadcast, so clients get updates as fast as possible.

## 4. Reconnection

If the WebSocket disconnects, the client reconnects with exponential backoff:

```
Client detects WebSocket close
  │
  ├─ Exponential backoff (max 5 attempts)
  │
  └─ Reconnect with last-known checksum
      → Server checks snapshot cache (5-minute window)
      → If cached: send diff from cached state
      → If expired: send full snapshot
```

The server maintains a snapshot cache (keyed by checksum, 5-minute TTL). Reconnecting clients that haven't been gone too long receive a small diff rather than the full state.
