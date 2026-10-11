---
title: Messages & Guards
description: How messages are validated and how guards work.
---

## Messages

Every message handler is wrapped in the kit's `message()` — pairing a Zod schema with a handler function. The kit comes from `setup()`, which holds what the actor declares up front (events, states, env); an actor with none of them uses `setup({})`.

```typescript
import { setup } from "@actor-kit/worker";
import { z } from "zod";

const todo = setup({});

const addTodo = todo.message(
  z.object({ text: z.string().min(1).max(200) }),
  (state: TodoState, { text }, ctx) => ({
    ...state,
    todos: [...state.todos, { id: ctx.id(), text, done: false }],
  }),
);
```

Annotate the state type once, on the handler's first parameter. The payload is inferred from the schema, and `ctx` (including `env` and a typed `emit`) is typed by the kit.

### Flat Messages

Messages are defined at the top level — not nested by role. Authorization goes in guards:

```typescript
messages: {
  ADD_TODO: addTodo,                          // No guard = open to all roles
  DELETE_TODO: todo.message(z.object({ id: z.string() }), {
    guard: (_state: TodoState, _payload, ctx) => ctx.role === "owner",
    handler: (state: TodoState, { id }) => ({
      ...state,
      todos: state.todos.filter(t => t.id !== id),
    }),
  }),
},
```

### Roles on messages

**A message without `roles` is accepted from every role** (flat top-level messages and state messages
alike: a state message is found by the actor's current state, not by the caller's role). To limit who
may send one, name the roles; any other role is refused with `wrong_role` before the payload is parsed or
the guard runs:

```typescript
DRAW: playing.message(z.object({}), {
  roles: ["player"],                 // a guest or the TV cannot draw
  guard: (s: Shared, _p, ctx) => isTheirTurn(s, ctx.caller),
  handler: (s: Shared, _p, ctx) => draw(s, ctx.caller),
}),
```

Every name in `roles` must be one of the actor's roles: a typo is a definition error
(`invalid_actor_definition`) when the actor is created, in the Worker, `simulate()` and `testActor()`.

### Validation at the Boundary

The Zod schema runs `safeParse` on every incoming payload **before** the handler executes. If validation fails:
- The handler never runs
- The message is refused with code `invalid_payload` (the client receives an `__error` frame; `details` holds the Zod issues)
- State is unchanged

### Handler Signature

```typescript
(state: TState, payload: TPayload, ctx: MessageContext) => TState
```

- **`state`** — current actor state (immutable — return a new object)
- **`payload`** — Zod-validated payload
- **`ctx`** — context with `caller`, `callerType`, `role`, `env`, `execute`, `emit`, `schedule`, `now()`/`id()`/`random()` (and `phase`, `local`, `stay`, `goto` in a state's message)

Handlers are synchronous — they return new state, not a Promise. External I/O goes through `execute()` → services. See [Side Effects](/concepts/side-effects/).

## Guards

Guards are optional conditions on messages. If the guard returns `false`, the message is rejected before the handler runs.

```typescript
const placeBid = auction.message(
  z.object({ amount: z.number().positive() }),
  {
    guard: (state: AuctionState) => !state.closed,
    handler: (state: AuctionState, { amount }, { caller }) => ({
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
1. Resolve role → reject if no match (403 on connect, no_role on send)
2. Find the message for the role (and the current state) → unknown_message or wrong_state if none
   Check the message's roles, if it names any → wrong_role
3. Validate payload with Zod → invalid_payload if invalid
4. Evaluate guard(state, payload, ctx) → guard_failed if false
5. Run handler
```

## Refusals

A rejected message is a refusal: `{ ok: false, code, message, expected?, details?, docs }`. `message` is a full sentence naming the fix, `expected` lists what would have been accepted, `details` carries the specifics, and `docs` links to `https://actorkit.dev/errors/<code>/`. RPC `send()` returns it; over WebSocket the client receives an `__error` frame, `{ type: "__error", messageType, code, message, expected?, details?, docs }`, and `onError` gets those fields.

| Step | Failure | `code` |
|------|---------|--------|
| Role resolution | No role matches | Connection rejected (403); `no_role` on `send()` |
| Message lookup | The role has no message of that name | `unknown_message` (`expected`: the names it can send) |
| Message lookup | Only other states accept it | `wrong_state` (`expected`: those states, `details.phase`: the current one) |
| Message roles | The message names roles, and the caller's is not one | `wrong_role` (`expected`: those roles, `details.role`: the caller's) |
| Zod validation | Payload doesn't match schema | `invalid_payload` (`details`: the Zod issues) |
| Guard | Guard returns false | `guard_failed` |
| Handler | Handler throws | Error logged server-side; state unchanged |

The actor's state is never modified when a message is rejected.

## Related

- [Side Effects](/concepts/side-effects/) — `execute()` and services for triggering effects from message handlers
- [Testing](/concepts/testing/) — verify message validation, guards, and handler behavior with `testActor()`
