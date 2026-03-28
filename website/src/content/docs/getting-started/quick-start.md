---
title: Quick Start
description: Build a real-time counter in under 5 minutes.
---

Build a shared counter that multiple users can increment in real-time. The full source is in [`examples/counter/`](https://github.com/actor-kit/actor-kit/tree/main/examples/counter).

## 1. Define the Actor

```typescript
// src/counter.ts
import { z } from "zod";
import { schema, view, uint32, string } from "actor-kit";
import { defineActor, createActorClass, message } from "actor-kit";

const CounterView = schema({ count: uint32, lastUpdatedBy: string });

export const CounterContract = defineActor("counter", {
  input: z.object({}),
  init: () => ({ count: 0, lastUpdatedBy: "" }),

  roles: {
    user: () => true,
  },

  messages: {
    INCREMENT: message(z.object({}), (state, _payload, { caller }) => ({
      ...state,
      count: state.count + 1,
      lastUpdatedBy: caller,
    })),
    DECREMENT: message(z.object({}), (state, _payload, { caller }) => ({
      ...state,
      count: Math.max(0, state.count - 1),
      lastUpdatedBy: caller,
    })),
  },

  views: {
    user: view(CounterView, (state) => ({
      count: state.count,
      lastUpdatedBy: state.lastUpdatedBy,
    })),
  },
});

export const Counter = createActorClass(CounterContract);
```

Key things happening:
- **`defineActor()`** returns a typed contract — not a DO class. Everything derives from it.
- **`createActorClass()`** converts the contract into a Durable Object class
- **`message()`** pairs a Zod schema with a handler — payload is validated before the handler runs
- **Messages are flat** — no nesting by role. Guards handle authorization (see [Todo List](/examples/todo-list/))
- **Handlers are synchronous** — they return new state, no `async`/`await`
- **`schema()`** defines the view shape for binary encoding and TypeScript inference

## 2. Create the Worker

```typescript
// src/worker.ts
import { createAccessToken } from "actor-kit";
import { Counter } from "./counter";

export { Counter };

interface Env {
  ACTOR_KIT_SECRET: string;
  COUNTER: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Create access token for WebSocket auth
    if (url.pathname === "/api/token") {
      const actorId = url.searchParams.get("id") ?? "default";
      const token = await createAccessToken({
        actorType: "counter",
        actorId,
        callerId: `user-${crypto.randomUUID().slice(0, 8)}`,
        callerType: "user",
        secret: env.ACTOR_KIT_SECRET,
      });
      return Response.json({ token, actorId });
    }

    // Route WebSocket connections to the Counter DO
    // No spawn() needed — actors with no required input auto-initialize on first connection
    if (url.pathname.startsWith("/api/counter/")) {
      const actorId = url.pathname.split("/")[3] ?? "default";
      const id = env.COUNTER.idFromName(actorId);
      return env.COUNTER.get(id).fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};
```

## 3. Connect from the Browser

### Vanilla TypeScript

```typescript
import { actorClient } from "actor-kit/client";
import { CounterContract } from "./counter";

// Create a typed client factory — events and views inferred from the contract
const CounterClient = actorClient(CounterContract);

// Get a token
const { token } = await fetch("/api/token?id=my-counter").then(r => r.json());

// Create a runtime connection
const client = CounterClient.create({
  url: `wss://${location.host}/api/counter/my-counter`,
  accessToken: token,
});

// Subscribe to typed views — binary delta decoding is handled transparently
client.subscribe((view) => {
  // view is typed: { count: number; lastUpdatedBy: string }
  console.log("Count:", view.count);
});

// Send typed events — inferred from contract messages
client.send({ type: "INCREMENT" });
```

### React

```tsx
import { useState, useEffect } from "react";
import { actorClient } from "actor-kit/client";
import { actorContext } from "actor-kit/react";
import { CounterContract } from "./counter";

const CounterClient = actorClient(CounterContract);
const CounterCtx = actorContext(CounterContract);

function App({ token }: { token: string }) {
  const [client, setClient] = useState<ReturnType<typeof CounterClient.create> | null>(null);

  useEffect(() => {
    const c = CounterClient.create({
      url: `wss://${location.host}/api/counter/my-counter`,
      accessToken: token,
    });
    setClient(c);
    return () => c.disconnect();
  }, [token]);

  if (!client) return null;

  return (
    <CounterCtx.Provider client={client}>
      <Counter />
    </CounterCtx.Provider>
  );
}

function Counter() {
  const view = CounterCtx.useView();   // { count: number; lastUpdatedBy: string } | undefined
  const send = CounterCtx.useSend();   // (event: CounterEvent) => void

  return (
    <div>
      <span>{view?.count ?? "..."}</span>
      <button onClick={() => send({ type: "INCREMENT" })}>+</button>
      <button onClick={() => send({ type: "DECREMENT" })}>-</button>
    </div>
  );
}
```

No manual event unions needed — `CounterCtx.useSend()` infers event types from the contract's messages.

## 4. Deploy

```bash
npx wrangler deploy
```

## Next Steps

- [Counter Example](/examples/counter/) — full source with UI
- [Todo List Example](/examples/todo-list/) — multiple roles, guards, shared handlers
- [Concepts](/concepts/actors-and-state/) — deep dive into the actor model
- [Recipes](/recipes/actor-to-actor/) — focused how-to guides for specific tasks
