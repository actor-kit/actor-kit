---
title: Counter
description: A minimal shared counter with real-time sync.
---

The counter is the simplest actor — it demonstrates the contract-first API, flat messages, guards, views, and real-time sync between multiple users.

**Source**: [`examples/counter/`](https://github.com/actor-kit/actor-kit/tree/main/examples/counter)

## What it demonstrates

- `defineActor()` + `createActorClass()` — contract-first API
- Flat messages with optional guards
- `message()` with Zod validation
- `schema()` and `view()` for typed view projections
- Real-time sync: two browsers sharing the same counter
- Admin vs user roles via `callerType`
- Contract-derived client: typed `actorClient(contract)` — no manual message unions

## The Contract

The contract defines state, messages, roles, and views in a single file:

```typescript
// counter.contract.ts
import { z } from "zod";
import { schema, view, uint32, string } from "@actor-kit/core";
import { defineActor, message } from "@actor-kit/worker";

type CounterState = { count: number; lastUpdatedBy: string | null };

const CounterView = schema({ count: uint32, lastUpdatedBy: string });

export const CounterContract = defineActor("counter", {
  input: z.object({}),
  init: (): CounterState => ({ count: 0, lastUpdatedBy: null }),

  roles: {
    admin: (_state, _caller, { callerType }) => callerType === "service",
    user: () => true,
  },

  messages: {
    INCREMENT: message(
      z.object({}),
      (state: CounterState, _payload, { caller }) => ({
        ...state,
        count: state.count + 1,
        lastUpdatedBy: caller,
      }),
    ),
    DECREMENT: message(
      z.object({}),
      (state: CounterState, _payload, { caller }) => ({
        ...state,
        count: Math.max(0, state.count - 1),
        lastUpdatedBy: caller,
      }),
    ),
    RESET: message(z.object({}), {
      guard: (_state, _payload, ctx) => ctx.role === "admin",
      handler: () => ({ count: 0, lastUpdatedBy: null }),
    }),
  },

  views: {
    admin: view(CounterView, (state) => ({ count: state.count, lastUpdatedBy: state.lastUpdatedBy ?? "" })),
    user: view(CounterView, (state) => ({ count: state.count, lastUpdatedBy: state.lastUpdatedBy ?? "" })),
  },
});
export type CounterContract = typeof CounterContract;
```

## The Server

The server file imports the contract value and creates the Durable Object class:

```typescript
// counter.server.ts
import { createActorClass } from "@actor-kit/worker";
import { CounterContract } from "./counter.contract";

export const Counter = createActorClass(CounterContract);
```

Key points:
- **Messages are flat** — not nested by role. `RESET` uses a guard to restrict to admin
- **`defineActor()`** returns a typed contract — `createActorClass()` converts it to a DO class
- **Both roles** can see `INCREMENT` and `DECREMENT` — guards are only needed for restricted actions
- **Views** are the same shape for both roles — in more complex actors, roles would see different projections
- **The contract is separate from the DO class** — server imports the value, client imports only the type

## The Worker

The Worker is the auth boundary. It derives caller identity from a session cookie (NOT from query params) and stamps it onto the request via `withCallerIdentity()` before forwarding to the DO:

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

    if (url.pathname.startsWith("/api/counter/")) {
      const actorId = url.pathname.split("/")[3] ?? "default";

      // Authenticate via session cookie (PRODUCTION: validate a signed cookie, OAuth, etc.)
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

Note: `callerId` comes from the cookie — it is never accepted from the URL. Clients connect to `/api/counter/<id>` with no query params; the session cookie is sent automatically by the browser.

## The Client

### Vanilla TypeScript

Client code uses `import type` to import the contract — this keeps Zod, handlers, and Cloudflare dependencies out of the browser bundle. The client takes a `path` (not a full URL) and requires an `initialView` — the server always provides the first snapshot:

```typescript
import { actorClient } from "@actor-kit/client";
import type { CounterContract } from "./counter.contract";

// Type-only — no runtime contract value in the bundle
const CounterClient = actorClient<CounterContract>();

// Create a runtime connection — cookie is sent automatically by the browser
const client = CounterClient.create({
  path: `/api/counter/default`,
  initialView: { count: 0, lastUpdatedBy: "" }, // or an SSR snapshot
});
client.connect();

// view is typed: { count: number; lastUpdatedBy: string }
client.subscribe((view) => {
  document.getElementById("count")!.textContent = String(view.count);
});

client.send({ type: "INCREMENT" });
```

### React

The server fetches the initial snapshot during SSR. `useClient()` creates and manages the client's lifecycle — it opens the WebSocket on mount and closes it on unmount:

```tsx
import { actorContext } from "@actor-kit/react";
import type { CounterContract } from "./counter.contract";

// Type-only — no runtime contract value in the bundle
const CounterCtx = actorContext<typeof CounterContract>();

// Server loader: fetch initial snapshot from the Durable Object.
// Runs on the Worker — direct DO binding access.
export async function loader({ env, params }: { env: Env; params: { counterId: string } }) {
  const id = env.COUNTER.idFromName(params.counterId);
  const stub = env.COUNTER.get(id);
  await stub.spawn({
    actorId: params.counterId,
    caller: "system",
    callerType: "service",
    input: {},
  });
  const { snapshot } = await stub.getSnapshot("demo-user", "user");
  return { counterId: params.counterId, snapshot };
}

function App({ counterId, snapshot }: { counterId: string; snapshot: { count: number; lastUpdatedBy: string } }) {
  // useClient creates the client once (stable across re-renders) and manages
  // connect/disconnect. initialView seeds the view before the socket opens —
  // no undefined state. Cookies provide auth automatically.
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
  const view = CounterCtx.useView();   // always defined — seeded from initialView
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

## Try it

```bash
cd examples/counter
pnpm install
pnpm dev
# Open http://localhost:8787
# Open a second tab — both see the same counter
```
