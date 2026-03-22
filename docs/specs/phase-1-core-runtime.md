# Phase 1: Core Runtime — Specification

## Goal

Implement the foundational runtime: `actor()`, `schema()`, `view()`, `message()`, role evaluation, message routing, DO class generation, and SQLite persistence. After this phase, a user can define an actor, deploy it to CF Workers, and interact with it over WebSocket (JSON sync, not binary — binary is Phase 2).

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

### 3. `message()` helper

**File**: `packages/actor-kit/src/core/message.ts`

Pairs a Zod schema with a handler function. Every message handler must have a runtime schema for payload validation at the boundary.

```typescript
import { message } from "actor-kit";
import { z } from "zod";

const addTodo = message(
  z.object({ text: z.string() }),
  (state, { text }, { caller }) =>
    produce(state, d => {
      d.todos.push({ id: crypto.randomUUID(), text, done: false });
    }),
);

// No-payload messages use z.object({})
const reset = message(
  z.object({}),
  (state, _, { caller, emit }) => {
    emit("queue", { queue: "AUDIT_LOG", body: { action: "reset", caller } });
    return { ...state, todos: [] };
  },
);
```

Requirements:
- `message(zodSchema, handler)` — returns a `MessageDef<TPayload, TState, TEnv>` object
- The Zod schema is used at runtime to `safeParse` the incoming payload before the handler runs
- Invalid payloads are rejected with a structured error — the handler never executes
- Handler signature: `(state: TState, payload: z.infer<TSchema>, ctx: MessageContext<TEnv>) => TState | Promise<TState>`
- `MessageContext<TEnv>` contains `{ caller: string, callerType: "user" | "service", role: string, env: TEnv, emit: EmitFn }`
- `message()` objects can be shared across roles (extract to a variable, reference in multiple roles)
- Handlers can be sync or async

### 4. `actor()` function

**File**: `packages/actor-kit/src/core/actor.ts`

Single function that defines an actor and returns a DO class. Takes a generic `TEnv` parameter for typed Worker env bindings.

```typescript
type Env = {
  ACTOR_KIT_SECRET: string;
  EMAIL_QUEUE: Queue;
};

const addTodo = message(
  z.object({ text: z.string() }),
  (state, { text }, { caller }) =>
    produce(state, d => {
      d.todos.push({ id: crypto.randomUUID(), text, done: false });
    }),
);

const toggle = message(
  z.object({ id: z.string() }),
  (state, { id }) =>
    produce(state, d => {
      const todo = d.todos.find(t => t.id === id);
      if (todo) todo.done = !todo.done;
    }),
);

export const TodoList = actor<Env>("todo-list", {
  input: z.object({ creator: z.string() }),

  init: (input) => ({
    todos: [] as { id: string; text: string; done: false }[],
    ownerId: input.creator,
    memberIds: [] as string[],
  }),

  version: 1,

  roles: {
    owner: (state, caller) => caller === state.ownerId,
    member: (state, caller) => state.memberIds.includes(caller),
    viewer: () => true,
  },

  messages: {
    owner: {
      ADD_TODO: addTodo,
      TOGGLE: toggle,
      DELETE_TODO: message(
        z.object({ id: z.string() }),
        (state, { id }) =>
          produce(state, d => { d.todos = d.todos.filter(t => t.id !== id); }),
      ),
      INVITE: message(
        z.object({ userId: z.string() }),
        (state, { userId }) =>
          produce(state, d => { d.memberIds.push(userId); }),
      ),
      NOTIFY_ALL: message(
        z.object({}),
        (state, _, { emit }) => {
          emit("queue", { queue: "EMAIL_QUEUE", body: { to: state.memberIds } });
          return state;
        },
      ),
    },
    member: {
      ADD_TODO: addTodo,
      TOGGLE: toggle,
    },
    viewer: {},
  },

  views: {
    owner: view(OwnerView, (state) => ({
      todos: state.todos,
      memberCount: state.memberIds.length,
    })),
    member: view(OwnerView, (state) => ({
      todos: state.todos,
      memberCount: state.memberIds.length,
    })),
    viewer: view(ViewerView, (state) => ({
      todoCount: state.todos.length,
      doneCount: state.todos.filter(t => t.done).length,
    })),
  },

  on: {
    connect: (state, caller, ctx) => state,
    disconnect: (state, caller, ctx) => state,
  },
});
```

Requirements:
- `actor<TEnv>(name, def)` — TEnv is the Worker env type, flows into `MessageContext<TEnv>`
- Returns a class that extends `DurableObject` (from `cloudflare:workers`)
- TState inferred from `init()` return type
- TRoles inferred from `roles` object keys
- TMessages constrained: keys must be subset of TRoles keys, values must be `Record<string, MessageDef>`
- TViews constrained: keys must match TRoles keys exactly
- `input` is a Zod schema — parsed on spawn, type flows into `init()`
- `version` is a number — used for migration
- `migrate(persisted, fromVersion)` is optional — runs when stored version !== current
- `serialize(state)` / `restore(serialized)` are optional — for non-JSON-safe state
- No `any` or `as` in the type signature

### 5. Role evaluation

**File**: `packages/actor-kit/src/runtime/roles.ts`

