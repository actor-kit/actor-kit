---
title: Quick Start
description: Build a real-time todo list app with Actor Kit in 8 steps.
---

This guide walks you through building a todo list with real-time sync using Actor Kit and Cloudflare Workers. No state management library required — just plain reducers. We'll use Hono for routing and React for the frontend, but the server-side setup is framework-agnostic.

## 1. Install packages

```bash
pnpm add @actor-kit/core @actor-kit/browser @actor-kit/react @actor-kit/server hono zod
```

## 2. Define your actor logic

Use `defineLogic` to describe your state, transitions, and caller-scoped view — all with plain functions:

```typescript
// src/todo.logic.ts
import { defineLogic, type BaseEnv, type Caller } from "@actor-kit/core";

// --- State (server-side, never sent to clients directly) ---

type TodoState = {
  ownerId: string;
  todos: Array<{ id: string; text: string; completed: boolean }>;
  lastSync: number | null;
};

// --- Events ---

export type TodoEvent =
  | { type: "ADD_TODO"; text: string }
  | { type: "TOGGLE_TODO"; id: string }
  | { type: "DELETE_TODO"; id: string }
  | { type: "SYNC_TODOS"; todos: Array<{ id: string; text: string; completed: boolean }> };

// --- View (what clients receive over the wire) ---

export type TodoView = {
  ownerId: string;
  todos: Array<{ id: string; text: string; completed: boolean }>;
  lastSync: number | null;
  isOwner: boolean;
};

// --- Env ---

export interface Env extends BaseEnv {
  TODO: DurableObjectNamespace;
}

// --- Logic ---

export const todoLogic = defineLogic<TodoState, TodoEvent, TodoView, Env>({
  create: (_input, ctx) => ({
    ownerId: ctx.caller.id,
    todos: [],
    lastSync: null,
  }),

  transition: (state, event) => {
    switch (event.type) {
      case "ADD_TODO":
        // Only the owner can add todos
        if (event.caller.id !== state.ownerId) return state;
        return {
          ...state,
          todos: [
            ...state.todos,
            { id: crypto.randomUUID(), text: event.text, completed: false },
          ],
          lastSync: Date.now(),
        };

      case "TOGGLE_TODO":
        if (event.caller.id !== state.ownerId) return state;
        return {
          ...state,
          todos: state.todos.map((t) =>
            t.id === event.id ? { ...t, completed: !t.completed } : t
          ),
          lastSync: Date.now(),
        };

      case "DELETE_TODO":
        if (event.caller.id !== state.ownerId) return state;
        return {
          ...state,
          todos: state.todos.filter((t) => t.id !== event.id),
          lastSync: Date.now(),
        };

      case "SYNC_TODOS":
        // Only service callers can bulk-sync
        if (event.caller.type !== "service") return state;
        return {
          ...state,
          todos: event.todos,
          lastSync: Date.now(),
        };

      default:
        return state;
    }
  },

  getView: (state, caller) => ({
    ownerId: state.ownerId,
    todos: state.todos,
    lastSync: state.lastSync,
    isOwner: caller.id === state.ownerId,
  }),
});
```

Every event arrives with `event.caller` attached by the framework — use it for authorization directly in your transition function. The `getView` function produces a caller-scoped projection: different callers can see different things.

## 3. Wire into a Durable Object

Use `createDurableActor` to turn your logic into a Cloudflare Durable Object class. Zod schemas validate events at the runtime boundary:

```typescript
// src/todo.server.ts
import { createDurableActor } from "@actor-kit/core";
import { z } from "zod";
import { todoLogic } from "./todo.logic";

export const Todo = createDurableActor({
  logic: todoLogic,
  events: {
    client: z.discriminatedUnion("type", [
      z.object({ type: z.literal("ADD_TODO"), text: z.string() }),
      z.object({ type: z.literal("TOGGLE_TODO"), id: z.string() }),
      z.object({ type: z.literal("DELETE_TODO"), id: z.string() }),
    ]),
    service: z.discriminatedUnion("type", [
      z.object({
        type: z.literal("SYNC_TODOS"),
        todos: z.array(
          z.object({ id: z.string(), text: z.string(), completed: z.boolean() })
        ),
      }),
    ]),
  },
  input: z.object({}),
  persisted: true,
});

export default Todo;
```

