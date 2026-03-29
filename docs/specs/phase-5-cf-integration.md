# Phase 5: CF Integration — Specification

## Goal

Deep Cloudflare integration: DO Alarms for durable timers, DO RPC for actor-to-actor communication, SQLite CDC for audit logs, Queue integration for guaranteed delivery.

## Prerequisites

Phase 1 complete. Phase 2-4 can proceed in parallel with this phase.

## Deliverables

### 1. DO Alarms (`after` / `tick`)

**`after` — durable timers**

```typescript
on: {
  after: {
    "5 minutes": (state) => produce(state, d => { d.status = "idle"; }),
    "24 hours": (state) => produce(state, d => { d.expired = true; }),
  },
},
```

Requirements:
- Backed by DO Alarms (survives hibernation/restart)
- Only one DO Alarm can be active at a time — framework manages scheduling the soonest
- Timer strings parsed to milliseconds: "5 minutes", "24 hours", "30 seconds", "1 day"
- Timer starts on actor creation (or specific state entry if using `states`)
- Timer handler runs as a transition — persists state, broadcasts views

**`tick` — real-time game loop**

```typescript
on: {
  tick: {
    frequency: 100, // ms
    handler: (state) => produce(state, d => { /* mob AI */ }),
  },
},
```

Requirements:
- Backed by `setInterval` while DO has active WebSocket connections
- Stops when all connections close (DO can hibernate)
- Resumes when a new connection opens
- On DO restart: if connections exist, restart tick immediately
- Tick handler runs as a transition — persists state (throttled: max 1 persist per second for ticks), broadcasts views

### 2. DO RPC (`ref` / `rpc`)

**Calling side: `ref()`**

```typescript
// Inside a message handler:
const other = ref(env, "zone", "forest-north");
await other.call("ACCEPT_TRANSFER", { callerId: caller, playerData });
```

Requirements:
- `ref(env, actorType, actorId)` → typed stub
- Stub wraps `env[ACTOR_TYPE].get(env[ACTOR_TYPE].idFromName(actorId))`
- `stub.call(method, payload)` → invokes RPC method on target DO
- `stub.spawn(input)` → idempotent spawn on target DO
- `stub.getSnapshot(caller)` → get target's snapshot for a caller
- Propagates errors from target DO

**Receiving side: `rpc` block**

Uses the same `message()` helper as client messages — Zod schema required for boundary parsing.

```typescript
rpc: {
  ACCEPT_TRANSFER: message(
    z.object({
      callerId: z.string(),
      playerData: z.object({
        position: z.object({ x: z.number(), y: z.number(), z: z.number() }),
        health: z.object({ current: z.number(), max: z.number() }),
        entity: z.object({ name: z.string(), type: z.string() }),
      }),
    }),
    (state, { callerId, playerData }) =>
      produce(state, d => {
        d.positions[callerId] = playerData.position;
      }),
  ),
},
```

Requirements:
- RPC handlers are NOT exposed to WebSocket clients
- No role evaluation — calling actor is trusted
- **Zod schema required** — RPC is a trust boundary per ADR 002. Payloads are parsed before the handler runs.
- Runs as a transition: persists state, broadcasts views
- Can use `emit()` for side effects

### 3. SQLite CDC (Change Data Capture)

```typescript
const todoList = defineActor({
  cdc: true, // opt-in
  // ...
});
```

Requirements:
- When enabled, after each transition: INSERT into `change_log` table
- Change log entry: `{ id, timestamp, event_type, caller, role, state_before_checksum, state_after_checksum, delta }`
- Delta is a JSON diff (not binary — CDC is for audit/replay, not wire efficiency)
- Change log is append-only, queryable via SQLite
- Optional retention: `cdc: { retention: "30 days" }` — framework prunes old entries

### 4. Queue integration

```typescript
// In emit():
emit("queue", { queue: "EMAIL_QUEUE", body: { to: members, subject: "Update" } });
emit("queue", { queue: "ANALYTICS", body: { event: "todo_added" } });
```

Requirements:
- `emit("queue", ...)` writes to outbox with type "queue"
- Outbox drain calls `env[queueName].send(body)`
- Queue name validated against Worker env bindings
- CF Queues provide at-least-once delivery — combined with our outbox, this is double at-least-once (belt and suspenders)

### 5. `routeToActor()` helper

```typescript
import { parseActorRoute } from "@actor-kit/worker";

app.all("/api/:actorType/:actorId/*", async (c) => {
  return routeToActor(c.req.raw, c.env, {
    actorType: c.req.param("actorType"),
    actorId: c.req.param("actorId"),
  });
});
```

Requirements:
- Validates JWT from request
- Gets DO namespace from env (`env[ACTOR_TYPE.toUpperCase()]`)
- WebSocket upgrade → forward to DO's `fetch()`
- GET → spawn (idempotent) + getSnapshot
- POST → spawn (idempotent) + send event from body
- Returns appropriate HTTP responses (JSON for GET/POST, 101 for WS upgrade, 401/403/404 for errors)

## Acceptance criteria

1. `after` timers fire even after DO hibernation
2. `tick` runs while connections exist, stops when all disconnect
3. `ref().call()` invokes RPC handler on target DO
4. CDC entries are written and queryable
5. Queue emissions are delivered via CF Queues
6. `routeToActor()` correctly routes HTTP and WebSocket requests
