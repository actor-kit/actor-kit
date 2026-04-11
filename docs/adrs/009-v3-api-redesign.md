# ADR 009: v3 API Redesign — Pure State Machines + Contract-Driven Types

**Date**: 2026-03-28
**Status**: Accepted
**Supersedes**: [008-typed-request-callbacks](008-typed-request-callbacks.md)

## Context

The v2 API accumulated overlapping patterns that created confusion:

- **Async handlers vs request()** — two ways to do external I/O with different failure models. Users pick the simpler unsafe one.
- **Messages nested by role** — structural coupling between authorization and message definitions. Same message referenced multiple times across roles.
- **request() + callback() + callbacks block** — three concepts to express "do something async and handle the result."
- **actor() erases types** — the returned DO class loses all type information from the definition.
- **Multiple partial APIs** — `on` (legacy), `lifecycle`, `callbacks` coexist. Client event types manually declared, not inferred from the actor.

Codex cross-review confirmed: "v2 has the right engine and the wrong public shape."

## Decision

### 1. One typed contract, everything derives from it

```typescript
import { defineActor, message } from "@actor-kit/worker";

export const Counter = defineActor({
  init: () => ({ count: 0 }),
  messages: {
    INCREMENT: message((state) => ({ ...state, count: state.count + 1 })),
    DECREMENT: message((state) => ({ ...state, count: state.count - 1 })),
  },
});
```

`defineActor()` returns a **typed contract** — not a DO class. Everything derives from it:

```typescript
// Worker: create the DO class
import { createActorClass } from "@actor-kit/worker";
export const CounterDO = createActorClass(Counter);

// Client: typed client factory (events inferred from contract)
import { actorClient } from "@actor-kit/client";
const CounterClient = actorClient(Counter);

// React: typed context (view + events inferred)
import { actorContext } from "@actor-kit/react";
const CounterCtx = actorContext(Counter);

// Test: typed harness
import { testActor } from "@actor-kit/test";
const t = testActor(Counter);

// Ref: typed actor-to-actor communication
import { createRef } from "@actor-kit/worker";
const counter = createRef(Counter, env, "counter-1");
```

No manual event unions. No `typeof`. Client events are `keyof messages` inferred from the contract.

### 2. Flat messages with role guards

Messages are flat — not nested by role. Authorization goes in guards.

```typescript
export const TodoList = defineActor({
  init: (input: { creator: string }) => ({
    todos: [],
    ownerId: input.creator,
  }),

  roles: {
    owner: (state, caller) => caller === state.ownerId,
    member: (state, caller) => state.memberIds.includes(caller),
    viewer: () => true,
  },

  messages: {
    ADD_TODO: message(z.object({ text: z.string() }), (state, { text }) => ({
      ...state,
      todos: [...state.todos, { id: crypto.randomUUID(), text, done: false }],
    })),

    DELETE_TODO: message(z.object({ todoId: z.string() }), {
      guard: (state, payload, ctx) => ctx.role === "owner",
      handler: (state, { todoId }) => ({
        ...state,
        todos: state.todos.filter(t => t.id !== todoId),
      }),
    }),

    TOGGLE: message(z.object({ todoId: z.string() }), (state, { todoId }) => ({
      ...state,
      todos: state.todos.map(t => t.id === todoId ? { ...t, done: !t.done } : t),
    })),
  },

  views: {
    owner: view.shared(OwnerSchema, (state) => ({ todos: state.todos })),
    viewer: view.shared(ViewerSchema, (state) => ({ count: state.todos.length })),
  },
});
```

Guards receive `(state, payload, ctx)` where `ctx` includes `role`, `caller`, `callerType`.

### 3. emit() only — no request/callback

Actors are pure state machines. They transform state and declare intents via `emit()`. All external I/O is handled by Queue consumers or Workflows.

```typescript
// In a message handler — emit intent to a Queue
FETCH_PRICE: message(z.object({ itemId: z.string() }), (state, { itemId }, { emit }) => {
  emit({ queue: "EFFECTS", body: { type: "FETCH_PRICE", itemId } });
  return { ...state, status: "loading" };
}),

// Result comes back as a normal message (sent by the Queue consumer)
PRICE_RESULT: message(z.object({ itemId: z.string(), total: z.number() }), (state, { itemId, total }) => ({
  ...state,
  prices: { ...state.prices, [itemId]: total },
  status: "loaded",
})),
```

The Queue consumer is a separate Worker that does the actual fetch and sends the result back via `stub.send()`.

**Removed:** `request()`, `callback()`, `callbacks` block, `CallbackDef`, `NormalizedRequestConfig`, outbox drain logic for effect execution. The outbox only handles `emit()` delivery to Queues.

### 4. Handlers are synchronous

Message handlers return `TState`, not `TState | Promise<TState>`. No async handlers. External I/O goes through `emit()` → Queue → message back.

If async compute is needed (rare), an explicit escape hatch can be added later.

### 5. Defaults for the simple path

| Feature | Default | Opt-in |
|---------|---------|--------|
| Roles | Everyone can do everything | `roles: { ... }` |
| Input validation | No input needed | `input: z.object({ ... })` |
| Views | Full state as JSON | `views: { ... }` with `schema()` |
| Binary sync | Automatic when view has schema | Always |
| Guards | No guard (open) | `guard: (state, payload, ctx) => boolean` |
| Lifecycle | No handlers | `lifecycle: { connect, disconnect }` |

A counter needs only `init` + `messages`.

### 6. Delete

- `on` block (legacy)
- `callbacks` block
- `callback()` helper
- `request()` on MessageContext
- `CallbackDef`, `NormalizedRequestConfig` types
- `normalizeRequest()` function
- Async handler support (`Promise<TState>` return)
- Messages-by-role nesting
- `actor()` (replaced by `defineActor()` + `createActorClass()`)

## Consequences

### Positive

- One contract is the single source of truth for types — no manual event unions, no type erasure
- Flat messages are easier to read, define once, guard flexibly
- Pure synchronous handlers eliminate the async footgun
- Queue-based effects use real `fetch()` — no framework wrappers
- CF Queues handle retry/DLQ — no custom outbox drain logic
- Dramatically simpler concept count: `defineActor`, `message`, `emit`, `view`, `schema`
- Guards get full context (`state`, `payload`, `ctx.role`) — real preconditions
- Progressive complexity: counter needs 3 lines, full app adds roles/views/guards incrementally

### Negative

- Breaking change — every existing actor definition needs rewriting
- Queue consumer is a second Worker — more infra for actors with external I/O
- Losing `request()` means no built-in "fetch and handle result" pattern — users wire it manually via Queue + message
- `defineActor()` + `createActorClass()` is two functions instead of one `actor()` — but the type safety payoff is worth it

### Neutral

- The outbox still exists for `emit()` delivery — it's simpler (no effect execution, just Queue sends)
- `lifecycle` stays unchanged (connect/disconnect)
- Schema/view/binary sync are unchanged
- The package split (`@actor-kit/*`) is unchanged