## 4. Configure Wrangler

Register the Durable Object binding in `wrangler.toml`:

```toml
name = "todo-app"
main = "src/server.ts"
compatibility_date = "2024-01-01"

[durable_objects]
bindings = [
  { name = "TODO", class_name = "Todo" }
]

[[migrations]]
tag = "v1"
new_classes = ["Todo"]
```

## 5. Add Hono routes

Use Hono to handle HTTP and WebSocket requests. The Durable Object handles WebSocket lifecycle internally — your routes just forward requests:

```typescript
// src/server.ts
import { Hono } from "hono";
import { createAccessToken, getCallerFromRequest } from "@actor-kit/core";
import type { Caller } from "@actor-kit/core";
import type { Env, TodoView } from "./todo.logic";

export { Todo } from "./todo.server";

type TodoStub = {
  spawn(props: {
    actorType: string;
    actorId: string;
    caller: Caller;
    input: Record<string, unknown>;
  }): Promise<void>;
  send(event: { type: string; caller: Caller; [key: string]: unknown }): void;
  getSnapshot(caller: Caller): Promise<{ checksum: string; snapshot: TodoView }>;
  fetch(request: Request): Promise<Response>;
};

function getStub(env: Env, id: string): TodoStub {
  return env.TODO.get(env.TODO.idFromName(id)) as unknown as TodoStub;
}

const app = new Hono<{ Bindings: Env }>();

// Auth middleware — validates JWT on protected routes
app.use("/api/todo/:id/*", async (c, next) => {
  const id = c.req.param("id");
  try {
    const caller = await getCallerFromRequest(
      c.req.raw, "todo", id, c.env.ACTOR_KIT_SECRET
    );
    c.set("caller" as never, caller as never);
    await next();
  } catch {
    return c.json({ error: "Unauthorized" }, 401);
  }
});

// POST /api/token — issue a JWT for a caller
app.post("/api/token", async (c) => {
  const body = await c.req.json<{
    actorId: string;
    callerId: string;
    callerType: "client" | "service";
  }>();
  const token = await createAccessToken({
    signingKey: c.env.ACTOR_KIT_SECRET,
    actorId: body.actorId,
    actorType: "todo",
    callerId: body.callerId,
    callerType: body.callerType,
  });
  return c.json({ token });
});

// GET /api/todo/:id — get caller-scoped snapshot
app.get("/api/todo/:id", async (c) => {
  const id = c.req.param("id");
  const caller = c.get("caller" as never) as Caller;
  const stub = getStub(c.env, id);
  await stub.spawn({ actorType: "todo", actorId: id, caller, input: {} });
  return c.json(await stub.getSnapshot(caller));
});

// POST /api/todo/:id — send an event
app.post("/api/todo/:id", async (c) => {
  const id = c.req.param("id");
  const caller = c.get("caller" as never) as Caller;
  const event = await c.req.json();
  const stub = getStub(c.env, id);
  await stub.spawn({ actorType: "todo", actorId: id, caller, input: {} });
  stub.send({ ...event, caller });
  return c.json(await stub.getSnapshot(caller));
});

// GET /api/todo/:id/ws — WebSocket upgrade for real-time sync
app.get("/api/todo/:id/ws", async (c) => {
  const id = c.req.param("id");
  const caller = c.get("caller" as never) as Caller;

  if (c.req.header("Upgrade") !== "websocket") {
    return c.json({ error: "Expected WebSocket upgrade" }, 426);
  }

  const stub = getStub(c.env, id);
  await stub.spawn({ actorType: "todo", actorId: id, caller, input: {} });

  // Forward the upgrade to the DO — it handles the WebSocket lifecycle
  return stub.fetch(c.req.raw);
});

export default app;
```

## 6. Create the React context

`createActorKitContext` creates a Provider and hooks typed to your view and event types:

```tsx
// src/todo.context.tsx
"use client";

import { createActorKitContext } from "@actor-kit/react";
import type { TodoView, TodoEvent } from "./todo.logic";

export const TodoActorKit = createActorKitContext<TodoView, TodoEvent>("todo");
```

