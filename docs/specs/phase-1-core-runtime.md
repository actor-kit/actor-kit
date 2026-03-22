# Phase 1: Core Runtime — Specification

## Goal

Implement the foundational runtime: `actor()`, `schema()`, `view()`, role evaluation, message routing, DO class generation, and SQLite persistence. After this phase, a user can define an actor, deploy it to CF Workers, and interact with it over WebSocket (JSON sync, not binary — binary is Phase 2).

## Deliverables

### 1. `schema()` builder

**File**: `packages/actor-kit/src/schema/schema.ts`

Define view shapes with runtime type information and TypeScript inference.

```typescript
import { schema, uint32, float32, string, boolean, array } from "actor-kit";

const TodoItem = schema({
  id: string,
  text: string,
  done: boolean,
});

const OwnerView = schema({
  todos: array(TodoItem),
  memberCount: uint32,
});
```

Requirements:
- `Infer<typeof OwnerView>` produces `{ todos: { id: string; text: string; done: boolean }[]; memberCount: number }`
- Schema objects carry runtime metadata: field names, field types, field order
- Primitives: `uint8`, `uint16`, `uint32`, `float32`, `float64`, `string`, `boolean`
- Combinators: `array(T)`, nested `schema({...})`
- Implements `StandardSchemaV1` interface (validate function returns typed result or issues)
- Schema objects are immutable (frozen after creation)

### 2. `view()` helper

**File**: `packages/actor-kit/src/core/view.ts`

Pairs a schema with a projection function.

```typescript
const ownerView = view(OwnerView, (state, caller) => ({
  todos: state.todos,
  memberCount: state.memberIds.length,
}));
```

Requirements:
- `view(Schema, fn)` — fn receives `(state: TState, caller: string)` and must return `Infer<Schema>`
- Type error if fn's return type doesn't match schema shape
- The view object carries both the schema and the function

### 3. `actor()` function

**File**: `packages/actor-kit/src/core/actor.ts`

Single function that defines an actor and returns a DO class.

```typescript
export const TodoList = actor("todo-list", {
  input: z.object({ creator: z.string() }),

  init: (input) => ({
    todos: [],
    ownerId: input.creator,
    memberIds: [],
  }),

  version: 1,

  roles: {
    owner: (state, caller) => caller === state.ownerId,
    member: (state, caller) => state.memberIds.includes(caller),
    viewer: () => true,
  },

  messages: {
    owner: {
      ADD_TODO: (state, { text }) => produce(state, d => { ... }),
    },
    member: {},
    viewer: {},
  },

  views: {
    owner: view(OwnerView, (state) => ({ ... })),
    member: view(MemberView, (state) => ({ ... })),
    viewer: view(ViewerView, (state) => ({ ... })),
  },

  on: {
    connect: (state, caller) => state,
    disconnect: (state, caller) => state,
  },
});
```

Requirements:
- Returns a class that extends `DurableObject` (from `cloudflare:workers`)
- TState inferred from `init()` return type
- TRoles inferred from `roles` object keys
- TMessages constrained: keys must be subset of TRoles keys
- TViews constrained: keys must match TRoles keys exactly
- `input` is a Zod schema — parsed on spawn, type flows into `init()`
- `version` is a number — used for migration
- `migrate(persisted, fromVersion)` is optional — runs when stored version !== current
- `serialize(state)` / `restore(serialized)` are optional — for non-JSON-safe state
- No `any` or `as` in the type signature

### 4. Role evaluation

**File**: `packages/actor-kit/src/runtime/roles.ts`

```typescript
function resolveRole<TState, TRoles>(
  roles: TRoles,
  state: TState,
  caller: string,
): keyof TRoles | null;
```

Requirements:
- Iterates role predicates in definition order (relies on object insertion order)
- Returns the first role whose predicate returns `true`
- Returns `null` if no role matches (caller rejected)
- Role predicates receive `(state, caller)` — both readonly

### 5. Message routing

