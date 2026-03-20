/**
 * Hono + actor-kit example.
 *
 * Shows how to use actor-kit DOs with your own routing — no createActorKitRouter needed.
 * Each route interacts with the DO stub directly via RPC methods.
 */
import { Hono } from "hono";
import { createAccessToken } from "@actor-kit/server";
import { getCallerFromRequest } from "@actor-kit/worker";
import type { Env } from "./counter";

// Re-export the DO class for wrangler
export { Counter } from "./counter";

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Helper: get a typed DO stub by name
// ---------------------------------------------------------------------------

function getCounterStub(env: Env, counterId: string) {
  const id = env.COUNTER.idFromName(counterId);
  return env.COUNTER.get(id);
}

// ---------------------------------------------------------------------------
// Public routes
// ---------------------------------------------------------------------------

app.get("/", (c) =>
  c.json({
    message: "Hono + actor-kit counter example",
    endpoints: {
      "GET /counter/:id": "Get counter snapshot (needs auth)",
      "POST /counter/:id/increment": "Increment counter (needs auth)",
      "POST /counter/:id/decrement": "Decrement counter (needs auth)",
      "POST /counter/:id/reset": "Reset counter (needs auth, service only)",
      "GET /counter/:id/ws": "WebSocket connection (needs auth)",
      "POST /token": "Get an access token",
    },
  })
);

// ---------------------------------------------------------------------------
// Token endpoint — in a real app this lives in your auth layer
// ---------------------------------------------------------------------------

app.post("/token", async (c) => {
  const body = await c.req.json<{
    counterId: string;
    userId: string;
    callerType?: "client" | "service";
  }>();

  const token = await createAccessToken({
    signingKey: c.env.ACTOR_KIT_SECRET,
    actorId: body.counterId,
    actorType: "counter",
    callerId: body.userId,
    callerType: body.callerType ?? "client",
  });

  return c.json({ token });
});

// ---------------------------------------------------------------------------
// Auth middleware — extract caller from JWT Bearer token
// ---------------------------------------------------------------------------

app.use("/counter/:id/*", async (c, next) => {
  try {
    const caller = await getCallerFromRequest(
      c.req.raw,
      "counter",
      c.req.param("id"),
      c.env.ACTOR_KIT_SECRET
    );
    c.set("caller" as never, caller as never);
    await next();
  } catch {
    return c.json({ error: "Unauthorized — provide Bearer token" }, 401);
  }
});

// ---------------------------------------------------------------------------
// Counter routes — each route is explicit, typed, composable
// ---------------------------------------------------------------------------

// GET /counter/:id — get the current snapshot
app.get("/counter/:id", async (c) => {
  const stub = getCounterStub(c.env, c.req.param("id"));
  const caller = c.get("caller" as never) as { id: string; type: string };

  // Ensure actor is spawned (idempotent)
  stub.spawn({
    actorType: "counter",
    actorId: c.req.param("id"),
    caller: caller as { id: string; type: "client" | "service" | "system" },
    input: {},
  });

  const result = await stub.getSnapshot(
    caller as { id: string; type: "client" | "service" | "system" }
  );
  return c.json(result);
});

// POST /counter/:id/increment
app.post("/counter/:id/increment", async (c) => {
  const stub = getCounterStub(c.env, c.req.param("id"));
  const caller = c.get("caller" as never) as {
    id: string;
    type: "client" | "service" | "system";
  };

  stub.spawn({
    actorType: "counter",
    actorId: c.req.param("id"),
    caller,
    input: {},
  });

  stub.send({ type: "INCREMENT", caller });

  const result = await stub.getSnapshot(caller);
  return c.json(result);
});

// POST /counter/:id/decrement
app.post("/counter/:id/decrement", async (c) => {
  const stub = getCounterStub(c.env, c.req.param("id"));
  const caller = c.get("caller" as never) as {
    id: string;
    type: "client" | "service" | "system";
  };

  stub.spawn({
    actorType: "counter",
    actorId: c.req.param("id"),
    caller,
    input: {},
  });

  stub.send({ type: "DECREMENT", caller });

  const result = await stub.getSnapshot(caller);
  return c.json(result);
});

// POST /counter/:id/reset — service-only
app.post("/counter/:id/reset", async (c) => {
  const stub = getCounterStub(c.env, c.req.param("id"));
  const caller = c.get("caller" as never) as {
    id: string;
    type: "client" | "service" | "system";
  };

  if (caller.type !== "service") {
    return c.json({ error: "Only service callers can reset" }, 403);
  }

  stub.spawn({
    actorType: "counter",
    actorId: c.req.param("id"),
    caller,
    input: {},
  });

  stub.send({ type: "RESET", caller });

  const result = await stub.getSnapshot(caller);
  return c.json(result);
});

// GET /counter/:id/ws — WebSocket upgrade (forward to DO)
app.get("/counter/:id/ws", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.json({ error: "Expected WebSocket upgrade" }, 426);
  }

  const stub = getCounterStub(c.env, c.req.param("id"));
  const caller = c.get("caller" as never) as {
    id: string;
    type: "client" | "service" | "system";
  };

  stub.spawn({
    actorType: "counter",
    actorId: c.req.param("id"),
    caller,
    input: {},
  });

  // Forward the WebSocket upgrade to the DO
  return stub.fetch(c.req.raw);
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export default app;
