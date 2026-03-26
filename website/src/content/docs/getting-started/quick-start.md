---
title: Quick Start
description: Build a real-time counter in under 5 minutes.
---

Build a shared counter that multiple users can increment in real-time. The full source is in [`examples/counter/`](https://github.com/actor-kit/actor-kit/tree/main/examples/counter).

## 1. Define the Actor

```typescript
// src/counter.ts
import { z } from "zod";
import { actor, message, view, schema, uint32, string } from "actor-kit";

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

```javascript
// Get a token
const { token } = await fetch("/api/token?id=my-counter").then(r => r.json());

// Connect via WebSocket
const ws = new WebSocket(
  `wss://${location.host}/api/counter/my-counter`,
  [`token.${token}`]
);

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === "snapshot") {
    console.log("Count:", msg.data.count);
    console.log("Role:", msg.role);
  }
});

// Send a message
ws.send(JSON.stringify({ type: "INCREMENT" }));
```

Or use the typed client SDK:

```typescript
import { actorClient } from "actor-kit/client";
import { CounterView } from "./counter";

const CounterClient = actorClient(CounterView);

const client = CounterClient.create({
  url: `wss://${location.host}/api/counter/my-counter`,
  accessToken: token,
});

// view is typed from CounterView — no casting needed
client.subscribe((view) => {
  console.log("Count:", view.count);
});

client.send({ type: "INCREMENT" });
```

## 4. Deploy

```bash
npx wrangler deploy
```

## Next Steps

- [Counter Example](/guides/counter/) — full source with UI
- [Todo List Example](/guides/todo-list/) — multiple roles, guards, shared handlers
- [Concepts](/concepts/actors-and-state/) — deep dive into the actor model
- [Recipes](/recipes/actor-to-actor/) — focused how-to guides for specific tasks
