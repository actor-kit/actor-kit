/**
 * Studio live scenarios at the Durable Object seam: several app sockets plus a
 * studio socket on one actor, hibernation (eviction with sockets kept),
 * restart (eviction with sockets closed), and Studio opened before the actor
 * was spawned by name.
 */

import { env, evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// --- Wire shapes (parsed at the test boundary) ---

const ConnectionSchema = z.object({
  connectionId: z.string().min(1),
  caller: z.string(),
  callerType: z.enum(["user", "service"]),
  connectedAt: z.number(),
  role: z.string().nullable(),
});

const TimelineEntrySchema = z.object({
  id: z.number().int(),
  causeType: z.string(),
  causeData: z.string(),
  stateSnapshot: z.string(),
  createdAt: z.number(),
});

const StudioMessageSchema = z.union([
  z.object({
    type: z.literal("studio.snapshot"),
    state: z.unknown(),
    actorId: z.string(),
    timeline: z.array(TimelineEntrySchema),
    connections: z.array(ConnectionSchema),
  }),
  z.object({ type: z.literal("studio.timeline"), entry: TimelineEntrySchema }),
  z.object({
    type: z.literal("studio.connection"),
    action: z.literal("connect"),
    connection: ConnectionSchema,
  }),
  z.object({
    type: z.literal("studio.connection"),
    action: z.literal("disconnect"),
    connection: z.object({
      connectionId: z.string().min(1),
      caller: z.string(),
      callerType: z.enum(["user", "service"]),
    }),
  }),
]);
type StudioMessage = z.infer<typeof StudioMessageSchema>;

const InspectSchema = z.object({ connections: z.array(ConnectionSchema) });
const TimelineSchema = z.object({ entries: z.array(TimelineEntrySchema) });
const RegistryRowSchema = z.object({ actorType: z.string(), actorId: z.string(), connectionCount: z.number() });

// --- Helpers ---

function counterStub(name: string): DurableObjectStub {
  return env.COUNTER.get(env.COUNTER.idFromName(name));
}

function registryStub(): DurableObjectStub {
  return env.STUDIO_REGISTRY.get(env.STUDIO_REGISTRY.idFromName("registry"));
}

async function openSocket(
  stub: DurableObjectStub,
  callerId: string,
  callerType: "user" | "service",
): Promise<WebSocket> {
  const response = await stub.fetch("http://localhost/ws", {
    headers: {
      Upgrade: "websocket",
      "X-Actor-Kit-Caller-Id": callerId,
      "X-Actor-Kit-Caller-Type": callerType,
    },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket;
  if (ws === null) throw new Error("upgrade returned no WebSocket");
  ws.accept();
  return ws;
}

/** Collects every studio message from the moment the socket opens. */
class StudioObserver {
  readonly messages: StudioMessage[] = [];
  readonly rejected: string[] = [];
  readonly ws: WebSocket;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const parsed = StudioMessageSchema.safeParse(JSON.parse(event.data));
      if (parsed.success) this.messages.push(parsed.data);
      else this.rejected.push(`${event.data.slice(0, 200)} -> ${parsed.error.message.slice(0, 300)}`);
    });
  }

  static async open(stub: DurableObjectStub): Promise<StudioObserver> {
    return new StudioObserver(await openSocket(stub, "__studio", "service"));
  }

  async waitFor<T extends StudioMessage>(
    predicate: (msg: StudioMessage) => msg is T,
    count = 1,
    timeout = 2000,
  ): Promise<T[]> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const found = this.messages.filter(predicate);
      if (found.length >= count) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(
      `Timed out waiting for ${count} matching studio messages; got ${JSON.stringify(this.messages)}; rejected ${JSON.stringify(this.rejected)}`,
    );
  }
}

type Msg<K extends StudioMessage["type"]> = Extract<StudioMessage, { type: K }>;
type ConnectMsg = Msg<"studio.connection"> & { action: "connect" };
type DisconnectMsg = Msg<"studio.connection"> & { action: "disconnect" };

const isSnapshot = (m: StudioMessage): m is Msg<"studio.snapshot"> => m.type === "studio.snapshot";
const isTimeline = (m: StudioMessage): m is Msg<"studio.timeline"> => m.type === "studio.timeline";
const isConnect = (m: StudioMessage): m is ConnectMsg => m.type === "studio.connection" && m.action === "connect";
const isDisconnect = (m: StudioMessage): m is DisconnectMsg =>
  m.type === "studio.connection" && m.action === "disconnect";

async function inspectConnections(stub: DurableObjectStub) {
  const fn: unknown = Reflect.get(stub, "__inspect");
  if (typeof fn !== "function") throw new Error("__inspect missing");
  return InspectSchema.parse(await Reflect.apply(fn, stub, [])).connections;
}

