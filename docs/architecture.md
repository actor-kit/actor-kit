# System Architecture

## Overview

Actor Kit v2 is a framework for building real-time, event-driven applications on Cloudflare Durable Objects. Each actor is a DO with:
- A **mailbox** (message queue — DO handles this natively)
- **Private state** (persisted to DO SQLite)
- **Behavior** you define (transitions, roles, views)
- **Binary sync** (schema-encoded delta frames over WebSocket)

## Module boundaries

```
packages/
├── core/              schema() builder, type primitives, binary codec, shared types
├── worker/            defineActor(), createActorClass(), message(), DO runtime, identity
├── client/            actorClient(contract).create(), subscribe, send, reconnection
├── react/             actorContext(contract), useView(), useSend(), useRole(), Provider
├── test/              testActor(contract), sendWithEffects(), view assertions
└── storybook/         withActorKit() Storybook decorator, mock client
```

### Dependency flow

```
@actor-kit/core ← @actor-kit/worker        (server-side, imports cloudflare:workers)
@actor-kit/core ← @actor-kit/client         (browser-side, no CF deps)
@actor-kit/core ← @actor-kit/react          (browser-side, imports react)
@actor-kit/core ← @actor-kit/test           (test-time, no CF deps for unit tests)
```

Critical constraint: `@actor-kit/client`, `@actor-kit/react`, and `@actor-kit/test` must NEVER import from `@actor-kit/worker`. The worker package imports `cloudflare:workers` which cannot ship to browsers or run in plain Node.

### Package exports

Each package is published independently under the `@actor-kit/*` scope:
- `@actor-kit/core` — schema primitives, types, binary codec
- `@actor-kit/worker` — `defineActor()`, `createActorClass()`, `message()`, `withCallerIdentity()`
- `@actor-kit/client` — `actorClient(contract).create()`, browser-safe WebSocket client
- `@actor-kit/react` — `actorContext(contract)`, React hooks and Provider
- `@actor-kit/test` — `testActor(contract)`, test harness
- `@actor-kit/storybook` — `withActorKit()` Storybook decorator

## Type system

### The `defineActor()` + `createActorClass()` pattern

```typescript
import { defineActor, createActorClass, message } from "@actor-kit/worker";

// defineActor() returns a typed contract (not a DO class)
const counter = defineActor({
  init: () => ({ count: 0 }),
  roles: { anyone: () => true },
  messages: {
    anyone: {
      increment: message(z.object({}), (state) => ({ ...state, count: state.count + 1 })),
    },
  },
  views: { /* ... */ },
});

// createActorClass() converts contract → DO class
export const Counter = createActorClass(counter);
```

Key type relationships:

```
TState       ← inferred from init() return type
TRoles       ← inferred from roles object keys + predicates
TMessages    ← constrained to keys of TRoles, values are Record<string, MessageDef>
TViews       ← constrained to keys of TRoles, view functions receive TState
TView (union) ← computed: { role: R } & Infer<TViews[R]["schema"]> for each R in TRoles
TAllMessages ← union of all message types across all roles (what the client sees)
```

### The `message()` helper

```typescript
function message<TSchema extends z.ZodType, TState>(
  schema: TSchema,
  handler: (state: TState, payload: z.infer<TSchema>, ctx: MessageContext) => TState,
): MessageDef<z.infer<TSchema>, TState>;
```

Every message handler must be wrapped in `message()` to pair a Zod schema with the handler. The schema is used at runtime for boundary parsing — invalid payloads are rejected before the handler runs.

### MessageContext

```typescript
type MessageContext = {
  caller: string;              // "user-123" — from identity headers
  callerType: "user" | "service";  // from identity headers (stable identity, not authorization)
  role: string;                // "owner" — computed from state by role predicates
  env: TEnv;                   // Worker env bindings (queues, AI, secrets, etc.)
  emit: EmitFn;                // (effect) → void — transactional outbox
};
```

### RolePredicate

```typescript
type RolePredicate<TState> = (
  state: TState,
  caller: string,
  claims: { callerType: "user" | "service" },
) => boolean;
```

Role predicates receive `callerType` from identity headers for distinguishing service vs user callers. Authorization is still derived from state — `callerType` is identity metadata, not a role.

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
  view.todos;  // typed
}
```

## Runtime lifecycle

### Actor creation

```
1. HTTP request arrives at Worker
2. Worker stamps identity via withCallerIdentity(request, { callerId, callerType })
3. Worker forwards to DO via stub.fetch(stampedRequest)
4. DO activates (or wakes from hibernation)
5. If first spawn:
   a. Validate input against Zod schema
   b. Run init(input) → initial state
   c. Persist state to SQLite
   d. Persist actor metadata (name, id, version)
6. If already spawned: no-op (idempotent)
```

### Message processing

```
1. WebSocket frame arrives (binary)
2. Decode message type + payload
3. Extract caller identity from headers (stamped by Worker via withCallerIdentity)
4. Resolve caller role: iterate roles top-to-bottom, first match wins
5. Validate message type exists for this role
6. Validate payload against Zod schema for this message type
7. Run handler: (state, payload, { caller, role, env, emit }) → newState
8. BEGIN SQLite transaction:
   a. Persist new state snapshot
   b. Persist any emit() calls to outbox table
   COMMIT
9. Compute view for each connected caller (may differ per role)
10. Diff previous view vs new view per caller
11. Encode delta as binary frame
12. Send binary frame to each WebSocket
13. Drain outbox (async, outside transaction)
```

### WebSocket lifecycle

```
Connect:
  1. Extract caller identity from headers (Worker-trust) or JWT (fallback)
  2. Resolve role (reject with 403 if no match)
  3. Register WebSocket in connections map (keyed by caller)
  4. Send SNAPSHOT frame (full binary state for this caller's view)
  5. Run lifecycle.connect(state, { caller }, ctx) if defined
  6. Persist state if connect handler changed it
  7. Broadcast view updates to ALL connected callers

Disconnect:
  1. Run lifecycle.disconnect(state, { caller }, ctx) if defined
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
  │ Request                 │                        │
  │ (with app auth)         │                        │
  │────────────────────────>│                        │
  │                         │ Authenticate caller    │
  │                         │ withCallerIdentity()   │
  │                         │ stamps X-Actor-Kit-*   │
  │                         │ headers on request     │
  │                         │───────────────────────>│
  │                         │                        │ Extract identity from headers
  │                         │                        │ Resolve role
  │<─────────────────────────────────────────────────│
  │ SNAPSHOT (binary)       │                        │
```

Identity model:
- Worker authenticates the caller (session cookie, OAuth, etc.)
- Worker stamps identity via `withCallerIdentity(request, { callerId, callerType })`
- DO trusts the Worker — extracts identity from `X-Actor-Kit-Caller-Id` / `X-Actor-Kit-Caller-Type` headers
- `withCallerIdentity()` scrubs any inbound identity headers first (prevents client spoofing)
- CORS/Origin validation is handled at the Worker level (e.g., Hono `cors()` middleware), not inside the actor
- JWT via `Sec-WebSocket-Protocol` is available as a fallback for external clients
