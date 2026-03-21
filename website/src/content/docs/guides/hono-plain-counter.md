---
title: "Plain Counter with Hono"
description: Build a real-time counter API with Actor Kit and Hono — no state library required.
---

This guide walks through building a counter actor with Hono routing, using `defineLogic` — no XState, no Redux, just a plain reducer function. This is the simplest way to use Actor Kit.

> **Source code**: [examples/hono-plain-counter](https://github.com/actor-kit/actor-kit/tree/main/examples/hono-plain-counter)

## What you'll build

A counter API that:
- Tracks a count per actor (each URL gets its own counter)
- Records who last updated it and per-caller access counts
- Only allows service callers to reset
- Syncs state in real time via WebSocket

## 1. Define your actor logic

Actor Kit's core abstraction is `ActorLogic` — an interface with three functions:
- `create(input, ctx)` — initial state
- `transition(state, event)` — state + event → next state
- `getView(state, caller)` — what each caller sees

```typescript
// src/counter.ts
import { defineLogic, createDurableActor } from "@actor-kit/core";
import { produce } from "immer";
import { z } from "zod";

type CounterState = {
  count: number;
  lastUpdatedBy: string | null;
  accessCounts: Record<string, number>;
};

type CounterEvent =
  | { type: "INCREMENT" }
  | { type: "DECREMENT" }
  | { type: "RESET" };

type CounterView = {
  count: number;
  lastUpdatedBy: string | null;
  myAccessCount: number;
};

const counterLogic = defineLogic({
  create: () => ({
    count: 0,
    lastUpdatedBy: null,
    accessCounts: {},
  }),

  transition: (state, event) =>
    produce(state, (draft) => {
      const { caller } = event;
      switch (event.type) {
        case "INCREMENT":
          draft.count += 1;
          draft.lastUpdatedBy = caller.id;
          draft.accessCounts[caller.id] = (draft.accessCounts[caller.id] ?? 0) + 1;
          break;
        case "DECREMENT":
          draft.count -= 1;
          draft.lastUpdatedBy = caller.id;
          break;
        case "RESET":
          if (caller.type !== "service") break;
          draft.count = 0;
          draft.lastUpdatedBy = null;
          break;
      }
    }),

  getView: (state, caller) => ({
    count: state.count,
    lastUpdatedBy: state.lastUpdatedBy,
    myAccessCount: state.accessCounts[caller.id] ?? 0,
  }),
});
```

Key points:
- **Immer `produce`** — mutate a draft instead of spreading. Cleaner, especially for nested state.
- **`event.caller`** is always available — Actor Kit augments every event with the caller identity and env bindings.
- **`getView`** controls what each caller sees. User A and User B both see the same `count`, but each sees their own `myAccessCount`.
- **Authorization is in the transition** — `RESET` checks `caller.type !== "service"` and returns state unchanged if unauthorized.

## 2. Wire into a Durable Object

`createDurableActor` turns your logic into a Cloudflare Durable Object class with WebSocket support, persistence, and JSON Patch sync built in.

```typescript
// src/counter.ts (continued)
export const Counter = createDurableActor({
  logic: counterLogic,
  events: {
    client: z.discriminatedUnion("type", [
      z.object({ type: z.literal("INCREMENT") }),
      z.object({ type: z.literal("DECREMENT") }),
    ]),
    service: z.discriminatedUnion("type", [
      z.object({ type: z.literal("RESET") }),
    ]),
  },
  input: z.object({}),
  persisted: true,
});
```

The `events` object defines Zod schemas that validate events at runtime — client events come from browsers, service events come from backend callers. Invalid events are rejected before reaching your transition function.

## 3. Add Hono routes

Actor Kit doesn't require a specific router. Use any framework — Hono, Express, TanStack Start server functions, etc. Here we use Hono:

```typescript
// src/index.ts
import { Hono } from "hono";
import { createAccessToken, getCallerFromRequest } from "@actor-kit/core";

export { Counter } from "./counter";

const app = new Hono<{ Bindings: Env }>();

// Auth middleware — extracts caller from JWT Bearer token
app.use("/counter/:id/*", async (c, next) => {
  try {
    const caller = await getCallerFromRequest(
      c.req.raw, "counter", c.req.param("id"), c.env.ACTOR_KIT_SECRET
    );
    c.set("caller", caller);
    await next();
  } catch {
    return c.json({ error: "Unauthorized" }, 401);
  }
});

// GET /counter/:id — current snapshot
app.get("/counter/:id", async (c) => {
  const stub = getStub(c.env, c.req.param("id"));
  const caller = c.get("caller");
  await stub.spawn({ actorType: "counter", actorId: id, caller, input: {} });
  return c.json(await stub.getSnapshot(caller));
});

// POST /counter/:id/increment
app.post("/counter/:id/increment", async (c) => {
  const stub = getStub(c.env, c.req.param("id"));
  const caller = c.get("caller");
  stub.send({ type: "INCREMENT", caller });
  return c.json(await stub.getSnapshot(caller));
});

// GET /counter/:id/ws — WebSocket for real-time sync
app.get("/counter/:id/ws", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.json({ error: "Expected WebSocket upgrade" }, 426);
  }
  const stub = getStub(c.env, c.req.param("id"));
  return stub.fetch(c.req.raw); // DO handles WebSocket lifecycle
});
```

The WebSocket route is the key — `stub.fetch(c.req.raw)` forwards the upgrade request to the Durable Object, which handles the entire WebSocket lifecycle: JSON Patch diffs, checksum deduplication, caller-scoped views, and reconnection.

## 4. Connect from the browser

Use `@actor-kit/browser` to connect via WebSocket and receive real-time state patches:

```typescript
import { createActorKitClient } from "@actor-kit/browser";

const client = createActorKitClient<CounterView, CounterEvent>({
  host: "your-worker.example.com",
  actorType: "counter",
  actorId: "my-counter",
  accessToken: token, // JWT from /token endpoint
  checksum: initialChecksum,
  initialSnapshot: initialView,
});

await client.connect(); // Opens WebSocket

// State updates arrive automatically via JSON Patch
client.subscribe((view) => {
  console.log("Count:", view.count);
});

// Send events
client.send({ type: "INCREMENT" });
// Or use the trigger API
client.trigger.INCREMENT();
```

## 5. Configure Wrangler

```toml
# wrangler.toml
name = "my-counter"
main = "src/index.ts"
compatibility_date = "2024-09-25"
compatibility_flags = ["nodejs_compat"]

[vars]
ACTOR_KIT_SECRET = "change-me-in-production"

[[durable_objects.bindings]]
name = "COUNTER"
class_name = "Counter"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Counter"]
```

## What Actor Kit handles for you

You wrote ~50 lines of logic. Actor Kit provides:
- **WebSocket lifecycle** — connection, reconnection with exponential backoff
- **JSON Patch sync** — only sends the diff, not the full state
- **Checksum deduplication** — skips updates when state hasn't changed
- **Caller-scoped views** — each WebSocket gets patches for their specific `getView` output
- **Persistence** — snapshots stored in DO SQLite storage
- **JWT auth** — tokens validated on every connection and event

## Next steps

- Add a React UI with [`@actor-kit/react`](/api/react/)
- Try a different state library: [XState](/guides/xstate), [@xstate/store](/guides/xstate-store), or [Redux](/guides/redux)
- Add [testing](/guides/testing) with the mock client
