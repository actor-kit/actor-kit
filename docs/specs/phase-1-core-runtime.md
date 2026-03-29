# Phase 1: Core Runtime — Specification

## Goal

Implement the foundational runtime: `actor()`, `schema()`, `view()`, `message()`, role evaluation, message routing, DO class generation, and SQLite persistence. After this phase, a user can define an actor, deploy it to CF Workers, and interact with it over WebSocket (JSON sync, not binary — binary is Phase 2).

## Deliverables

### 1. `schema()` builder

**File**: `packages/core/src/schema.ts`

Define view shapes with runtime type information and TypeScript inference.

```typescript
import { schema, uint32, float32, string, boolean, array } from "@actor-kit/core";

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

**File**: `packages/worker/src/view.ts`

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

**File**: `packages/worker/src/message.ts`

Pairs a Zod schema with a handler function. Every message handler must have a runtime schema for payload validation at the boundary.

```typescript
import { message } from "@actor-kit/worker";
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

### 4. `defineActor()` + `createActorClass()`

**File**: `packages/worker/src/define.ts` + `packages/worker/src/actor.ts`

`defineActor()` returns a typed contract. `createActorClass()` converts it to a DO class.

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

const todoList = defineActor({
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
          emit({ queue: "EMAIL_QUEUE", body: { to: state.memberIds } });
          return state;
        },
      ),
      FETCH_REPORT: message(
        z.object({}),
        (state, _, { request }) => {
          request({
            fetch: "https://api.example.com/report",
            onDone: "REPORT_LOADED",
            onError: "REPORT_FAILED",
          });
          return produce(state, d => { d.reportStatus = "loading"; });
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

  lifecycle: {
    connect: (state, { caller }, ctx) => state,
    disconnect: (state, { caller }, ctx) => state,
  },
});

export const TodoList = createActorClass(todoList);
```

Requirements:
- `defineActor(def)` — returns a typed contract preserving TState, TInput, TMessages, TRoles, TViews
- `createActorClass(contract)` — returns a class that extends `DurableObject` (from `cloudflare:workers`)
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

**File**: `packages/worker/src/runtime/roles.ts`

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

**File**: `packages/worker/src/runtime/message-router.ts`

Requirements:
- Given a role and message type, look up the `MessageDef`
- If the message type doesn't exist for the role → reject with error
- If the message type exists → `safeParse` payload with the MessageDef's Zod schema
- If parse fails → reject with structured validation error (handler never runs)
- If parse succeeds → call handler with `(state, parsedPayload, ctx)`
- `ctx` contains `{ caller, callerType, role, env, emit, request }`
- If guard is present: evaluate `guard(state)` — reject if false (handler never runs)
- Handler can be sync or async
- Collect any `emit()` and `request()` calls during the handler execution
- If using `states`: look up messages for the current state × role. In parallel mode, scan all active regions.
- Same message name across multiple roles must reference the same `MessageDef` object (type-enforced)

### 7. DO class generation

**File**: `packages/worker/src/actor.ts`

The class returned by `createActorClass()`. Extends `DurableObject`.

Methods:
- `spawn(input)` — idempotent. Validates input with `safeParse`, runs `init()`, persists metadata + state. Invalid input = error, actor never created.
- `send(caller, callerType, event)` — resolves role, routes message, persists state + outbox, broadcasts views.
- `getSnapshot(caller, callerType)` — resolves role, computes view, returns JSON (Phase 1, binary in Phase 2).
- `fetch(request)` — handles WebSocket upgrade, forwards to WS lifecycle.

WebSocket lifecycle:
- On connect: extract caller identity from headers (Worker-trust) or JWT (fallback), resolve role (reject 403 if no match), add to connections map, send full snapshot, run `lifecycle.connect`.
- On message: decode JSON, route to `send()`.
- On close: run `lifecycle.disconnect`, remove from connections map.
- On error: remove from connections map.

Broadcasting:
- After every state change, compute view for each connected caller.
- Compare with previous view (JSON deep equality for Phase 1).
- If changed, send full JSON snapshot (Phase 1 — delta encoding in Phase 2).

### 8. SQLite persistence

**File**: `packages/worker/src/runtime/storage.ts`

Requirements:
- Create tables on first spawn (actor_meta, snapshots, outbox, emission_failures)
- Persist state after each transition: `serialize(state)` → JSON → INSERT/UPDATE snapshots
- Restore state on DO wake: SELECT → JSON → `restore(serialized)` → run `migrate()` if version mismatch
- Outbox: INSERT emissions in same transaction as state, drain async
- All SQLite operations use the DO's `ctx.storage.sql()` API

### 9. `emit()` and `request()` — transactional outbox

**File**: `packages/worker/src/runtime/outbox.ts`

Two functions on `ctx`:

**`emit(effect)`** — fire-and-forget side effect:
```typescript
ctx.emit({ queue: "EMAIL_QUEUE", body: { to: state.memberIds } });
ctx.emit({ fetch: "https://analytics.example.com/track", body: { event: "created" } });
ctx.emit({ actor: "audit-log", id: "global", message: "LOG", payload: { action: "deleted" } });
```

**`request(config)`** — async with response callbacks:
```typescript
ctx.request({
  fetch: "https://api.example.com/data",
  onDone: "FETCH_SUCCEEDED",
  onError: "FETCH_FAILED",
});
ctx.request({
  actor: "inventory", id: callerId, message: "RESERVE_ITEM", payload: { itemId },
  onDone: "ITEM_RESERVED",
  onError: "RESERVE_FAILED",
});
```

`onDone`/`onError` are message names delivered to the actor's `on` block. They're strings (serializable to SQLite), not closures.

Effect types:
```typescript
type Effect =
  | { queue: string; body: unknown }
  | { fetch: string; method?: string; body?: unknown; headers?: Record<string, string> }
  | { actor: string; id: string; message: string; payload: unknown };

