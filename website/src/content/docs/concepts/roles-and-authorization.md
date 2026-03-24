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
const addTodo = message(z.object({ text: z.string() }), (state, { text }, { caller }) => ({
  ...state,
  todos: [...state.todos, { text, done: false }],
  memberIds: [...new Set([...state.memberIds, caller])],
}));
```

After adding a todo, the caller's role changes from `viewer` to `member` on the next message.

## callerType

The JWT token carries a `callerType` field — either `"user"` or `"service"`. This is stable identity metadata, not dynamic authorization.

```typescript
roles: {
  service: (_state, _caller, { callerType }) => callerType === "service",
  user: () => true,
},
```

Use `callerType` to distinguish backend services from browser users. Use roles for everything else.

## Per-Role Messages

Each role defines which messages it can send:

```typescript
messages: {
  owner: { ADD_TODO: addTodo, DELETE_TODO: deleteTodo },
  member: { ADD_TODO: addTodo },
  viewer: {},  // read-only
},
```

If a `viewer` sends `DELETE_TODO`, the framework rejects it before the handler runs. Authorization is structural — no if-statements in handlers.

## Per-Role Views

Each role sees a different projection of the state:

```typescript
views: {
  owner: view(OwnerView, (state) => ({ todos: state.todos, settings: state.settings })),
  viewer: view(ViewerView, (state) => ({ todoCount: state.todos.length })),
},
```

The viewer never receives the actual todo items — only the count.
