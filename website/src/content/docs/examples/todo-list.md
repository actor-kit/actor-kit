---
title: Todo List
description: Multiple roles, guards, and flat messages.
---

The todo list demonstrates the role system in depth — different users see different views and have different permissions, all enforced through guards on flat messages.

**Source**: [`examples/todo-list/`](https://github.com/actor-kit/actor-kit/tree/main/examples/todo-list)

## What it demonstrates

- Three roles: `owner`, `member`, `viewer`
- Flat messages with guards for role-based authorization
- Per-role views: owner/member see todos, viewer sees counts
- State persistence across page reloads
- Contract-derived client: no manual event unions
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

## Flat Messages with Guards

```typescript
messages: {
  ADD_TODO: message(
    z.object({ text: z.string().min(1).max(200) }),
    {
      guard: (_state, _payload, ctx) => ctx.role === "owner" || ctx.role === "member",
      handler: (state, { text }) => ({
        ...state,
        todos: [...state.todos, { id: crypto.randomUUID(), text, done: false }],
      }),
    },
  ),
  DELETE_TODO: message(
    z.object({ id: z.string() }),
    {
      guard: (_state, _payload, ctx) => ctx.role === "owner",
      handler: (state, { id }) => ({
        ...state,
        todos: state.todos.filter((t) => t.id !== id),
      }),
    },
  ),
  TOGGLE: message(
    z.object({ id: z.string() }),
    {
      guard: (_state, _payload, ctx) => ctx.role === "owner" || ctx.role === "member",
      handler: (state, { id }) => ({
        ...state,
        todos: state.todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t)),
      }),
    },
  ),
  INVITE: message(
    z.object({ userId: z.string() }),
    {
      guard: (_state, _payload, ctx) => ctx.role === "owner",
      handler: (state, { userId }) => ({
        ...state,
        memberIds: [...state.memberIds, userId],
      }),
    },
  ),
},
```

Messages are flat — all defined at the top level. Guards check `ctx.role` to enforce authorization. A viewer sending `DELETE_TODO` gets a `guard_failed` error without the handler running.

## Per-Role Views

```typescript
views: {
  owner: view(OwnerViewSchema, (state) => ({
    todos: state.todos,
    memberCount: state.memberIds.length,
  })),
  member: view(OwnerViewSchema, (state) => ({
    todos: state.todos,
    memberCount: state.memberIds.length,
  })),
  viewer: view(ViewerViewSchema, (state) => ({
    todoCount: state.todos.length,
    doneCount: state.todos.filter(t => t.done).length,
  })),
},
```

The owner and member see the full todo list. The viewer sees only counts — the individual todo items are never sent.

## The Client

### Vanilla TypeScript

Use `actorClient(contract)` for typed views and events. Binary delta decoding is handled transparently — the `subscribe` callback always receives the full, merged view:

```typescript
import { actorClient } from "actor-kit/client";
import { TodoListContract } from "./todo";

// Events and views inferred from the contract
const TodoClient = actorClient(TodoListContract);

// Get a token
const { token } = await fetch("/api/token?actorId=my-list").then(r => r.json());

// Create a runtime connection
const client = TodoClient.create({
  url: `ws://localhost:8787/api/todo-list/my-list`,
  accessToken: token,
});

// view is typed from the contract's view schemas
client.subscribe((view) => {
  renderTodos(view.todos);
});

client.send({ type: "ADD_TODO", text: "Buy milk" });
```

### React

```tsx
import { actorClient } from "actor-kit/client";
import { actorContext } from "actor-kit/react";
import { TodoListContract } from "./todo";

const TodoClient = actorClient(TodoListContract);
const TodoCtx = actorContext(TodoListContract);

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
  const view = TodoCtx.useView();   // typed from contract view schemas
  const role = TodoCtx.useRole();
  const send = TodoCtx.useSend();   // event types inferred from contract

  if (!view) return <div>Loading...</div>;

  return (
    <div>
      <ul>
        {view.todos.map(t => (
          <li key={t.id}>
            <span onClick={() => send({ type: "TOGGLE", id: t.id })}>
              {t.done ? "done" : "todo"} {t.text}
            </span>
          </li>
        ))}
      </ul>
      {role !== "viewer" && (
        <button onClick={() => send({ type: "ADD_TODO", text: "New item" })}>
          Add
        </button>
      )}
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