type RequestConfig = Effect & { onDone: string; onError: string };
```

Requirements:
- `emit(effect)` and `request(config)` record intent during transition (do not execute)
- After transition: BEGIN SQLite transaction, persist state + outbox entries, COMMIT
- Outbox entries for `request()` store `onDone`/`onError` message names alongside the effect
- Drain: execute side effects, mark as sent or retry
- For `request()`: on success, deliver `onDone` message to actor's `on` block with result. On failure, deliver `onError`.
- 3 retries with exponential backoff (1s, 5s, 25s)
- After 3 failures: move to emission_failures, deliver `onError` if it was a request, or system `emissionFailed` event if it was a fire-and-forget emit
- On DO restart: drain pending outbox entries (callbacks survive crash because they're stored as strings)

### 10. Identity helpers

**File**: `packages/worker/src/identity.ts`

- `withCallerIdentity(request, { callerId, callerType })` — stamps verified identity headers on a request
- Scrubs any inbound `X-Actor-Kit-Caller-*` headers first (prevents client spoofing)
- Worker authenticates the caller, DO trusts the Worker
- JWT via `Sec-WebSocket-Protocol` available as fallback for external clients
- CORS/Origin validation is handled at the Worker level (e.g., Hono `cors()` middleware), not inside the actor

### 11. `testActor()` helper

**File**: `packages/test/src/test-actor.ts`

Requirements:
- `testActor(contract)` returns a test harness
- `t.init(input)` — validates input, runs init, returns state
- `t.send(state, caller, event)` — resolves role (default callerType: "user"), validates message schema, runs handler, returns new state
- `t.send(state, caller, event, { callerType: "service" })` — override callerType
- `t.sendWithEffects(state, caller, event)` — same but also returns `{ state, emissions }`
- `t.view(state, caller)` — resolves role, runs view function, returns typed view with `role` discriminant
- `t.role(state, caller)` — resolves role, returns role name or null
- No CF runtime dependencies — pure TypeScript
- `env` in ctx is a mock object that records calls (for emit testing)

### 12. States (optional)

**File**: `packages/worker/src/runtime/states.ts`

Three modes — all supported in Phase 1:

**Mode A: No states** — messages at top level. All messages always valid (gated by role + guard only).

```typescript
const counter = defineActor({
  init: () => ({ count: 0 }),
  roles: { anyone: () => true },
  messages: {
    anyone: { INCREMENT: increment },
  },
  views: { /* ... */ },
});
export const Counter = createActorClass(counter);
```

**Mode B: Sequential states** — one active state at a time. Messages defined per state × role.

```typescript
const auction = defineActor({
  init: (input) => ({ item: input.item, bids: [], winner: null }),
  initial: "bidding",
  roles: {
    bidder: (state, caller) => true,
    auctioneer: (state, caller, { callerType }) => callerType === "service",
  },
  states: {
    bidding: {
      messages: {
        bidder: {
          BID: message(z.object({ amount: z.number() }), (state, { amount }, { caller }) =>
            produce(state, d => { d.bids.push({ caller, amount }); }),
          ),
        },
        auctioneer: {},
      },
      after: { "1 hour": "evaluating" },
    },
    evaluating: {
      messages: {
        bidder: {},
        auctioneer: {
          CLOSE: message(z.object({}), (state) => {
            const winner = state.bids.reduce((a, b) => a.amount > b.amount ? a : b);
            return produce(state, d => { d.winner = winner.caller; });
          }),
        },
      },
    },
    closed: {
      messages: { bidder: {}, auctioneer: {} },
    },
  },
  views: { ... },
});
```

**Mode C: Parallel states** — multiple independent regions active simultaneously.

```typescript
const player = defineActor({
  init: () => ({ health: 100, ... }),
  roles: { player: () => true },
  states: {
    parallel: true,
    regions: {
      vitality: {
        initial: "alive",
        states: {
          alive: {
            messages: { player: { MOVE: move, ATTACK: attack } },
          },
          dead: {
            messages: { player: {} },
            after: { "10 seconds": "alive" },
          },
        },
      },
      combat: {
        initial: "peaceful",
        states: {
          peaceful: {
            messages: { player: { ENGAGE: engage } },
          },
          in_combat: {
            messages: { player: { DISENGAGE: disengage } },
            after: { "30 seconds": "peaceful" },
          },
        },
      },
    },
  },
  views: { ... },
});
```

Requirements:
- `states` is optional. If absent, `messages` must be at top level.
- If `states` is present, `messages` must NOT be at top level (type error).
- `initial` required for sequential states, required per region for parallel states.
- State transitions: handler returns state with updated status field, or `after` triggers timed transition.
- `after` maps to DO Alarms (survives hibernation). String parsed: "1 hour", "30 seconds", "5 minutes".
- Parallel: a message is valid if it's valid in ANY active region.
- Framework tracks current state(s) and persists alongside actor state.
- State value is framework-managed (not a user field) — accessed via `ctx.state` or `state.__actorState`.

## Acceptance criteria

1. A counter actor can be defined with `defineActor()` + `createActorClass()` and deployed to CF Workers
2. WebSocket connections receive JSON snapshots on connect
3. Messages are routed to the correct role's handler
4. Unauthorized messages are rejected (wrong role)
5. Invalid message payloads are rejected by Zod (handler never runs)
6. Guards reject messages before handler runs
7. State persists across DO restarts
8. `emit()` calls are persisted in outbox and drained
9. `request()` calls deliver onDone/onError callbacks to the `on` block
10. `testActor()` can test all of the above without CF runtime
11. Zero `any` or `as` casts in the implementation
12. All types infer correctly without manual annotation
13. `callerType` from JWT flows into role predicates and message context
14. Shared `message()` handlers work across multiple roles without duplication
15. Sequential states constrain which messages are valid per state
16. Parallel states allow messages valid in any active region
17. `after` timers trigger state transitions
18. Same message name across roles must be same `MessageDef` (type-enforced)
