---
title: Quick Start
description: Build a real-time counter in under 5 minutes.
---

Build a shared counter that multiple users can increment in real-time. The full source is in [`examples/counter/`](https://github.com/actor-kit/actor-kit/tree/main/examples/counter).

## 1. Define the Actor

```typescript
// src/counter.ts
import { z } from "zod";
import { schema, view, uint32, string } from "@actor-kit/core";
import { actor, message } from "@actor-kit/worker";

type CounterState = { count: number; lastUpdatedBy: string | null };

const CounterView = schema({ count: uint32, lastUpdatedBy: string });

const increment = message(
  z.object({}),
  (state: CounterState, _payload, { caller }) => ({
    ...state,
    count: state.count + 1,
    lastUpdatedBy: caller,
  }),
);

const decrement = message(
  z.object({}),
  (state: CounterState, _payload, { caller }) => ({
    ...state,
    count: Math.max(0, state.count - 1),
    lastUpdatedBy: caller,
  }),
);

export const Counter = actor("counter", {
  input: z.object({}),
  init: (): CounterState => ({ count: 0, lastUpdatedBy: null }),

  roles: {
    user: () => true,
  },

  messages: {
    user: { INCREMENT: increment, DECREMENT: decrement },
  },

  views: {
    user: view(CounterView, (state: CounterState) => ({
      count: state.count,
      lastUpdatedBy: state.lastUpdatedBy ?? "",
    })),
  },
});
```

Key things happening:
- **`schema()`** defines the view shape for binary encoding and TypeScript inference
- **`message()`** pairs a Zod schema with a handler — payload is validated before the handler runs
- **`actor()`** returns a Durable Object class — one function defines everything
- **`roles`** determine who can do what — here everyone is a "user"
- **`views`** define what each role sees — the framework handles sync

## 2. Create the Worker

```typescript
// src/worker.ts
import { createAccessToken } from "@actor-kit/worker";
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
    if (url.pathname.startsWith("/api/counter/")) {
      const actorId = url.pathname.split("/")[3] ?? "default";
      const id = env.COUNTER.idFromName(actorId);
      const stub = env.COUNTER.get(id);
      await stub.spawn({ actorId, caller: "system", callerType: "service", input: {} });
      return stub.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};
```

## 3. Connect from the Browser

### Vanilla TypeScript

```typescript
import { actorClient } from "@actor-kit/client";
import { CounterView } from "./counter";

type CounterEvent = { type: "INCREMENT" } | { type: "DECREMENT" };

// Define the client factory (co-locate with your actor definition)
const CounterClient = actorClient(CounterView).events<CounterEvent>();

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

// Send typed events
client.send({ type: "INCREMENT" });
```

### React

```tsx
import { actorClient } from "@actor-kit/client";
import { actorContext } from "@actor-kit/react";
import { CounterView } from "./counter";

type CounterEvent = { type: "INCREMENT" } | { type: "DECREMENT" };

const CounterClient = actorClient(CounterView).events<CounterEvent>();
const CounterCtx = actorContext<typeof CounterClient>();

function App({ token }: { token: string }) {
  const client = CounterClient.create({
    url: `wss://${location.host}/api/counter/my-counter`,
    accessToken: token,
  });

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

## 4. Deploy

```bash
npx wrangler deploy
```

## Next Steps

- [Counter Example](/examples/counter/) — full source with UI
- [Todo List Example](/examples/todo-list/) — multiple roles, guards, shared handlers
- [Concepts](/concepts/actors-and-state/) — deep dive into the actor model
- [Recipes](/recipes/actor-to-actor/) — focused how-to guides for specific tasks