async function timelineIds(stub: DurableObjectStub): Promise<number[]> {
  const fn: unknown = Reflect.get(stub, "__getTimeline");
  if (typeof fn !== "function") throw new Error("__getTimeline missing");
  return TimelineSchema.parse(await Reflect.apply(fn, stub, [{ limit: 100 }])).entries.map((e) => e.id);
}

async function rpc(stub: DurableObjectStub, method: string, ...args: unknown[]): Promise<unknown> {
  const fn: unknown = Reflect.get(stub, method);
  if (typeof fn !== "function") throw new Error(`${method} missing`);
  return Reflect.apply(fn, stub, args);
}

async function registryRows(actorType: string): Promise<Array<z.infer<typeof RegistryRowSchema>>> {
  const rows = await rpc(registryStub(), "listActors", { type: actorType, limit: 1000 });
  return z.array(RegistryRowSchema).parse(rows);
}

async function registryCountFor(actorId: string): Promise<number | undefined> {
  const rows = await registryRows("counter");
  return rows.find((r) => r.actorId === actorId)?.connectionCount;
}

async function eventually(fn: () => Promise<void>, timeout = 2000): Promise<void> {
  const deadline = Date.now() + timeout;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await fn();
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  throw lastErr;
}

async function closeAndSettle(ws: WebSocket): Promise<void> {
  ws.close(1000, "done");
  await new Promise((r) => setTimeout(r, 50));
}