```typescript
type RolePredicate<TState> = (
  state: TState,
  caller: string,
  claims: { callerType: "user" | "service" },
) => boolean;

function resolveRole<TState, TRoles extends Record<string, RolePredicate<TState>>>(
  roles: TRoles,
  state: TState,
  caller: string,
  claims: { callerType: "user" | "service" },
): keyof TRoles | null;
```

Requirements:
- Iterates role predicates in definition order (relies on object insertion order)
- Returns the first role whose predicate returns `true`
- Returns `null` if no role matches (caller rejected)
- Role predicates receive `(state, caller, claims)` — state is readonly
- `claims.callerType` comes from JWT (stable identity metadata, not authorization)

### 6. Message routing

**File**: `packages/actor-kit/src/runtime/messages.ts`

Requirements:
- Given a role and message type, look up the `MessageDef`
- If the message type doesn't exist for the role → reject with error
- If the message type exists → `safeParse` payload with the MessageDef's Zod schema
- If parse fails → reject with structured validation error (handler never runs)
- If parse succeeds → call handler with `(state, parsedPayload, ctx)`
- `ctx` contains `{ caller, callerType, role, env, emit }`
- Handler can be sync or async
- Collect any `emit()` calls during the handler execution

### 7. DO class generation

**File**: `packages/actor-kit/src/runtime/durable-actor.ts`

The class returned by `actor()`. Extends `DurableObject`.

Methods:
- `spawn(input)` — idempotent. Validates input with `safeParse`, runs `init()`, persists metadata + state. Invalid input = error, actor never created.
- `send(caller, callerType, event)` — resolves role, routes message, persists state + outbox, broadcasts views.
- `getSnapshot(caller, callerType)` — resolves role, computes view, returns JSON (Phase 1, binary in Phase 2).
- `fetch(request)` — handles WebSocket upgrade, forwards to WS lifecycle.

WebSocket lifecycle:
- On connect: validate JWT, extract caller + callerType, resolve role (reject 403 if no match), add to connections map, send full snapshot, run `on.connect`.
- On message: decode JSON, route to `send()`.
- On close: run `on.disconnect`, remove from connections map.
- On error: remove from connections map.

Broadcasting:
- After every state change, compute view for each connected caller.
- Compare with previous view (JSON deep equality for Phase 1).
- If changed, send full JSON snapshot (Phase 1 — delta encoding in Phase 2).

### 8. SQLite persistence

**File**: `packages/actor-kit/src/runtime/storage.ts`

Requirements:
- Create tables on first spawn (actor_meta, snapshots, outbox, emission_failures)
- Persist state after each transition: `serialize(state)` → JSON → INSERT/UPDATE snapshots
- Restore state on DO wake: SELECT → JSON → `restore(serialized)` → run `migrate()` if version mismatch
- Outbox: INSERT emissions in same transaction as state, drain async
- All SQLite operations use the DO's `ctx.storage.sql()` API

### 9. `emit()` and outbox

**File**: `packages/actor-kit/src/runtime/outbox.ts`

Requirements:
- `emit(type, payload)` records intent during transition (does not execute)
- After transition: BEGIN transaction, persist state + outbox entries, COMMIT
- Drain: execute side effects, mark as sent or retry
- 3 retries with exponential backoff (1s, 5s, 25s)
- After 3 failures: move to emission_failures, deliver `emissionFailed` system event
- On DO restart: drain pending outbox entries

### 10. Auth helpers

**File**: `packages/actor-kit/src/auth/`

- `createAccessToken({ actorType, actorId, callerId, callerType, secret, expiresIn? })` → JWT string
- `getCallerFromRequest(request, actorType, actorId, secret)` → `{ caller: string, callerType: "user" | "service" }`
- JWT claims: `sub` = callerId, `act` = callerType, `jti` = actorId, `aud` = actorType
- HS256 signing
- Self-contained — no imports from runtime (no `cloudflare:workers`)

### 11. `testActor()` helper

**File**: `packages/actor-kit/src/test/test-actor.ts`

Requirements:
- `testActor(ActorDef)` returns a test harness
- `t.init(input)` — validates input, runs init, returns state
- `t.send(state, caller, event)` — resolves role (default callerType: "user"), validates message schema, runs handler, returns new state
- `t.send(state, caller, event, { callerType: "service" })` — override callerType
- `t.sendWithEffects(state, caller, event)` — same but also returns `{ state, emissions }`
- `t.view(state, caller)` — resolves role, runs view function, returns typed view with `role` discriminant
- `t.role(state, caller)` — resolves role, returns role name or null
- No CF runtime dependencies — pure TypeScript
- `env` in ctx is a mock object that records calls (for emit testing)

## Acceptance criteria

1. A counter actor can be defined with `actor()` and deployed to CF Workers
2. WebSocket connections receive JSON snapshots on connect
3. Messages are routed to the correct role's handler
4. Unauthorized messages are rejected (wrong role)
5. Invalid message payloads are rejected by Zod (handler never runs)
6. State persists across DO restarts
7. `emit()` calls are persisted in outbox and drained
8. `testActor()` can test all of the above without CF runtime
9. Zero `any` or `as` casts in the implementation
10. All types infer correctly without manual annotation
11. `callerType` from JWT flows into role predicates and message context
12. Shared `message()` handlers work across multiple roles without duplication
