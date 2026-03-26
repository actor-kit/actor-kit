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
- Client role detection: adapting UI based on `role` from the server

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

## The Client

The example uses raw WebSocket. Each snapshot includes the caller's `role`, so the UI adapts:

```javascript
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === "snapshot") {
    const { role, data } = msg;

    if (role === "owner" || role === "member") {
      // Show full todo list
      renderTodos(data.todos);
    } else {
      // Viewer — show counts only (individual todos are never sent)
      renderSummary(data.todoCount, data.doneCount);
    }
  }
});

// Send a message
ws.send(JSON.stringify({ type: "ADD_TODO", text: "Buy milk" }));
```

### With React

```tsx
import { actorClient } from "actor-kit/client";
import { actorContext } from "actor-kit/react";

// Use the owner schema — viewers will receive JSON fallback snapshots
// since their view shape differs from the binary schema
const TodoClient = actorClient(OwnerViewSchema).events<TodoEvent>();
const TodoCtx = actorContext<typeof TodoClient>();

function TodoApp({ listId, token }: { listId: string; token: string }) {
  const client = TodoClient.create({
    url: `wss://${location.host}/api/todo-list/${encodeURIComponent(listId)}`,
    accessToken: token,
  });

  return (
    <TodoCtx.Provider client={client}>
      <TodoList />
    </TodoCtx.Provider>
  );
}

function TodoList() {
  const view = TodoCtx.useView();   // typed from OwnerViewSchema
  const role = TodoCtx.useRole();
  const send = TodoCtx.useSend();   // (event: TodoEvent) => void

  if (!view) return <div>Loading...</div>;

  return (
    <div>
      <ul>
        {view.todos.map(t => (
          <li key={t.id}>
            <span onClick={() => send({ type: "TOGGLE", todoId: t.id })}>
              {t.done ? "done" : "todo"} {t.text}
            </span>
          </li>
        ))}
      </ul>
      <button onClick={() => send({ type: "ADD_TODO", text: "New item" })}>
        Add
      </button>
    </div>
  );
}
```

`useRole()` re-renders when the role changes — if the owner invites someone, their role shifts from `viewer` to `member` and the UI updates automatically.

## Try it

```bash
cd examples/todo-list
pnpm install
pnpm dev
# Open http://localhost:8787?user=alice (owner)
# Open http://localhost:8787?user=bob (viewer)
```
