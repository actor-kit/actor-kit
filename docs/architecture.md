# System Architecture

## Overview

Actor Kit v2 is a framework for building real-time, event-driven applications on Cloudflare Durable Objects. Each actor is a DO with:
- A **mailbox** (message queue — DO handles this natively)
- **Private state** (persisted to DO SQLite)
- **Behavior** you define (transitions, roles, views)
- **Binary sync** (schema-encoded delta frames over WebSocket)

## Module boundaries

```
actor-kit/
├── src/
│   ├── core/          Public API: actor(), view(), ref(), emit()
│   ├── schema/        schema() builder, type primitives, binary codec
│   ├── runtime/       DO class factory, WebSocket lifecycle, persistence, outbox
│   ├── auth/          JWT creation (createAccessToken) + validation (getCallerFromRequest)
│   ├── client/        connect(), subscribe, send, trigger, reconnection
│   ├── react/         createContext(), useView(), useSend(), useRole(), Provider
│   └── test/          testActor(), sendWithEffects(), view assertions
```

### Dependency flow

```
schema/ ← core/ ← runtime/        (server-side, imports cloudflare:workers)
schema/ ← core/ ← client/         (browser-side, no CF deps)
               ← react/           (browser-side, imports react)
               ← test/            (test-time, no CF deps for unit tests)
               ← auth/            (standalone, imports jose)
```

Critical constraint: `client/`, `react/`, and `test/` must NEVER import from `runtime/`. The runtime imports `cloudflare:workers` which cannot ship to browsers or run in plain Node.

### Subpath exports

```json
{
  "exports": {
    ".":        "./dist/core/index.js",
    "./client": "./dist/client/index.js",
    "./react":  "./dist/react/index.js",
    "./test":   "./dist/test/index.js"
  }
}
```

The root export (`.`) includes the server-side runtime. Users import it in their Worker entrypoint. `./client` and `./react` are browser-safe.

## Type system

### The `actor()` function

```typescript
function actor<
  TInput extends z.ZodType,
  TState,
  TRoles extends Record<string, RolePredicate<TState>>,
  TMessages extends RoleMessages<TState, TRoles>,
  TViews extends RoleViews<TState, TRoles>,
>(
  name: string,
  def: ActorDef<TInput, TState, TRoles, TMessages, TViews>,
): ActorClass<TInput, TState, TRoles, TMessages, TViews>;
```

Key type relationships:

```
TState       ← inferred from init() return type
TRoles       ← inferred from roles object keys + predicates
TMessages    ← constrained to keys of TRoles, handlers receive TState
TViews       ← constrained to keys of TRoles, view functions receive TState
TView (union) ← computed: { role: R } & Infer<TViews[R]["schema"]> for each R in TRoles
```

### Schema type inference

```typescript
const MyView = schema({
  count: uint32,        // SchemaField<"uint32", number>
  name: string,         // SchemaField<"string", string>
  items: array(Item),   // SchemaField<"array", Infer<typeof Item>[]>
});

type MyViewType = Infer<typeof MyView>;
// { count: number; name: string; items: ItemType[] }
```

`Infer<T>` extracts the TypeScript type from a schema definition. This is compile-time only — no runtime overhead.

### Role-scoped view union

```typescript
// Given:
views: {
  owner: view(OwnerView, fn),
  viewer: view(ViewerView, fn),
},

// The framework computes:
type TView =
  | { role: "owner" } & Infer<typeof OwnerView>
  | { role: "viewer" } & Infer<typeof ViewerView>;

// Client code narrows via discriminant:
if (view.role === "owner") {
  view.todos;  // ✓ typed
}
```

## Runtime lifecycle

### Actor creation

```
1. HTTP request arrives at Worker
2. Worker calls ref(env, "todo-list", "abc123")
3. ref() gets DO stub: env.TODO_LIST.get(env.TODO_LIST.idFromName("abc123"))
4. Worker calls stub.spawn({ creator: "user-1" })
5. DO activates (or wakes from hibernation)
6. If first spawn:
   a. Validate input against Zod schema
   b. Run init(input) → initial state
   c. Persist state to SQLite
   d. Persist actor metadata (name, id, version)
7. If already spawned: no-op (idempotent)
```

### Message processing

```
1. WebSocket frame arrives (binary)
2. Decode message type + payload
3. Validate JWT (already validated on connect, but check expiry)
4. Resolve caller role: iterate roles top-to-bottom, first match wins
5. Validate message type exists for this role
6. Validate payload against Zod schema for this message type
7. Run handler: (state, payload, { caller, role, env, emit }) → newState
8. If handler is async: await it
9. BEGIN SQLite transaction:
   a. Persist new state snapshot
   b. Persist any emit() calls to outbox table
   COMMIT
10. Compute view for each connected caller (may differ per role)
11. Diff previous view vs new view per caller
12. Encode delta as binary frame
13. Send binary frame to each WebSocket
14. Drain outbox (async, outside transaction)
```

