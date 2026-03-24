---
title: Todo List
description: Multiple roles, guards, and shared message handlers.
---

The todo list demonstrates the role system in depth — different users see different views and have different permissions.

**Source**: [`examples/todo-list/`](https://github.com/actor-kit/actor-kit/tree/main/examples/todo-list)

## What it demonstrates

- Three roles: `owner`, `member`, `viewer`
- Role-specific messages: owner can delete, members can add/toggle, viewers are read-only
- Shared message handlers across roles
- Per-role views: owner/member see todos, viewer sees counts
- State persistence across page reloads

## Roles

```typescript
roles: {
  owner: (state, caller) => caller === state.ownerId,
  member: (state, caller) => state.memberIds.includes(caller),
  viewer: () => true,  // catch-all
},
```

Roles evaluate top-to-bottom. First match wins. If the caller is the owner, they get `owner` — even if they're also in `memberIds`.

## Shared Handlers

```typescript
const addTodo = message(
  z.object({ text: z.string().min(1).max(200) }),
  (state, { text }) => ({
    ...state,
    todos: [...state.todos, { id: crypto.randomUUID(), text, done: false }],
  }),
);

messages: {
  owner: { ADD_TODO: addTodo, TOGGLE: toggleTodo, DELETE_TODO: deleteTodo, INVITE: invite },
  member: { ADD_TODO: addTodo, TOGGLE: toggleTodo },
  viewer: {},
},
```

`addTodo` is the same `message()` object in both `owner` and `member`. No duplication.

## Per-Role Views

```typescript
views: {
  owner: view(OwnerViewSchema, (state) => ({
    todos: state.todos,
    memberCount: state.memberIds.length,
  })),
  viewer: view(ViewerViewSchema, (state) => ({
    todoCount: state.todos.length,
    doneCount: state.todos.filter(t => t.done).length,
  })),
},
```

The owner sees the full todo list. The viewer sees only counts — the individual todo items are never sent.

## Try it

```bash
cd examples/todo-list
pnpm install
pnpm dev
# Open http://localhost:8787?user=alice (owner)
# Open http://localhost:8787?user=bob (viewer)
```
