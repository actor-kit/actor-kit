---
title: Messages & Guards
description: How messages are validated and how guards work.
---

## Messages

Every message handler is wrapped in `message()` — pairing a Zod schema with a handler function.

```typescript
import { message } from "actor-kit";
import { z } from "zod";

const addTodo = message(
  z.object({ text: z.string().min(1).max(200) }),
  (state, { text }, { caller }) => ({
    ...state,
    todos: [...state.todos, { id: crypto.randomUUID(), text, done: false }],
  }),
);
```

### Validation at the Boundary

The Zod schema runs `safeParse` on every incoming payload **before** the handler executes. If validation fails:
- The handler never runs
- The client receives an `__error` frame with `"validation_failed"`
- State is unchanged

### Handler Signature

```typescript
(state: TState, payload: TPayload, ctx: MessageContext) => TState | Promise<TState>
```

- **`state`** — current actor state (immutable — return a new object)
- **`payload`** — Zod-validated payload
- **`ctx`** — context with `caller`, `callerType`, `role`, `env`, `emit`, `request`

### Async Handlers

Handlers can be `async` — useful for calling external APIs that inform the next state:

```typescript
const enrichTodo = message(z.object({ todoId: z.string() }), async (state, { todoId }, { env }) => {
  const res = await fetch("https://api.example.com/suggest");
  const { suggestion } = await res.json();
  return { ...state, todos: state.todos.map(t =>
    t.id === todoId ? { ...t, suggestion } : t
  )};
});
```

## Guards

Guards are optional conditions on messages. If the guard returns `false`, the message is rejected before the handler runs.

```typescript
const placeBid = message(
  z.object({ amount: z.number().positive() }),
  {
    guard: (state) => !state.closed,
    handler: (state, { amount }, { caller }) => ({
      ...state,
      bids: [...state.bids, { bidder: caller, amount }],
    }),
  },
);
```

### Evaluation Order

```
1. Resolve role → reject if no match (403)
2. Look up message for role → reject if not found
3. Validate payload with Zod → reject if invalid
4. Evaluate guard(state) → reject if false
5. Run handler
```

Guards see the current state but not the payload — they're about "is this action allowed right now?" not "is this specific data valid?"

## Sharing Handlers Across Roles

Since `message()` returns an object, you can reference the same handler in multiple roles:

```typescript
const addTodo = message(z.object({ text: z.string() }), handler);

messages: {
  owner: { ADD_TODO: addTodo, DELETE_TODO: deleteTodo },
  member: { ADD_TODO: addTodo },
},
```

No duplication. The same `addTodo` object is used for both roles.

## Error Handling

When a message is rejected, the client receives an `__error` JSON message with the reason:

| Step | Failure | Client receives |
|------|---------|----------------|
| Role resolution | No role matches | Connection rejected (403) |
| Message lookup | Message not found for role | `{ type: "__error", error: "message_not_found" }` |
| Zod validation | Payload doesn't match schema | `{ type: "__error", error: "validation_failed", detail: "..." }` |
| Guard | Guard returns false | `{ type: "__error", error: "guard_failed" }` |
| Handler | Handler throws | Error logged server-side; state unchanged |

The actor's state is never modified when a message is rejected. The rejection happens before the handler runs (for validation/guard failures) or the state change is rolled back (for handler exceptions).

## Related

- [Side Effects](/concepts/side-effects/) — `emit()` and `request()` for triggering effects from message handlers
- [Testing](/concepts/testing/) — verify message validation, guards, and handler behavior with `testActor()`
