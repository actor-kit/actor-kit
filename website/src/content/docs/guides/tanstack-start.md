---
title: TanStack Start Integration
description: Using Actor Kit with TanStack Start, TanStack Router, and Cloudflare Workers.
---

This guide covers integrating Actor Kit with [TanStack Start](https://tanstack.com/start) using file-based routing and server functions. TanStack Start runs on Nitro, which supports Cloudflare Workers as a deployment target.

## Project structure

With TanStack Start, both the frontend and the Cloudflare Worker can live in the same project:

```
your-project/
├── src/
│   ├── todo.schemas.ts
│   ├── todo.types.ts
│   ├── todo.machine.ts
│   ├── todo.server.ts        # createMachineServer
│   ├── todo.context.tsx       # React context + hooks
│   ├── components/
│   │   └── TodoList.tsx       # Client component
│   └── routes/
│       ├── __root.tsx
│       └── lists.$listId.tsx  # Route with server function
├── server/
│   └── middleware/
│       └── actor-kit.ts       # Actor Kit middleware
├── exports.cloudflare.ts      # Worker entry point
├── wrangler.toml
└── app.config.ts
```

## Server function (data loading)

Use TanStack Start's `createServerFn` to load the initial snapshot:

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

    return {
      accessToken,
      host,
      listId: data.listId,
      payload,
      userId: caller.id,
    };
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

## Cloudflare Worker entry

Export the Actor Kit router from your Worker entry point alongside the Nitro handler:

```typescript
// exports.cloudflare.ts
import { createActorKitRouter } from "@actor-kit/worker";
import { Todo } from "./src/todo.server";

export { Todo };

// Actor Kit routes handled via middleware or direct routing
```

## Server middleware

Set up middleware to route Actor Kit requests before they hit the Nitro handler:

```typescript
// server/middleware/actor-kit.ts
import { createActorKitRouter } from "@actor-kit/worker";

const router = createActorKitRouter(["todo"]);

export default defineEventHandler(async (event) => {
  const url = new URL(event.node.req.url!, `http://${event.node.req.headers.host}`);

  if (url.pathname.startsWith("/api/")) {
    // Delegate to Actor Kit router
    return router(event.node.req as unknown as Request, event.context.cloudflare.env, event.context.cloudflare.ctx);
  }
});
```

## Wrangler configuration

```toml
name = "your-project"
main = "exports.cloudflare.ts"
compatibility_date = "2024-09-25"

[[durable_objects.bindings]]
name = "TODO"
class_name = "Todo"

[[migrations]]
tag = "v1"
new_classes = ["Todo"]
```

Set the secret via Wrangler (never put it in `wrangler.toml`):

```bash
npx wrangler secret put ACTOR_KIT_SECRET
```

## Client component

Same pattern as any React integration — use the context hooks:

```tsx
// src/components/TodoList.tsx
"use client";

import { useState } from "react";
import { TodoActorKitContext } from "../todo.context";

export function TodoList({ userId }: { userId: string }) {
  const todos = TodoActorKitContext.useSelector((s) => s.public.todos);
  const send = TodoActorKitContext.useSend();
  const [text, setText] = useState("");

  return (
    <div>
      <form onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) {
          send({ type: "ADD_TODO", text: text.trim() });
          setText("");
        }
      }}>
        <input value={text} onChange={(e) => setText(e.target.value)} />
        <button type="submit">Add</button>
      </form>
      <ul>
        {todos.map((todo) => (
          <li key={todo.id}>
            <span style={{ textDecoration: todo.completed ? "line-through" : "none" }}>
              {todo.text}
            </span>
            <button onClick={() => send({ type: "TOGGLE_TODO", id: todo.id })}>
              {todo.completed ? "Undo" : "Done"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

## E2E testing

The TanStack Start example includes Playwright E2E tests covering CRUD, persistence, and multi-client sync. See the [test file](https://github.com/actor-kit/actor-kit/blob/main/examples/tanstack-start-xstate-todo/e2e/todo.spec.ts) for patterns.

## Full example

See the complete [TanStack Start example app](https://github.com/actor-kit/actor-kit/tree/main/examples/tanstack-start-xstate-todo) in the repo.