let seq = 0;
function uniqueName(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

// --- Tests ---

describe("Studio live scenarios (integration)", () => {
  it("live timeline entries carry the persisted row id", async () => {
    const actorId = uniqueName("live-id");
    const stub = counterStub(actorId);
    await rpc(stub, "spawn", { actorId, caller: "u1", callerType: "user", input: {} });

    const studio = await StudioObserver.open(stub);
    await studio.waitFor(isSnapshot);
    await rpc(stub, "send", "u1", "user", { type: "INCREMENT", amount: 2 });

    const [live] = await studio.waitFor(isTimeline);
    const ids = await timelineIds(stub);
    expect(live?.entry.id).toBe(ids[0]);

    await closeAndSettle(studio.ws);
  });

  it("several app clients plus Studio: Studio counts exactly the app sockets, same caller included", async () => {
    const actorId = uniqueName("multi-client");
    const stub = counterStub(actorId);
    await rpc(stub, "spawn", { actorId, caller: "u1", callerType: "user", input: {} });

    const studio = await StudioObserver.open(stub);
    await studio.waitFor(isSnapshot);

    // Three app sockets: alice twice (two tabs) and bob once.
    const alice1 = await openSocket(stub, "alice", "user");
    const alice2 = await openSocket(stub, "alice", "user");
    const bob = await openSocket(stub, "bob", "user");

    const connects = await studio.waitFor(isConnect, 3);
    const connectIds = connects.map((c) => c.connection.connectionId);
    expect(new Set(connectIds).size).toBe(3);

    // Studio's own socket is not an app connection.
    expect(await inspectConnections(stub)).toHaveLength(3);
    await eventually(async () => expect(await registryCountFor(actorId)).toBe(3));

    // A second Studio sees the same three connections in its snapshot.
    const studio2 = await StudioObserver.open(stub);
    const [snap] = await studio2.waitFor(isSnapshot);
    expect(snap?.connections.map((c) => c.connectionId).sort()).toEqual([...connectIds].sort());

    // Closing one of alice's tabs leaves her other tab connected.
    await closeAndSettle(alice1);
    const [disconnect] = await studio.waitFor(isDisconnect);
    expect(disconnect?.connection.connectionId).toBe(connects[0]?.connection.connectionId);

    const remaining = await inspectConnections(stub);
    expect(remaining.map((c) => c.caller).sort()).toEqual(["alice", "bob"]);
    await eventually(async () => expect(await registryCountFor(actorId)).toBe(2));

    await closeAndSettle(alice2);
    await closeAndSettle(bob);
    await closeAndSettle(studio.ws);
    await closeAndSettle(studio2.ws);
  });

  it("hibernation: Studio stays live, timeline is continuous, connection counts stay exact", async () => {
    const actorId = uniqueName("hibernate");
    const stub = counterStub(actorId);
    await rpc(stub, "spawn", { actorId, caller: "u1", callerType: "user", input: {} });
    await rpc(stub, "send", "u1", "user", { type: "INCREMENT", amount: 1 });

    const studio = await StudioObserver.open(stub);
    await studio.waitFor(isSnapshot);
    const c1 = await openSocket(stub, "carol", "user");
    const c2 = await openSocket(stub, "dave", "user");
    await studio.waitFor(isConnect, 2);
    const idsBefore = await timelineIds(stub);

    // Hibernate: the instance is torn down, sockets are kept.
    await evictDurableObject(stub);

    await rpc(stub, "send", "u1", "user", { type: "INCREMENT", amount: 1 });
    const live = await studio.waitFor(isTimeline);
    const idsAfter = await timelineIds(stub);
    expect(idsAfter).toHaveLength(idsBefore.length + 1);
    expect(idsAfter.slice(1)).toEqual(idsBefore);
    expect(live[0]?.entry.id).toBe(idsAfter[0]);

    // A client closes after the wake: one connection remains everywhere.
    await closeAndSettle(c1);
    await studio.waitFor(isDisconnect);
    expect((await inspectConnections(stub)).map((c) => c.caller)).toEqual(["dave"]);
    await eventually(async () => expect(await registryCountFor(actorId)).toBe(1));

    await closeAndSettle(c2);
    await closeAndSettle(studio.ws);
  });

  it("hibernation: the first thing after the wake is a client leaving — counts stay exact", async () => {
    const actorId = uniqueName("hibernate-close");
    const stub = counterStub(actorId);
    await rpc(stub, "spawn", { actorId, caller: "u1", callerType: "user", input: {} });
    const studio = await StudioObserver.open(stub);
    await studio.waitFor(isSnapshot);
    const c1 = await openSocket(stub, "gina", "user");
    const c2 = await openSocket(stub, "hank", "user");
    const c3 = await openSocket(stub, "ivan", "user");
    await studio.waitFor(isConnect, 3);
    await eventually(async () => expect(await registryCountFor(actorId)).toBe(3));

    await evictDurableObject(stub);
    await closeAndSettle(c1);

    await studio.waitFor(isDisconnect);
    await eventually(async () => expect(await registryCountFor(actorId)).toBe(2));
    expect((await inspectConnections(stub)).map((c) => c.caller)).toEqual(["hank", "ivan"]);

    await closeAndSettle(c2);
    await closeAndSettle(c3);
    await closeAndSettle(studio.ws);
  });

  it("restart that drops every socket: no stale connections, registry count back to 0", async () => {
    const actorId = uniqueName("restart");
    const stub = counterStub(actorId);
    await rpc(stub, "spawn", { actorId, caller: "u1", callerType: "user", input: {} });
    const c1 = await openSocket(stub, "erin", "user");
    const c2 = await openSocket(stub, "frank", "user");
    expect(await inspectConnections(stub)).toHaveLength(2);
    await eventually(async () => expect(await registryCountFor(actorId)).toBe(2));
    const idsBefore = await timelineIds(stub);

    await evictDurableObject(stub, { webSockets: "close" });
    void c1;
    void c2;

    // Studio reconnects to the restarted actor.
    const studio = await StudioObserver.open(stub);
    const [snap] = await studio.waitFor(isSnapshot);
    expect(snap?.connections).toEqual([]);
    expect(snap?.timeline.map((e) => e.id)).toEqual(idsBefore);
    expect(await inspectConnections(stub)).toEqual([]);
    await eventually(async () => expect(await registryCountFor(actorId)).toBe(0));

    await closeAndSettle(studio.ws);
  });

  it("actor auto-spawned under its hex ID, then spawned by name: one registry entry, under the name", async () => {
    const actorId = uniqueName("before-exists");
    const stub = counterStub(actorId);
    const hexId = env.COUNTER.idFromName(actorId).toString();

    // An RPC reaches the DO before the app spawned it by name: auto-spawn
    // registers it under its hex DO ID. (Studio itself no longer does this
    // once the middleware 404s unknown actors; any other RPC still can.)
    await rpc(stub, "getSnapshot", "early-bird", "user");
    const studio = await StudioObserver.open(stub);
    const [snap] = await studio.waitFor(isSnapshot);
    expect(snap?.connections).toEqual([]);

    // The app creates the actor by name, then sends a message.
    await rpc(stub, "spawn", { actorId, caller: "u1", callerType: "user", input: {} });
    await rpc(stub, "send", "u1", "user", { type: "INCREMENT", amount: 4 });
    const [live] = await studio.waitFor(isTimeline);
    expect(JSON.parse(live?.entry.stateSnapshot ?? "null")).toEqual({ count: 4, lastCaller: "u1" });

    await eventually(async () => {
      const ids = (await registryRows("counter")).map((r) => r.actorId);
      expect(ids).toContain(actorId);
      expect(ids).not.toContain(hexId);
    });

    await closeAndSettle(studio.ws);
  });
});
