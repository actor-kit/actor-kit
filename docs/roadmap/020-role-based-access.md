# 020: Role-Based Access Control

**Priority**: P0
**Status**: Proposal
**Supersedes**: Caller type system (`client` | `service`), `public`/`private` context

## Problem

Actor Kit currently has two hardcoded access levels:

1. **Caller type** (`client` | `service`) — set at JWT creation, determines which event schema validates
2. **`getView(state, caller)`** — returns one `TView` type for all callers

This is too rigid:
- Can't express "only the owner can delete" at the schema level
- Can't return different view shapes to different callers with type safety
- The `client`/`service` distinction is a primitive role system that doesn't scale
- Authorization logic ends up duplicated in transitions instead of declared once

## Proposed Design

Replace `caller.type` and the single `getView` with a **role-based system** where roles are derived from state, and both event schemas and views are scoped per role.

### Core API

```typescript
const todoLogic = defineLogic({
  create: (input) => ({
    todos: [],
    ownerId: input.ownerId,
    memberIds: [],
  }),

  // Roles are evaluated top-to-bottom. First match wins.
  // Derived from state — the actor decides who has what role.
  roles: {
    owner: (state, caller) => caller === state.ownerId,
    member: (state, caller) => state.memberIds.includes(caller),
    guest: () => true,
  },

  // Event schemas per role — validated BEFORE reaching transition.
  // A role can only send events defined in its schema.
  events: {
    owner: z.discriminatedUnion("type", [
      z.object({ type: z.literal("ADD_TODO"), text: z.string() }),
      z.object({ type: z.literal("DELETE_TODO"), id: z.string() }),
      z.object({ type: z.literal("ADD_MEMBER"), userId: z.string() }),
      z.object({ type: z.literal("DELETE_LIST") }),
    ]),
    member: z.discriminatedUnion("type", [
      z.object({ type: z.literal("ADD_TODO"), text: z.string() }),
      z.object({ type: z.literal("TOGGLE_TODO"), id: z.string() }),
    ]),
    guest: z.discriminatedUnion("type", [
      // empty — guests are read-only
    ]),
  },

  // Views per role — return type inferred, role discriminant injected.
  // TypeScript enforces every role has a view.
  views: {
    owner: (state) => ({
      todos: state.todos,
      memberIds: state.memberIds,
      canDelete: true as const,
    }),
    member: (state) => ({
      todos: state.todos,
    }),
    guest: (state) => ({
      todoCount: state.todos.length,
    }),
  },

  // Transition receives event with caller (string) and role (inferred).
  // Authorization is already enforced — only valid events reach here.
  transition: (state, event) =>
    produce(state, (draft) => {
      switch (event.type) {
        case "ADD_TODO":
          draft.todos.push({ id: crypto.randomUUID(), text: event.text, done: false });
          break;
        case "DELETE_TODO":
          draft.todos = draft.todos.filter((t) => t.id !== event.id);
          break;
        case "ADD_MEMBER":
          draft.memberIds.push(event.userId);
          break;
      }
    }),
});
```

### Caller is a string

`Caller` simplifies from `{ type: "client" | "service"; id: string }` to just a string — the caller's identity. The JWT carries `sub: "user-123"` and the actor determines the role from its own state.

```typescript
// JWT: { sub: "user-123", jti: "todo-456", aud: "todo" }
// caller = "user-123"
// role = computed from state
```

### Event augmentation

When a message arrives, the framework:

1. Extracts `caller` (string) from JWT
2. Evaluates roles top-to-bottom against current state → determines role
3. Validates event against that role's Zod schema
4. Augments event: `{ ...event, caller: "user-123", role: "owner", env }`
5. Calls `transition(state, augmentedEvent)`

The transition function receives:
```typescript
event.type    // "ADD_TODO"
event.caller  // "user-123"
event.role    // "owner" — computed by framework, typed as keyof roles
event.env     // Worker env bindings
```

### View inference

`TView` is automatically inferred as a discriminated union from the `views` config:

```typescript
// Inferred from the config above:
type TodoView =
  | { role: "owner"; todos: Todo[]; memberIds: string[]; canDelete: true }
  | { role: "member"; todos: Todo[] }
  | { role: "guest"; todoCount: number };
```

The `role` field is injected by the framework — the user's view functions don't return it. TypeScript builds the union from `{ role: K } & ReturnType<TViews[K]>` for each key K.

### Type enforcement

