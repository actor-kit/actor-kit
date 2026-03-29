---
title: Messages & Guards
description: How messages are validated and how guards work.
---

## Messages

Every message handler is wrapped in `message()` — pairing a Zod schema with a handler function.

```typescript
import { message } from "@actor-kit/worker";
import { z } from "zod";

const addTodo = message(
  z.object({ text: z.string().min(1).max(200) }),
  (state, { text }, { caller }) => ({
    ...state,
    todos: [...state.todos, { id: crypto.randomUUID(), text, done: false }],
  }),
);
```

### Flat Messages

Messages are defined at the top level — not nested by role. Authorization goes in guards:

```typescript
messages: {
  ADD_TODO: addTodo,                          // No guard = open to all roles
  DELETE_TODO: message(z.object({ id: z.string() }), {
    guard: (_state, _payload, ctx) => ctx.role === "owner",
    handler: (state, { id }) => ({
      ...state,
      todos: state.todos.filter(t => t.id !== id),
    }),
  }),
},
```

### Validation at the Boundary

The Zod schema runs `safeParse` on every incoming payload **before** the handler executes. If validation fails:
- The handler never runs
- The client receives an `__error` frame with `"validation_failed"`
- State is unchanged

### Handler Signature

```typescript
(state: TState, payload: TPayload, ctx: MessageContext) => TState
```

- **`state`** — current actor state (immutable — return a new object)
- **`payload`** — Zod-validated payload
- **`ctx`** — context with `caller`, `callerType`, `role`, `env`, `emit`

Handlers are synchronous — they return new state, not a Promise. External I/O goes through `emit()` → Queue → message back. See [Side Effects](/concepts/side-effects/).

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

Guards receive `(state, payload, ctx)` where `ctx` includes `role`, `caller`, and `callerType`. This enables three kinds of guards:

- **State guards**: `(state) => !state.closed` — is this action allowed right now?
- **Role guards**: `(_state, _payload, ctx) => ctx.role === "owner"` — is this caller authorized?
- **Payload guards**: `(state, payload) => state.count + payload.amount <= 100` — is this specific data valid given current state?

### Evaluation Order

```
1. Resolve role → reject if no match (403)
2. Validate payload with Zod → reject if invalid
3. Evaluate guard(state, payload, ctx) → reject if false
4. Run handler
```

## Error Handling

When a message is rejected, the client receives an `__error` JSON message with the reason:

| Step | Failure | Client receives |
|------|---------|----------------|
| Role resolution | No role matches | Connection rejected (403) |
| Zod validation | Payload doesn't match schema | `{ type: "__error", error: "validation_failed", detail: "..." }` |
| Guard | Guard returns false | `{ type: "__error", error: "guard_failed" }` |
| Handler | Handler throws | Error logged server-side; state unchanged |

The actor's state is never modified when a message is rejected.

## Related

- [Side Effects](/concepts/side-effects/) — `emit()` for triggering effects from message handlers
- [Testing](/concepts/testing/) — verify message validation, guards, and handler behavior with `testActor()`
