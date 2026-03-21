/**
 * Hono + Actor Kit example: Plain counter with no state library.
 *
 * Demonstrates:
 * - defineLogic for pure reducer-based actor logic
 * - Hono routes for HTTP API (GET snapshot, POST events)
 * - WebSocket upgrade for real-time state sync
 * - JWT auth via createAccessToken / getCallerFromRequest
 */
import { Hono } from "hono";
import { createAccessToken, getCallerFromRequest } from "../../../packages/core/src/auth";
import type { Caller } from "../../../packages/core/src/types";
import type { Env, CounterView } from "./counter";

export { Counter } from "./counter";

const app = new Hono<{ Bindings: Env }>();

// --- Helper: get a typed DO stub ---

type CounterStub = {
  spawn(props: { actorType: string; actorId: string; caller: Caller; input: Record<string, unknown> }): Promise<void>;
  send(event: { type: string; caller: Caller }): void;
  getSnapshot(caller: Caller): Promise<{ checksum: string; snapshot: CounterView }>;
  fetch(request: Request): Promise<Response>;
};

function getStub(env: Env, id: string): CounterStub {
  return env.COUNTER.get(env.COUNTER.idFromName(id)) as unknown as CounterStub;
}

// --- Auth middleware ---

app.use("/counter/:id/*", async (c, next) => {
  const id = c.req.param("id");
  try {
    const caller = await getCallerFromRequest(c.req.raw, "counter", id, c.env.ACTOR_KIT_SECRET);
    c.set("caller" as never, caller as never);
    await next();
  } catch {
    return c.json({ error: "Unauthorized — provide Bearer token" }, 401);
  }
});

// --- Routes ---

app.get("/", (c) =>
  c.json({
    name: "hono-plain-counter",
    description: "Counter using defineLogic — no state library",
    routes: [
      "POST /token",
      "GET /counter/:id — snapshot",
      "POST /counter/:id/increment",
      "POST /counter/:id/decrement",
      "POST /counter/:id/reset — service only",
      "GET /counter/:id/ws — WebSocket (real-time sync)",
    ],
  })
);

app.post("/token", async (c) => {
  const body = await c.req.json<{
    actorId: string;
    callerId: string;
    callerType: "client" | "service";
  }>();
  const token = await createAccessToken({
    signingKey: c.env.ACTOR_KIT_SECRET,
    actorId: body.actorId,
    actorType: "counter",
    callerId: body.callerId,
    callerType: body.callerType,
  });
  return c.json({ token });
});

// GET /counter/:id — get current snapshot
app.get("/counter/:id", async (c) => {
  const id = c.req.param("id");
  const caller = c.get("caller" as never) as Caller;
  const stub = getStub(c.env, id);
  await stub.spawn({ actorType: "counter", actorId: id, caller, input: {} });
  return c.json(await stub.getSnapshot(caller));
});

// POST /counter/:id/increment
app.post("/counter/:id/increment", async (c) => {
  const id = c.req.param("id");
  const caller = c.get("caller" as never) as Caller;
  const stub = getStub(c.env, id);
  await stub.spawn({ actorType: "counter", actorId: id, caller, input: {} });
  stub.send({ type: "INCREMENT", caller });
  return c.json(await stub.getSnapshot(caller));
});

// POST /counter/:id/decrement
app.post("/counter/:id/decrement", async (c) => {
  const id = c.req.param("id");
  const caller = c.get("caller" as never) as Caller;
  const stub = getStub(c.env, id);
  await stub.spawn({ actorType: "counter", actorId: id, caller, input: {} });
  stub.send({ type: "DECREMENT", caller });
  return c.json(await stub.getSnapshot(caller));
});

// POST /counter/:id/reset — service callers only
app.post("/counter/:id/reset", async (c) => {
  const id = c.req.param("id");
  const caller = c.get("caller" as never) as Caller;
  if (caller.type !== "service") {
    return c.json({ error: "Only service callers can reset" }, 403);
  }
  const stub = getStub(c.env, id);
  await stub.spawn({ actorType: "counter", actorId: id, caller, input: {} });
  stub.send({ type: "RESET", caller });
  return c.json(await stub.getSnapshot(caller));
});

// GET /counter/:id/ws — WebSocket upgrade for real-time sync
// The DO handles the WebSocket protocol internally (JSON Patch diffs,
// checksum tracking, caller-scoped views). We just forward the upgrade.
app.get("/counter/:id/ws", async (c) => {
  const id = c.req.param("id");
  const caller = c.get("caller" as never) as Caller;

  if (c.req.header("Upgrade") !== "websocket") {
    return c.json({ error: "Expected WebSocket upgrade" }, 426);
  }

  const stub = getStub(c.env, id);
  await stub.spawn({ actorType: "counter", actorId: id, caller, input: {} });

  // Forward the upgrade request to the DO — it handles the WebSocket lifecycle
  return stub.fetch(c.req.raw);
});

export default app;