## 7. Fetch data server-side

Load the initial snapshot on the server and pass it to the provider. This example uses TanStack Start, but the pattern works with any SSR framework:

```typescript
// src/routes/lists.$listId.tsx
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { createAccessToken } from "@actor-kit/server";
import { TodoActorKit } from "../todo.context";
import { TodoList } from "../components/TodoList";

const loadTodo = createServerFn({ method: "GET" })
  .handler(async ({ data }) => {
    const host = process.env.ACTOR_KIT_HOST!;
    const signingKey = process.env.ACTOR_KIT_SECRET!;
    const callerId = "demo-user";

    const accessToken = await createAccessToken({
      signingKey,
      actorId: data.listId,
      actorType: "todo",
      callerId,
      callerType: "client",
    });

    // Fetch the initial snapshot over HTTP
    const protocol = host.startsWith("localhost") ? "http" : "https";
    const res = await fetch(
      `${protocol}://${host}/api/todo/${data.listId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const payload = await res.json();

    return { accessToken, host, listId: data.listId, payload, userId: callerId };
  });

export const Route = createFileRoute("/lists/$listId")({
  loader: ({ params }) => loadTodo({ data: { listId: params.listId } }),
  component: TodoRouteComponent,
});

function TodoRouteComponent() {
  const { accessToken, host, listId, payload, userId } = Route.useLoaderData();

  return (
    <TodoActorKit.Provider
      host={host}
      actorId={listId}
      accessToken={accessToken}
      checksum={payload.checksum}
      initialSnapshot={payload.snapshot}
    >
      <TodoList userId={userId} />
    </TodoActorKit.Provider>
  );
}
```

## 8. Create a client component

Use the context hooks to read state and send events:

```tsx
// src/components/TodoList.tsx
"use client";

import { useState } from "react";
import { TodoActorKit } from "../todo.context";

export function TodoList({ userId }: { userId: string }) {
  const todos = TodoActorKit.useSelector((state) => state.todos);
  const isOwner = TodoActorKit.useSelector((state) => state.isOwner);
  const send = TodoActorKit.useSend();
  const [newTodoText, setNewTodoText] = useState("");

  const handleAddTodo = (e: React.FormEvent) => {
    e.preventDefault();
    if (newTodoText.trim()) {
      send({ type: "ADD_TODO", text: newTodoText.trim() });
      setNewTodoText("");
    }
  };

  return (
    <div>
      <h1>Todo List</h1>
      {isOwner && (
        <form onSubmit={handleAddTodo}>
          <input
            type="text"
            value={newTodoText}
            onChange={(e) => setNewTodoText(e.target.value)}
            placeholder="Add a new todo"
          />
          <button type="submit">Add</button>
        </form>
      )}
      <ul>
        {todos.map((todo) => (
          <li key={todo.id}>
            <span style={{ textDecoration: todo.completed ? "line-through" : "none" }}>
              {todo.text}
            </span>
            {isOwner && (
              <>
                <button onClick={() => send({ type: "TOGGLE_TODO", id: todo.id })}>
                  {todo.completed ? "Undo" : "Complete"}
                </button>
                <button onClick={() => send({ type: "DELETE_TODO", id: todo.id })}>
                  Delete
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

## What's happening

1. **Logic** defines state transitions as a pure reducer and a caller-scoped view function (`defineLogic`)
2. **Durable Object** wraps the logic with persistence, WebSocket support, and Zod validation at the boundary (`createDurableActor`)
3. **Hono routes** handle HTTP snapshots, event posting, WebSocket upgrades, and token issuance
4. **Provider** connects the React tree to the actor via WebSocket with JSON Patch sync
5. **Hooks** give components reactive access to the caller-scoped view

Authorization happens inside the transition function via `event.caller` — no middleware needed. Each client receives its own view from `getView`, so you can show different data to different users from the same actor state.

## Next steps

- [How It Works](/concepts/how-it-works/) — understand the data flow in detail
- [Public/Private Context](/concepts/public-private-context/) — learn about data isolation
- [Testing Guide](/guides/testing/) — test your actors without a live server
