---
title: Roles & Authorization
description: How roles work and how authorization is enforced.
---

## Roles Are Derived from State

Roles are not stored in tokens or databases. They're computed from the current state every time a message arrives.

```typescript
roles: {
  owner: (state, caller) => caller === state.ownerId,
  member: (state, caller) => state.memberIds.includes(caller),
  viewer: () => true,
},
```

### First Match Wins

Roles evaluate top-to-bottom. The first predicate that returns `true` determines the caller's role.

If a caller is both the owner AND a member, they get `owner` — because it's listed first.

### No Match = Rejection

If no role predicate returns `true`, the connection is rejected with a 403. Every actor should have a catch-all role (like `viewer: () => true`) or explicitly reject unknown callers.

### Re-Evaluated on Every Message

Roles are not cached. When the state changes, a caller's role can change too. This enables dynamic authorization:

```typescript
// A todo list where anyone who adds a todo becomes a member
ADD_TODO: message(z.object({ text: z.string() }), {
  guard: (_state, _payload, ctx) => ctx.role === "owner" || ctx.role === "member",
  handler: (state, { text }, { caller }) => ({
    ...state,
    todos: [...state.todos, { text, done: false }],
    memberIds: [...new Set([...state.memberIds, caller])],
  }),
}),
```

After adding a todo, the caller's role changes from `viewer` to `member` on the next message.

## callerType

The caller identity includes a `callerType` field — either `"user"` or `"service"`. This is stable identity metadata set by the Worker via `withCallerIdentity()`, not dynamic authorization.

```typescript
roles: {
  service: (_state, _caller, { callerType }) => callerType === "service",
  user: () => true,
},
```

Use `callerType` to distinguish backend services from browser users. Use roles for everything else.

## Flat Messages with Guards

Messages are flat — not nested by role. Authorization is enforced through guards:

```typescript
messages: {
  ADD_TODO: message(z.object({ text: z.string() }), {
    guard: (_state, _payload, ctx) => ctx.role === "owner" || ctx.role === "member",
    handler: (state, { text }) => ({ ...state, todos: [...state.todos, { text, done: false }] }),
  }),
  DELETE_TODO: message(z.object({ id: z.string() }), {
    guard: (_state, _payload, ctx) => ctx.role === "owner",
    handler: (state, { id }) => ({ ...state, todos: state.todos.filter(t => t.id !== id) }),
  }),
  // No guard = open to all roles
  VIEW_COUNT: message(z.object({}), (state) => state),
},
```

If a `viewer` sends `DELETE_TODO`, the guard returns `false` and the framework rejects with `guard_failed` — the handler never runs. Messages without guards are open to all roles.

## Per-Role Views

Each role sees a different projection of the state:

```typescript
views: {
  owner: view(OwnerView, (state) => ({ todos: state.todos, settings: state.settings })),
  viewer: view(ViewerView, (state) => ({ todoCount: state.todos.length })),
},
```

The viewer never receives the actual todo items — only the count.

## Related

- [Messages & Guards](/concepts/messages-and-guards/) — how messages are validated and guarded
- [FAQ](/faq/) — common questions about role resolution and authorization