TypeScript enforces at compile time:
- Every role must have an event schema
- Every role must have a view function
- `event.role` is typed as `keyof TRoles`
- `TView` is a discriminated union — clients narrow on `role`
- Events that only certain roles can send don't appear in other roles' types

```typescript
// Compile errors:
defineLogic({
  roles: { owner: ..., guest: ... },
  events: { owner: ... },           // ✗ missing 'guest' events
  views: { owner: ..., admin: ... }, // ✗ 'admin' not in roles
});
```

### Client-side usage

```typescript
// The client receives the inferred union
const view = useSelector((s) => s);

if (view.role === "owner") {
  view.memberIds; // ✓ TypeScript knows this exists
  view.canDelete; // ✓ true
}

if (view.role === "guest") {
  view.todoCount; // ✓
  view.todos;     // ✗ compile error — guests don't see todos
}
```

### Access data lives on state

Roles evaluate against state. Authorization data (who's an owner, who's a member) is part of the actor's state, updated via events:

```typescript
case "ADD_MEMBER":
  draft.memberIds.push(event.userId);
  break;
case "REMOVE_MEMBER":
  draft.memberIds = draft.memberIds.filter(id => id !== event.userId);
  break;
```

External systems (auth service, admin panel) send events to update access. The actor is the source of truth for its own authorization.

### JWT simplification

Current JWT claims:
```
jti: actorId, aud: actorType, sub: "client-user123"
```

New JWT claims:
```
jti: actorId, aud: actorType, sub: "user123"
```

No more `callerType-callerId` encoding. Just the identity.

## Migration from current design

| Before | After |
|--------|-------|
| `caller: { type: "client", id: "user-1" }` | `caller: "user-1"` |
| `events: { client: Schema, service: Schema }` | `events: { owner: Schema, member: Schema, ... }` |
| `getView(state, caller) => TView` | `views: { owner: fn, member: fn, ... }` — inferred |
| `caller.type !== "service"` checks in transition | Removed — schema validation handles it |
| `CallerSnapshotFrom<TMachine>` | Inferred `TView` union |

## Type signature

```typescript
function defineLogic<
  TState,
  TRoles extends Record<string, (state: TState, caller: string) => boolean>,
  TEvents extends { [K in keyof TRoles]: z.ZodSchema },
  TViews extends { [K in keyof TRoles]: (state: TState) => unknown },
  TInput = Record<string, unknown>,
>(config: {
  create: (input: TInput, ctx: { id: string; caller: string; env: BaseEnv }) => TState;
  roles: TRoles;
  events: TEvents;
  views: TViews;
  transition: (
    state: TState,
    event: z.infer<TEvents[keyof TEvents]> & {
      caller: string;
      role: keyof TRoles;
      env: BaseEnv;
    }
  ) => TState;
  // ...
}): ActorLogic<
  TState,
  z.infer<TEvents[keyof TEvents]>,
  { [K in keyof TRoles]: { role: K } & ReturnType<TViews[K]> }[keyof TRoles],
  BaseEnv,
  TInput
>;
```

## Resolved Design Decisions

1. **Role evaluation order** — First match wins, top-to-bottom. Same pattern as route matching. Most specific roles first, catch-all last. Document clearly, trust the user.

2. **No role match = rejection** — If no role matches a caller, the connection is rejected (403). No required catch-all — if you want public access, add an `anonymous: () => true` role as the last entry.

3. **Role changes during a session** — Roles re-evaluate on every event and view computation. If a caller gets promoted mid-session (e.g., `ADD_MEMBER` event changes state), their next event validates against the new role's schema and they receive the new role's view. WebSocket stays open.

4. **Empty event schemas** — `z.discriminatedUnion("type", [])` works and rejects all events. Read-only roles use this pattern. No need for `z.never()`.

5. **Adapter compatibility** — XState adapter wraps the machine in the role system. The adapter's `events` config maps roles to subsets of the machine's event union. The machine itself doesn't know about roles — it receives all valid events. Role-based validation happens in the DO layer before events reach the adapter.

6. **Caller is a plain string** — `caller: string` (just the identity from JWT `sub` claim). No `type` field. Role handles all authorization.

## Test Plan

1. **Role evaluation** — correct role assigned for each caller based on state
2. **Event validation** — events rejected if not in caller's role schema
3. **View scoping** — each role gets the correct view shape
4. **Role changes** — caller promoted/demoted sees updated view
5. **Type inference** — compile-time errors for mismatched roles/events/views
6. **Empty events** — read-only roles can connect but not send
7. **First-match semantics** — owner matched before member before guest
