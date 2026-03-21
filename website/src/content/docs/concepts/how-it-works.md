---
title: How It Works
description: Understand the data flow from initial page load through real-time sync.
---

Actor Kit manages four phases of the actor lifecycle: initial load, client hydration, event processing, and reconnection.

## Overview

```
SSR Server              Worker / DO              Browser
    │                       │                       │
    │── GET /api/todo/123 ─>│                       │
    │   (JWT auth)          │                       │
    │<── { snapshot,        │                       │
    │     checksum }  ──────│                       │
    │                       │                       │
    │── HTML + snapshot + token ──────────────────> │
    │                       │                       │
    │                       │<── WebSocket connect ─│
    │                       │    (token + checksum) │
    │                       │── (match → no data) ─>│
    │                       │                       │
    │                       │<── send(ADD_TODO) ────│
    │                       │    transition()       │
    │                       │── JSON Patch diff ──> │
    │                       │                       │ re-render
```

## 1. Initial page load (SSR)

Your server-side loader creates a JWT access token and fetches the initial snapshot from the Durable Object.

```
createAccessToken ──> JWT ──> fetch(/api/todo/123) ──> DO ──> getView(state, caller) ──> { snapshot, checksum }
```

1. **`createAccessToken`** — signs a JWT with `jti`=actorId, `aud`=actorType, `sub`=callerType-callerId
2. **HTTP GET** to `/api/{actorType}/{actorId}` with JWT in Authorization header
3. **DO validates JWT** — spawns or retrieves the actor
4. **DO returns** `{ checksum, snapshot }` — the snapshot is the caller-scoped view from `getView(state, caller)`
5. **Loader returns** `{ accessToken, checksum, snapshot }` to the component

The snapshot is **caller-scoped** via `getView()`: each caller sees a different projection of the same internal state.

## 2. Client hydration

Once the React app hydrates, the provider establishes a WebSocket connection.

```
<Provider> ──> createActorKitClient() ──> WebSocket connect ──> DO
                                              │
                                    checksum match? ─── yes ──> no payload (already current)
                                              │
                                              no ──> full snapshot
                                              │
                                         ongoing ──> JSON Patch diffs
```

1. **`<Provider>`** receives `host`, `actorId`, `accessToken`, `checksum`, `initialSnapshot`
2. Internally calls **`createActorKitClient({ initialSnapshot, ... })`**
3. On mount, calls **`client.connect()`** — opens WebSocket to `wss://host/api/{actorType}/{actorId}?accessToken=...&checksum=...`
4. Server validates the JWT
5. **Checksum handshake:**
   - If checksum matches current state → no initial payload (client is already current from SSR)
   - If checksum differs → full snapshot sent
6. **Ongoing:** JSON Patch operations sent for each state change

## 3. Event processing

When a client sends an event, the Durable Object runs the transition and broadcasts caller-scoped diffs.

```
client.send({ type: "ADD_TODO", text: "..." })
    │
    ▼
Parse event (Zod schema)
    │
    ▼
Validate caller (JWT)
    │
    ▼
Augment: { ...event, caller, env }
    │
    ▼
logic.transition(state, augmentedEvent) ──> new state
    │
    ├──> logic.serialize(state) ──> persist to DO storage
    │
    └──> for each connected WebSocket:
            getView(state, caller) ──> compute JSON Patch diff ──> send
```

1. **Parse** event against Zod schema (client or service)
2. **Validate** caller identity from JWT claims
3. **Augment** event with `caller` and `env`
4. **Transition**: `logic.transition(state, augmentedEvent)` → new state
5. **Broadcast** to each connected WebSocket:
   - Compute caller-scoped view via `getView(state, caller)`
   - Compare with last sent checksum
   - If different: compute JSON Patch diff → send
   - If same: skip (no change for this caller)
6. **Persist** (if enabled): serialize and store

**Client receives** JSON Patch → `applyPatch(state, ops)` → `useSyncExternalStore` → React re-render.

Key details:
- Events are **augmented** with `caller` and `env` before reaching the transition function. Your logic can use `event.caller` for access control.
- Each WebSocket gets a **caller-scoped diff**. Different callers may receive different patches for the same transition.
- Persistence happens **after** broadcast, so clients get updates as fast as possible.

## 4. Reconnection

If the WebSocket disconnects, the client reconnects with exponential backoff.

```
WebSocket closes ──> exponential backoff ──> reconnect with last checksum
                                                   │
                                          cached? (< 5min)
                                           │           │
                                          yes          no
                                           │           │
                                      send diff   send full snapshot
```

1. Client detects WebSocket close
2. **Exponential backoff** — up to 5 retry attempts
3. **Reconnect** with the last-known checksum
4. Server checks the **snapshot cache** (keyed by checksum, 5-minute TTL):
   - If cached → compute diff from cached state, send only the delta
   - If expired → send full current snapshot