### WebSocket lifecycle

```
Connect:
  1. Validate JWT
  2. Resolve role (reject with 403 if no match)
  3. Register WebSocket in connections map (keyed by caller)
  4. Send SNAPSHOT frame (full binary state for this caller's view)
  5. Run on.connect(state, caller) if defined
  6. Persist state if connect handler changed it
  7. Broadcast view updates to ALL connected callers

Disconnect:
  1. Run on.disconnect(state, caller) if defined
  2. Persist state if disconnect handler changed it
  3. Remove WebSocket from connections map
  4. Broadcast view updates to remaining callers

Reconnect:
  1. Client sends { lastChecksum, schemaVersion }
  2. If schema version mismatch: send SCHEMA_CHANGED + SNAPSHOT
  3. If checksum matches recent: send DELTA from that point
  4. If checksum unknown: send full SNAPSHOT
  5. Re-run role evaluation (may have changed)
```

### Persistence model

SQLite tables in the DO:

```sql
CREATE TABLE actor_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
-- Keys: "name", "id", "version", "created_at"

CREATE TABLE snapshots (
  version INTEGER PRIMARY KEY,
  state BLOB,
  checksum TEXT,
  updated_at INTEGER
);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  type TEXT,
  payload TEXT,
  status TEXT DEFAULT 'pending',
  attempts INTEGER DEFAULT 0,
  created_at INTEGER,
  last_attempt_at INTEGER
);

CREATE TABLE emission_failures (
  id TEXT PRIMARY KEY,
  type TEXT,
  payload TEXT,
  error TEXT,
  failed_at INTEGER
);
```

### Transactional outbox

```
Transition completes → state + emissions collected
  → BEGIN TRANSACTION
      INSERT INTO snapshots (state)
      INSERT INTO outbox (id, type, payload) for each emit()
    COMMIT
  → Schedule outbox drain (non-blocking)

Outbox drain:
  → SELECT * FROM outbox WHERE status = 'pending' ORDER BY created_at
  → For each:
      Execute side effect (queue.send, fetch, rpc.call)
      If success: UPDATE status = 'sent'
      If failure: INCREMENT attempts
        If attempts >= 3: move to emission_failures, deliver EMISSION_FAILED event
        Else: exponential backoff (1s, 5s, 25s)

DO restart:
  → Drain outbox immediately (pending items from before crash)
```

### Actor-to-actor communication (DO RPC)

```typescript
// Calling actor:
const other = ref(env, "zone", "forest-north");
await other.call("ACCEPT_TRANSFER", { callerId, playerData });

// Under the hood:
// 1. ref() returns a typed stub wrapping env.ZONE.get(env.ZONE.idFromName("forest-north"))
// 2. call() invokes the RPC method on the target DO
// 3. Target DO runs the rpc handler as a transition
// 4. Result (or error) propagates back to caller
```

RPC handlers live in the `rpc` block. They are NOT exposed to WebSocket clients. They don't go through role evaluation (the calling actor is trusted).

### Timers

Two mechanisms:

| Feature | Mechanism | Survives hibernation | Min granularity |
|---------|-----------|---------------------|-----------------|
| `tick` | `setInterval` while DO is awake | No (re-created on wake) | 1ms |
| `after` | DO Alarm | Yes | ~1s |

`tick` only runs when at least one WebSocket is connected. Zero connections = no tick = DO hibernates.

`after` timers are persisted as DO Alarms. They fire even if the DO was evicted and restarted.

## Authentication flow

```
Client                    Worker                    DO
  │                         │                        │
  │ GET /token              │                        │
  │ (with app auth)         │                        │
  │────────────────────────>│                        │
  │                         │ createAccessToken()    │
  │                         │ JWT: sub=user-123      │
  │                         │      jti=todo-456      │
  │                         │      aud=todo-list     │
  │<────────────────────────│                        │
  │ { token: "eyJ..." }    │                        │
  │                         │                        │
  │ WS /api/todo-list/456  │                        │
  │ Authorization: Bearer   │                        │
  │────────────────────────>│ routeToActor()         │
  │                         │───────────────────────>│
  │                         │                        │ Validate JWT
  │                         │                        │ Extract caller = "user-123"
  │                         │                        │ Resolve role
  │<─────────────────────────────────────────────────│
  │ SNAPSHOT (binary)       │                        │
```

JWT claims:
- `sub`: caller identity (plain string)
- `jti`: actor ID (ties token to specific actor)
- `aud`: actor type (prevents cross-type token reuse)
- `exp`: expiry (default 30 days)
- Signed with HS256 using `ACTOR_KIT_SECRET` from Worker env
