---
title: Quick Start
description: Build a real-time todo list app with Actor Kit in 8 steps.
---

This guide walks you through building a todo list with real-time sync using Actor Kit, XState, and Cloudflare Workers. We'll use TanStack Start for the frontend, but the server-side setup is framework-agnostic.

## 1. Define event schemas

First, define the Zod schemas that validate events at runtime boundaries:

```typescript
// src/todo.schemas.ts
import { z } from "zod";

export const TodoClientEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ADD_TODO"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("TOGGLE_TODO"),
    id: z.string(),
  }),
  z.object({
    type: z.literal("DELETE_TODO"),
    id: z.string(),
  }),
]);

export const TodoServiceEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("SYNC_TODOS"),
    todos: z.array(
      z.object({ id: z.string(), text: z.string(), completed: z.boolean() })
    ),
  }),
]);

export const TodoInputPropsSchema = z.object({
  accessCount: z.number(),
});
```

## 2. Define types

Derive TypeScript types from your schemas and define your context shape:

```typescript
// src/todo.types.ts
import type {
  ActorKitSystemEvent,
  WithActorKitEvent,
  WithActorKitInput,
} from "@actor-kit/types";
import { z } from "zod";
import {
  TodoClientEventSchema,
  TodoInputPropsSchema,
  TodoServiceEventSchema,
} from "./todo.schemas";

export type TodoClientEvent = z.infer<typeof TodoClientEventSchema>;
export type TodoServiceEvent = z.infer<typeof TodoServiceEventSchema>;
export type TodoInputProps = z.infer<typeof TodoInputPropsSchema>;
export type TodoInput = WithActorKitInput<TodoInputProps>;

// Union of all event types the machine can receive
export type TodoEvent =
  | WithActorKitEvent<TodoClientEvent, "client">
  | WithActorKitEvent<TodoServiceEvent, "service">
  | ActorKitSystemEvent;

// Public context: shared with all connected clients
export type TodoPublicContext = {
  ownerId: string;
  todos: Array<{ id: string; text: string; completed: boolean }>;
  lastSync: number | null;
};

// Private context: per-caller, only visible to that caller
export type TodoPrivateContext = {
  accessCount: number;
};

// Full server context shape
export type TodoServerContext = {
  public: TodoPublicContext;
  private: Record<string, TodoPrivateContext>;
};
```

## 3. Define the state machine

Create your XState v5 machine with the types from step 2:

```typescript
// src/todo.machine.ts
import { ActorKitStateMachine } from "@actor-kit/types";
import { assign, setup } from "xstate";
import type {
  TodoEvent,
  TodoInput,
  TodoPrivateContext,
  TodoPublicContext,
  TodoServerContext,
} from "./todo.types";

export const todoMachine = setup({
  types: {
    context: {} as TodoServerContext,
    events: {} as TodoEvent,
    input: {} as TodoInput,
  },
  actions: {
    addTodo: assign({
      public: ({ context, event }) => {
        if (event.type !== "ADD_TODO") return context.public;
        return {
          ...context.public,
          todos: [
            ...context.public.todos,
            { id: crypto.randomUUID(), text: event.text, completed: false },
          ],
          lastSync: Date.now(),
        };
      },
    }),
  },
}).createMachine({
  id: "todoList",
  initial: "ready",
  context: ({ input }) => ({
    public: {
      ownerId: input.caller.id,
      todos: [],
      lastSync: null,
    },
    private: {},
  }),
  states: {
    ready: {
      on: {
        ADD_TODO: { actions: "addTodo" },
        // ... other transitions
      },
    },
  },
}) satisfies ActorKitStateMachine<
  TodoEvent,
  TodoInput,
  TodoPrivateContext,
  TodoPublicContext
>;

export type TodoMachine = typeof todoMachine;
```

## 4. Set up the Actor Server

Wrap your machine with `createMachineServer` to create a Durable Object class:

```typescript
// src/todo.server.ts
import { createMachineServer } from "@actor-kit/worker";
import { todoMachine } from "./todo.machine";
import {
  TodoClientEventSchema,
  TodoServiceEventSchema,
  TodoInputPropsSchema,
} from "./todo.schemas";

export const Todo = createMachineServer({
  machine: todoMachine,
  schemas: {
    clientEvent: TodoClientEventSchema,
    serviceEvent: TodoServiceEventSchema,
    inputProps: TodoInputPropsSchema,
  },
  options: {
    persisted: true,
  },
});

export type TodoServer = InstanceType<typeof Todo>;
export default Todo;
```

## 5. Create the Cloudflare Worker

Set up the router that handles HTTP and WebSocket requests:

