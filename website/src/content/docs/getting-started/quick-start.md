---
title: Quick Start
description: Build a real-time counter in under 5 minutes.
---

Build a shared counter that multiple users can increment in real-time. The full source is in [`examples/counter/`](https://github.com/actor-kit/actor-kit/tree/main/examples/counter).

## 1. Define the Contract

The contract lives in its own file. It defines state, messages, roles, and views — everything both server and client need to know about the actor:

```typescript
// src/counter.contract.ts
import { z } from "zod";
import { schema, view, uint32, string } from "@actor-kit/core";
import { defineActor, message } from "@actor-kit/worker";

const CounterView = schema({ count: uint32, lastUpdatedBy: string });

export const CounterContract = defineActor("counter", {
  input: z.object({}),
  init: () => ({ count: 0, lastUpdatedBy: null as string | null }),

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
    user: view.shared(CounterView, (state) => ({
      count: state.count,
      lastUpdatedBy: state.lastUpdatedBy,
    })),
  },
});
export type CounterContract = typeof CounterContract;
```

Then the server file imports the contract value and creates the Durable Object class:

```typescript
// src/counter.server.ts
import { createActorClass } from "@actor-kit/worker";
import { CounterContract } from "./counter.contract";

export const Counter = createActorClass(CounterContract);
```

Key things happening:
- **`defineActor()`** returns a typed contract — not a DO class. Everything derives from it.
- **`createActorClass()`** converts the contract into a Durable Object class
- **`message()`** pairs a Zod schema with a handler — payload is validated before the handler runs
- **Messages are flat** — no nesting by role. Guards handle authorization (see [Todo List](/examples/todo-list/))
- **Handlers are synchronous** — they return new state, no `async`/`await`
- **`schema()`** defines the view shape for binary encoding and TypeScript inference
- **The contract file is separate** — server imports the value, client imports only the type (see below)

## 2. Create the Worker

The Worker is the auth boundary. It authenticates the caller and stamps verified identity onto the request. The DO trusts the Worker.

```typescript
// src/worker.ts
import { withCallerIdentity } from "@actor-kit/worker";
import { Counter } from "./counter.server";

export { Counter };

interface Env {
  COUNTER: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Route WebSocket connections to the Counter DO
    if (url.pathname.startsWith("/api/counter/")) {
      const actorId = url.pathname.split("/")[3] ?? "default";

      // Authenticate via session cookie.
      // PRODUCTION: validate a signed session cookie, OAuth token, or similar credential.
      const { callerId } = resolveCaller(request);

      const id = env.COUNTER.idFromName(actorId);
      const stub = env.COUNTER.get(id);

      // Spawn idempotently
      await stub.spawn({ actorId, caller: "system", callerType: "service", input: {} });

      // Stamp verified identity and forward to DO
      const stamped = withCallerIdentity(request, { callerId, callerType: "user" });
      return stub.fetch(stamped);
    }

    return new Response("Not found", { status: 404 });
  },
};

function resolveCaller(request: Request): { callerId: string } {
  const cookieHeader = request.headers.get("Cookie") ?? "";
  const match = cookieHeader.match(/(?:^|;\s*)caller_id=([^;]+)/);
  if (match?.[1]) return { callerId: decodeURIComponent(match[1]) };
  return { callerId: `user-${crypto.randomUUID().slice(0, 8)}` };
}
```

Key things happening:
- **`withCallerIdentity()`** scrubs any inbound identity headers, then stamps verified `callerId` and `callerType`
- **Cookie-based auth** — caller identity comes from a session cookie sent automatically by the browser. Never from URL query params.

## 3. Connect from the Browser

### Vanilla TypeScript

Client code uses `import type` to import the contract — this keeps Zod, handlers, and Cloudflare dependencies out of the browser bundle:

```typescript
import { actorClient } from "@actor-kit/client";
import type { CounterContract } from "./counter.contract";

// Type-only — no runtime contract value in the bundle
const CounterClient = actorClient<CounterContract>();

// Create a runtime connection — the browser sends the session cookie automatically.
// `path` (not `url`) means "relative to the current host". `host` is optional for
// overriding (e.g. in native apps).
const client = CounterClient.create({
  path: `/api/counter/my-counter`,
  initialView: { count: 0, lastUpdatedBy: "" }, // or an SSR snapshot
});
client.connect();

// Subscribe to typed views — binary delta decoding is handled transparently
client.subscribe((view) => {
  // view is typed: { count: number; lastUpdatedBy: string }
  console.log("Count:", view.count);
});

// Send typed messages — inferred from contract
client.send({ type: "INCREMENT" });
```

### React

The server loader fetches the initial snapshot from the DO. `useClient()` creates the client once and manages connect/disconnect on mount:

```tsx
import { actorContext } from "@actor-kit/react";
import type { CounterContract } from "./counter.contract";

const CounterCtx = actorContext<typeof CounterContract>();

// Server loader fetches the initial snapshot from the DO
export async function loader({ env, params, callerId }: { env: Env; params: { counterId: string }; callerId: string }) {
  const stub = env.COUNTER.get(env.COUNTER.idFromName(params.counterId));
  await stub.spawn({ actorId: params.counterId, caller: "system", callerType: "service", input: {} });
  const { snapshot } = await stub.getSnapshot(callerId, "user");
  return { counterId: params.counterId, snapshot };
}

function App({ counterId, snapshot }: { counterId: string; snapshot: { count: number; lastUpdatedBy: string } }) {
  // useClient creates the client once and manages connect/disconnect on mount.
  // initialView seeds useView() before the socket opens — no undefined state.
  // Cookies supply auth automatically.
  const client = CounterCtx.useClient({
    path: `/api/counter/${counterId}`,
    initialView: { role: "user", ...snapshot },
  });

  return (
    <CounterCtx.Provider client={client}>
      <Counter />
    </CounterCtx.Provider>
  );
}

function Counter() {
  const view = CounterCtx.useView();   // always defined — never undefined
  const send = CounterCtx.useSend();

  return (
    <div>
      <span>{view.count}</span>
      <button onClick={() => send({ type: "INCREMENT" })}>+</button>
      <button onClick={() => send({ type: "DECREMENT" })}>-</button>
    </div>
  );
}
```

The `initialView` prop is required — the server always provides the first snapshot. `useView()` returns the view directly, no null checks needed. The WebSocket connects and takes over with live updates.

## 4. Deploy

```bash
npx wrangler deploy
```

## Next Steps

- [Counter Example](/examples/counter/) — full source with UI
- [Todo List Example](/examples/todo-list/) — multiple roles, guards, shared handlers
- [Concepts](/concepts/actors-and-state/) — deep dive into the actor model
- [Recipes](/recipes/actor-to-actor/) — focused how-to guides for specific tasks
