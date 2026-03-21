/**
 * Hono server for the plain-counter example.
 */
import { Hono } from "hono";
import { createAccessToken, getCallerFromRequest } from "../../../packages/core/src/auth";
import type { Caller } from "../../../packages/core/src/types";
import type { Env, CounterView } from "./counter";

export { Counter } from "./counter";

const app = new Hono<{ Bindings: Env }>();

// --- Middleware: auth ---

async function requireAuth(
  c: { req: { raw: Request }; env: Env; json: (body: unknown, status?: number) => Response },
  actorId: string
): Promise<Caller | null> {
  try {
    return await getCallerFromRequest(c.req.raw, "counter", actorId, c.env.ACTOR_KIT_SECRET);
  } catch {
    return null;
  }
}

// --- Routes ---

app.get("/", (c) =>
  c.json({
    name: "plain-counter-example",
    description: "Counter using defineLogic — no state library",
    routes: [
      "POST /token",
      "GET /counter/:id",
      "POST /counter/:id/increment",
      "POST /counter/:id/decrement",
      "POST /counter/:id/reset",
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

app.get("/counter/:id", async (c) => {
  const id = c.req.param("id");
  const caller = await requireAuth(c, id);
  if (!caller) return c.json({ error: "Unauthorized" }, 401);

  const stub = c.env.COUNTER.get(c.env.COUNTER.idFromName(id)) as unknown as {
    spawn: (props: { actorType: string; actorId: string; caller: Caller; input: Record<string, unknown> }) => Promise<void>;
    getSnapshot: (caller: Caller) => Promise<{ checksum: string; snapshot: CounterView }>;
  };
  await stub.spawn({ actorType: "counter", actorId: id, caller, input: {} });
  const { snapshot, checksum } = await stub.getSnapshot(caller);
  return c.json({ snapshot, checksum });
});

app.post("/counter/:id/increment", async (c) => {
  const id = c.req.param("id");
  const caller = await requireAuth(c, id);
  if (!caller) return c.json({ error: "Unauthorized" }, 401);

  const stub = c.env.COUNTER.get(c.env.COUNTER.idFromName(id)) as unknown as {
    spawn: (props: { actorType: string; actorId: string; caller: Caller; input: Record<string, unknown> }) => Promise<void>;
    send: (event: { type: string; caller: Caller }) => void;
    getSnapshot: (caller: Caller) => Promise<{ checksum: string; snapshot: CounterView }>;
  };
  await stub.spawn({ actorType: "counter", actorId: id, caller, input: {} });
  stub.send({ type: "INCREMENT", caller });
  const { snapshot, checksum } = await stub.getSnapshot(caller);
  return c.json({ snapshot, checksum });
});

app.post("/counter/:id/decrement", async (c) => {
  const id = c.req.param("id");
  const caller = await requireAuth(c, id);
  if (!caller) return c.json({ error: "Unauthorized" }, 401);

  const stub = c.env.COUNTER.get(c.env.COUNTER.idFromName(id)) as unknown as {
    spawn: (props: { actorType: string; actorId: string; caller: Caller; input: Record<string, unknown> }) => Promise<void>;
    send: (event: { type: string; caller: Caller }) => void;
    getSnapshot: (caller: Caller) => Promise<{ checksum: string; snapshot: CounterView }>;
  };
  await stub.spawn({ actorType: "counter", actorId: id, caller, input: {} });
  stub.send({ type: "DECREMENT", caller });
  const { snapshot, checksum } = await stub.getSnapshot(caller);
  return c.json({ snapshot, checksum });
});

app.post("/counter/:id/reset", async (c) => {
  const id = c.req.param("id");
  const caller = await requireAuth(c, id);
  if (!caller) return c.json({ error: "Unauthorized" }, 401);

  const stub = c.env.COUNTER.get(c.env.COUNTER.idFromName(id)) as unknown as {
    spawn: (props: { actorType: string; actorId: string; caller: Caller; input: Record<string, unknown> }) => Promise<void>;
    send: (event: { type: string; caller: Caller }) => void;
    getSnapshot: (caller: Caller) => Promise<{ checksum: string; snapshot: CounterView }>;
  };
  await stub.spawn({ actorType: "counter", actorId: id, caller, input: {} });
  stub.send({ type: "RESET", caller });
  const { snapshot, checksum } = await stub.getSnapshot(caller);
  return c.json({ snapshot, checksum });
});

export default app;
