# ADR 004: Role-Based Access Control

**Date**: 2026-03-22
**Status**: Accepted

## Context

Actor Kit v1 used `caller.type` — either `"client"` or `"service"`. This was too coarse. A todo list owner and a todo list viewer are both "clients" but have very different permissions. Authorization logic ended up scattered across individual message handlers.

## Decision

Replace `caller.type` with role-based access. Roles are derived from state, not from JWT claims.

### Design

```typescript
roles: {
  owner: (state, caller) => caller === state.ownerId,
  member: (state, caller) => state.memberIds.includes(caller),
  viewer: () => true,
},
```

- **First match wins**: roles are evaluated top-to-bottom. Order matters.
- **No match = 403**: if no role predicate returns true, the connection is rejected.
- **Re-evaluated on every message**: a state change can change a caller's role.
- **Caller is a string**: just the identity from JWT `sub` claim. No `{ type, id }` object.

### Messages scoped per role

```typescript
messages: {
  owner: { DELETE_TODO: handler },
  member: { ADD_TODO: handler, TOGGLE: handler },
  viewer: {},  // read-only
},
```

The framework validates the message type against the caller's role BEFORE the handler runs. If "viewer" sends "DELETE_TODO", it's rejected without executing any handler code.

### Views scoped per role

```typescript
views: {
  owner: view.shared(OwnerView, ownerProjection),
  member: view.shared(MemberView, memberProjection),
  viewer: view.shared(ViewerView, viewerProjection),
},
```

Each role sees a different projection of the state. The framework adds a `role` discriminant to the view, creating a discriminated union on the client.

### Sharing message handlers across roles

No framework concept for inheritance. Use JavaScript:

```typescript
const addTodo = (state, { text }) => produce(state, d => { ... });
const memberMessages = { ADD_TODO: addTodo, TOGGLE: toggleTodo };

messages: {
  owner: { ...memberMessages, DELETE_TODO: deleteTodo },
  member: memberMessages,
  viewer: {},
},
```

## Consequences

- Authorization is structural and declarative. No `if (caller.type !== "service") return` guards in handlers.
- Role predicates have access to full state, enabling dynamic authorization (e.g., owner changes based on state).
- First-match-wins requires careful ordering — catch-all roles must be last.
- The `role` discriminant on views enables exhaustive pattern matching on the client (TypeScript narrows the union).
- Roles are not stored anywhere — they're computed on every evaluation. This means no stale role cache, but also means role evaluation runs on every message.