```typescript
// src/server.ts
import { DurableObjectNamespace } from "@cloudflare/workers-types";
import { AnyActorServer } from "@actor-kit/types";
import { createActorKitRouter } from "@actor-kit/worker";
import { WorkerEntrypoint } from "cloudflare:workers";
import { Todo, TodoServer } from "./todo.server";

interface Env {
  TODO: DurableObjectNamespace<TodoServer>;
  ACTOR_KIT_SECRET: string;
  [key: string]: DurableObjectNamespace<AnyActorServer> | unknown;
}

const router = createActorKitRouter<Env>(["todo"]);

export { Todo };

export default class Worker extends WorkerEntrypoint<Env> {
  fetch(request: Request): Promise<Response> | Response {
    if (request.url.includes("/api/")) {
      return router(request, this.env, this.ctx);
    }

    return new Response("API powered by ActorKit");
  }
}
```

## 6. Create the React context

```tsx
// src/todo.context.tsx
"use client";

import type { TodoMachine } from "./todo.machine";
import { createActorKitContext } from "@actor-kit/react";

export const TodoActorKitContext = createActorKitContext<TodoMachine>("todo");
export const TodoActorKitProvider = TodoActorKitContext.Provider;
```

## 7. Fetch data server-side

Load the initial snapshot on the server and pass it to the provider:

```typescript
// src/routes/lists.$listId.tsx
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { createAccessToken, createActorFetch } from "@actor-kit/server";
import type { Caller } from "@actor-kit/types";
import type { TodoMachine } from "../todo.machine";
import { TodoActorKitProvider } from "../todo.context";
import { TodoList } from "../components/TodoList";

const loadTodo = createServerFn({ method: "GET" })
  .handler(async ({ data }) => {
    const host = process.env.ACTOR_KIT_HOST!;
    const signingKey = process.env.ACTOR_KIT_SECRET!;
    const caller: Caller = { id: "demo-user", type: "client" };

    const accessToken = await createAccessToken({
      signingKey,
      actorId: data.listId,
      actorType: "todo",
      callerId: caller.id,
      callerType: caller.type,
    });

    const fetchTodo = createActorFetch<TodoMachine>({
      actorType: "todo",
      host,
    });

    const payload = await fetchTodo({
      actorId: data.listId,
      accessToken,
    });

    return { accessToken, host, listId: data.listId, payload, userId: caller.id };
  });

export const Route = createFileRoute("/lists/$listId")({
  loader: ({ params }) => loadTodo({ data: { listId: params.listId } }),
  component: TodoRouteComponent,
});

function TodoRouteComponent() {
  const { accessToken, host, listId, payload, userId } = Route.useLoaderData();

  return (
    <TodoActorKitProvider
      host={host}
      actorId={listId}
      accessToken={accessToken}
      checksum={payload.checksum}
      initialSnapshot={payload.snapshot}
    >
      <TodoList userId={userId} />
    </TodoActorKitProvider>
  );
}
```

## 8. Create a client component

Use the context hooks to read state and send events:

```tsx
// src/components/TodoList.tsx
"use client";

import { useState } from "react";
import { TodoActorKitContext } from "../todo.context";

export function TodoList({ userId }: { userId: string }) {
  const todos = TodoActorKitContext.useSelector((state) => state.public.todos);
  const send = TodoActorKitContext.useSend();
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
      <form onSubmit={handleAddTodo}>
        <input
          type="text"
          value={newTodoText}
          onChange={(e) => setNewTodoText(e.target.value)}
          placeholder="Add a new todo"
        />
        <button type="submit">Add</button>
      </form>
      <ul>
        {todos.map((todo) => (
          <li key={todo.id}>
            <span style={{ textDecoration: todo.completed ? "line-through" : "none" }}>
              {todo.text}
            </span>
            <button onClick={() => send({ type: "TOGGLE_TODO", id: todo.id })}>
              {todo.completed ? "Undo" : "Complete"}
            </button>
            <button onClick={() => send({ type: "DELETE_TODO", id: todo.id })}>
              Delete
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

## What's happening

1. **Schemas** validate events at the Durable Object boundary (Zod)
2. **Machine** defines state transitions and context mutations (XState v5)
3. **Server** wraps the machine as a Durable Object with persistence and WebSocket support
4. **Router** handles HTTP/WebSocket routing to the correct actor instance
5. **Provider** connects the React tree to the actor via WebSocket
6. **Hooks** give components reactive access to the caller-scoped snapshot

Every client gets `public` context plus their own `private` slice. State changes propagate as JSON Patch diffs to all connected clients in real time.

## Next steps

- [How It Works](/concepts/how-it-works/) — understand the data flow in detail
- [Public/Private Context](/concepts/public-private-context/) — learn about data isolation
- [Next.js Guide](/guides/nextjs/) — framework-specific integration guide
- [Testing Guide](/guides/testing/) — test your actors without a live server
