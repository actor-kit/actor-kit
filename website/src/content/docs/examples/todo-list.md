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
- Actor input: `ownerId` passed via `spawn()` to establish ownership
- `spawn()` for actors with required input (vs auto-spawn for no-input actors)
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

## The Worker

Unlike the counter (which auto-initializes with no input), the todo list requires an `ownerId` at creation time. Use `spawn()` to pass input on first connection:

```typescript
// Route WebSocket connections to the TodoList DO
if (url.pathname.startsWith("/api/todo-list/")) {
  const listId = url.pathname.split("/")[3] ?? "default";
  const id = env.TODO_LIST.idFromName(listId);
  const stub = env.TODO_LIST.get(id);

  // spawn() is idempotent — first call creates with input, subsequent calls are no-ops
  await stub.spawn({
    actorId: listId,
    caller: userId,
    callerType: "user",
    input: { ownerId: userId },
  });

  return stub.fetch(request);
}
```

The `ownerId` from input flows into `init()`, which sets the initial state. Role predicates then use `state.ownerId` to resolve the `owner` role. After the first `spawn()`, the actor persists and restores from SQLite — no re-initialization needed.

## The Client

### Vanilla TypeScript

Use `actorClient(contract)` for typed views and events. Binary delta decoding is handled transparently — the `subscribe` callback always receives the full, merged view:

```typescript
import { actorClient } from "actor-kit/client";
import { TodoListContract } from "./todo";

// Events and views inferred from the contract
const TodoClient = actorClient(TodoListContract);

// Create a runtime connection — Worker stamps identity via withCallerIdentity
const client = TodoClient.create({
  url: `ws://localhost:8787/api/todo-list/my-list?callerId=alice`,
});

// view is typed from the contract's view schemas
client.subscribe((view) => {
  renderTodos(view.todos);
});

client.send({ type: "ADD_TODO", text: "Buy milk" });
```

### React

```tsx
import { useState, useEffect } from "react";
import { actorClient } from "actor-kit/client";
import { actorContext } from "actor-kit/react";
import { TodoListContract } from "./todo";

const TodoClient = actorClient(TodoListContract);
const TodoCtx = actorContext(TodoListContract);

function TodoApp({ listId, callerId }: { listId: string; callerId: string }) {
  const [client, setClient] = useState<ReturnType<typeof TodoClient.create> | null>(null);

  useEffect(() => {
    const c = TodoClient.create({
      url: `wss://${location.host}/api/todo-list/${encodeURIComponent(listId)}?callerId=${encodeURIComponent(callerId)}`,
    });
    setClient(c);
    return () => c.disconnect();
  }, [listId, callerId]);

  if (!client) return null;

  return (
    <TodoCtx.Provider client={client}>
      <TodoList />
    </TodoCtx.Provider>
  );
}

function TodoList() {
  const role = TodoCtx.useRole();
  const send = TodoCtx.useSend();

  // Use useSelector to safely extract what we need based on role
  const todos = TodoCtx.useSelector((view) => {
    if (view && 'todos' in view) return view.todos;
    return [];
  });

  const count = TodoCtx.useSelector((view) => {
    if (view && 'todoCount' in view) return view.todoCount;
    if (view && 'todos' in view) return view.todos.length;
    return 0;
  });

  if (role === "viewer") {
    return <div>{count} todos</div>;
  }

  return (
    <div>
      <ul>
        {todos.map(t => (
          <li key={t.id}>
            <span onClick={() => send({ type: "TOGGLE", id: t.id })}>
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

`useRole()` re-renders when the role changes — if the owner invites someone, their role shifts from `viewer` to `member` and the UI updates automatically. `useSelector()` safely narrows the view shape: viewers get `{ todoCount, doneCount }` while owners/members get `{ todos, memberCount }`, so accessing `view.todos` directly would crash for viewers.

## Try it

```bash
cd examples/todo-list
pnpm install
pnpm dev
# Open http://localhost:8787?user=alice (owner)
# Open http://localhost:8787?user=bob (viewer)
```
