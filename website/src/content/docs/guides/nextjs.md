---
title: Next.js Integration
description: Using Actor Kit with Next.js App Router and Cloudflare Workers.
---

This guide covers integrating Actor Kit with Next.js using the App Router. The pattern works with any SSR framework — the key concepts are the same.

## Project structure

A typical Actor Kit + Next.js project has two deployments:

1. **Cloudflare Worker** — hosts the Durable Object (your actor)
2. **Next.js app** — SSR frontend that connects to the Worker

```
your-project/
├── src/
│   ├── todo.schemas.ts      # Zod event schemas
│   ├── todo.types.ts         # TypeScript types
│   ├── todo.machine.ts       # XState machine
│   ├── todo.server.ts        # createMachineServer
│   ├── todo.context.tsx       # React context + hooks
│   ├── server.ts              # Cloudflare Worker entry
│   ├── app/
│   │   └── lists/
│   │       └── [id]/
│   │           ├── page.tsx   # Server component (data loading)
│   │           └── components.tsx  # Client component (UI)
├── wrangler.toml
└── .dev.vars
```

## Server component (data loading)

In your route's server component, create an access token and fetch the initial snapshot:

```typescript
// src/app/lists/[id]/page.tsx
import { createAccessToken, createActorFetch } from "@actor-kit/server";
import type { TodoMachine } from "@/todo.machine";
import { TodoActorKitProvider } from "@/todo.context";
import { TodoList } from "./components";

export default async function ListPage({ params }: { params: { id: string } }) {
  const host = process.env.ACTOR_KIT_HOST!;
  const signingKey = process.env.ACTOR_KIT_SECRET!;
  const userId = "demo-user"; // Replace with your auth

  const accessToken = await createAccessToken({
    signingKey,
    actorId: params.id,
    actorType: "todo",
    callerId: userId,
    callerType: "client",
  });

  const fetchTodo = createActorFetch<TodoMachine>({
    actorType: "todo",
    host,
  });

  const { snapshot, checksum } = await fetchTodo({
    actorId: params.id,
    accessToken,
  });

  return (
    <TodoActorKitProvider
      host={host}
      actorId={params.id}
      accessToken={accessToken}
      checksum={checksum}
      initialSnapshot={snapshot}
    >
      <TodoList userId={userId} />
    </TodoActorKitProvider>
  );
}
```

## Client component

Client components use `useSelector` and `useSend` from the context:

```tsx
// src/app/lists/[id]/components.tsx
"use client";

import { useState } from "react";
import { TodoActorKitContext } from "@/todo.context";

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
            {todo.text}
            <button onClick={() => send({ type: "TOGGLE_TODO", id: todo.id })}>
              Toggle
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

## Environment variables

In your Next.js `.env.local`:

```bash
ACTOR_KIT_HOST=your-worker.your-subdomain.workers.dev
ACTOR_KIT_SECRET=your-secret-key
```

## Waiting for state

Use `waitForState` or `waitForEvent` when you need the actor to reach a specific state before SSR completes:

```typescript
const { snapshot, checksum } = await fetchTodo({
  actorId: params.id,
  accessToken,
  waitForState: { loaded: "success" },
  timeout: 5000,
  errorOnWaitTimeout: false, // Return current snapshot on timeout
});
```

## Full example

See the complete [Next.js example app](https://github.com/actor-kit/actor-kit/tree/main/examples/nextjs-actorkit-todo) in the repo.