**File**: `packages/actor-kit/src/runtime/messages.ts`

Requirements:
- Given a role and message type, look up the handler
- If the message type doesn't exist for the role → reject with error
- If the message type exists → call handler with `(state, payload, ctx)`
- `ctx` contains `{ caller, role, env, emit }`
- Handler can be sync or async
- Collect any `emit()` calls during the handler execution

### 6. DO class generation

**File**: `packages/actor-kit/src/runtime/durable-actor.ts`

The class returned by `actor()`. Extends `DurableObject`.

Methods:
- `spawn(input)` — idempotent. Validates input, runs `init()`, persists metadata + state.
- `send(caller, event)` — resolves role, routes message, persists state + outbox, broadcasts views.
- `getSnapshot(caller)` — resolves role, computes view, returns JSON (Phase 1, binary in Phase 2).
- `fetch(request)` — handles WebSocket upgrade, forwards to WS lifecycle.

WebSocket lifecycle:
- On connect: validate JWT, resolve role (reject 403 if no match), add to connections map, send full snapshot, run `on.connect`.
- On message: decode JSON, route to `send()`.
- On close: run `on.disconnect`, remove from connections map.
- On error: remove from connections map.

Broadcasting:
- After every state change, compute view for each connected caller.
- Compare with previous view (JSON deep equality for Phase 1).
- If changed, send full JSON snapshot (Phase 1 — delta encoding in Phase 2).

### 7. SQLite persistence

**File**: `packages/actor-kit/src/runtime/storage.ts`

Requirements:
- Create tables on first spawn (actor_meta, snapshots, outbox, emission_failures)
- Persist state after each transition: `serialize(state)` → JSON → INSERT/UPDATE snapshots
- Restore state on DO wake: SELECT → JSON → `restore(serialized)` → run `migrate()` if version mismatch
- Outbox: INSERT emissions in same transaction as state, drain async
- All SQLite operations use the DO's `ctx.storage.sql()` API

### 8. `emit()` and outbox

**File**: `packages/actor-kit/src/runtime/outbox.ts`

Requirements:
- `emit(type, payload)` records intent during transition (does not execute)
- After transition: BEGIN transaction, persist state + outbox entries, COMMIT
- Drain: execute side effects, mark as sent or retry
- 3 retries with exponential backoff (1s, 5s, 25s)
- After 3 failures: move to emission_failures, deliver `emissionFailed` system event
- On DO restart: drain pending outbox entries

### 9. Auth helpers

**File**: `packages/actor-kit/src/auth/`

- `createAccessToken({ actorType, actorId, callerId, secret, expiresIn? })` → JWT string
- `getCallerFromRequest(request, actorType, actorId, secret)` → caller string
- JWT claims: `sub` = callerId, `jti` = actorId, `aud` = actorType
- HS256 signing
- Self-contained — no imports from runtime (no `cloudflare:workers`)

### 10. `testActor()` helper

**File**: `packages/actor-kit/src/test/test-actor.ts`

Requirements:
- `testActor(ActorDef)` returns a test harness
- `t.init(input)` — validates input, runs init, returns state
- `t.send(state, caller, event)` — resolves role, validates message, runs handler, returns new state
- `t.sendWithEffects(state, caller, event)` — same but also returns `{ state, emissions }`
- `t.view(state, caller)` — resolves role, runs view function, returns typed view
- `t.role(state, caller)` — resolves role, returns role name or null
- No CF runtime dependencies — pure TypeScript

## Acceptance criteria

1. A counter actor can be defined with `actor()` and deployed to CF Workers
2. WebSocket connections receive JSON snapshots on connect
3. Messages are routed to the correct role's handler
4. Unauthorized messages are rejected (wrong role)
5. State persists across DO restarts
6. `emit()` calls are persisted in outbox and drained
7. `testActor()` can test all of the above without CF runtime
8. Zero `any` or `as` casts in the implementation
9. All types infer correctly without manual annotation
