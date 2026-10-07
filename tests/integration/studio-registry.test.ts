import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * StudioRegistry DO — every registry flow, exercised through its real RPC surface.
 *
 * Direct registry tests use a private registry instance per test (idFromName(unique)),
 * so they never see rows written by other tests. Actor-integrated tests use the
 * singleton "registry" instance the runtime resolves, and filter by their own unique IDs.
 */

const ActorEntry = z.object({
  actorType: z.string(),
  actorId: z.string(),
  lastActiveAt: z.number(),
  version: z.number().nullable(),
  connectionCount: z.number(),
});
const ActorEntries = z.array(ActorEntry);
type ActorEntry = z.infer<typeof ActorEntry>;

let registryCounter = 0;
function freshRegistry() {
  registryCounter += 1;
  return env.STUDIO_REGISTRY.get(env.STUDIO_REGISTRY.idFromName(`registry-test-${Date.now()}-${registryCounter}`));
}

function singletonRegistry() {
  return env.STUDIO_REGISTRY.get(env.STUDIO_REGISTRY.idFromName("registry"));
}

type ListOpts = { type?: string; search?: string; limit?: number; offset?: number };

async function list(registry: ReturnType<typeof freshRegistry>, opts: ListOpts = {}): Promise<ActorEntry[]> {
  return ActorEntries.parse(await registry.listActors(opts));
}

async function ids(registry: ReturnType<typeof freshRegistry>, opts: ListOpts = {}): Promise<string[]> {
  return (await list(registry, opts)).map((a) => a.actorId);
}

function tick(ms = 20) {
  return new Promise((r) => setTimeout(r, ms));
}

async function rowsFor(actorIds: string[]): Promise<ActorEntry[]> {
  const all = await list(singletonRegistry(), { limit: 10_000 });
  return all.filter((a) => actorIds.includes(a.actorId));
}

/** Poll the singleton registry until `predicate` holds (fire-and-forget RPCs land asynchronously). */
async function eventually(fn: () => Promise<void>, timeout = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      await fn();
      return;
    } catch (err) {
      if (Date.now() - start > timeout) throw err;
      await tick(25);
    }
  }
}

function connectWs(stub: DurableObjectStub, actorId: string, callerId: string) {
  return stub.fetch(`http://localhost/api/counter/${actorId}`, {
    headers: {
      Upgrade: "websocket",
      "X-Actor-Kit-Caller-Id": callerId,
      "X-Actor-Kit-Caller-Type": "user",
    },
  });
}

async function openSocket(stub: DurableObjectStub, actorId: string, callerId: string): Promise<WebSocket> {
  const res = await connectWs(stub, actorId, callerId);
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (ws === null) throw new Error("no webSocket on 101 response");
  ws.accept();
  return ws;
}

describe("StudioRegistry: registration", () => {
  it("touch() registers an actor with its version and zero connections", async () => {
    const registry = freshRegistry();
    const before = Date.now();
    await registry.touch("counter", "a-1", 3);

    const rows = await list(registry);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: "counter", actorId: "a-1", version: 3, connectionCount: 0 });
    expect(rows[0]?.lastActiveAt).toBeGreaterThanOrEqual(before);
  });

  it("re-registering an existing actor updates the row instead of duplicating it", async () => {
    const registry = freshRegistry();
    await registry.touch("counter", "a-1", 1);
    const first = (await list(registry))[0];
    await tick(5);
    await registry.touch("counter", "a-1", 2);

    const rows = await list(registry);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe(2);
    expect(rows[0]?.lastActiveAt).toBeGreaterThan(first?.lastActiveAt ?? Number.POSITIVE_INFINITY);
  });

  it("the same actor ID under two actor types is two distinct rows", async () => {
    const registry = freshRegistry();
    await registry.touch("counter", "shared", 1);
    await registry.touch("chat", "shared", 1);
    expect((await list(registry)).map((a) => a.actorType).sort()).toEqual(["chat", "counter"]);
  });

  it("re-touching keeps the connection count", async () => {
    const registry = freshRegistry();
    await registry.touch("counter", "a-1", 1);
    await registry.updateConnections("counter", "a-1", 2);
    await registry.touch("counter", "a-1", 1);
    expect((await list(registry))[0]?.connectionCount).toBe(2);
  });

  it("drops malformed registration input instead of storing it", async () => {
    // Fire-and-forget from actors: invalid input is ignored, never thrown back at the caller.
    const registry = freshRegistry();
    await registry.touch("", "a-1", 1);
    await registry.touch("counter", "", 1);
    await registry.touch("counter", "a-1", 1.5);
    expect(await list(registry)).toEqual([]);
  });

  it("re-registration under a new ID with previousActorId replaces the old row, keeping its connections", async () => {
    const registry = freshRegistry();
    await registry.touch("counter", "hex-id", 1);
    await registry.updateConnections("counter", "hex-id", 2);
    await registry.touch("counter", "nice-name", 1, "hex-id");

    const rows = await list(registry);
    expect(rows.map((a) => a.actorId)).toEqual(["nice-name"]);
    expect(rows[0]?.connectionCount).toBe(2);
  });
});

describe("StudioRegistry: connection counts", () => {
  it("updateConnections sets the count and bumps last activity", async () => {
    const registry = freshRegistry();
    await registry.touch("counter", "a-1", 1);
    const t0 = (await list(registry))[0]?.lastActiveAt ?? 0;
    await tick(5);
    await registry.updateConnections("counter", "a-1", 3);
    let row = (await list(registry))[0];
    expect(row?.connectionCount).toBe(3);
    expect(row?.lastActiveAt).toBeGreaterThan(t0);

    await registry.updateConnections("counter", "a-1", 0);
    row = (await list(registry))[0];
    expect(row?.connectionCount).toBe(0);
  });

  it("a connection update for an actor not yet registered is not lost", async () => {
    // Actors persisted before Studio was enabled only touch() on their next state change,
    // but their first WebSocket connect reports a count right away.
    const registry = freshRegistry();
    await registry.updateConnections("counter", "pre-existing", 1);
    await registry.touch("counter", "pre-existing", 1);
    const rows = await list(registry);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.connectionCount).toBe(1);
  });

  it("never stores a negative or non-integer count", async () => {
    const registry = freshRegistry();
    await registry.touch("counter", "a-1", 1);
    await registry.updateConnections("counter", "a-1", 2);
    await registry.updateConnections("counter", "a-1", -1);
    await registry.updateConnections("counter", "a-1", 1.5);
    await registry.updateConnections("counter", "a-1", Number.NaN);
    expect((await list(registry))[0]?.connectionCount).toBe(2);
  });
});

describe("StudioRegistry: listing", () => {
  async function seeded() {
    const registry = freshRegistry();
    await registry.touch("counter", "Alpha-Room", 1);
    await tick(3);
    await registry.touch("counter", "beta_room", 1);
    await tick(3);
    await registry.touch("chat", "gamma%room", 1);
    await tick(3);
    await registry.touch("chat", "delta's room", 1);
    await tick(3);
    await registry.touch("chat", "betaXroom", 1);
    return registry;
  }

  it("lists newest first", async () => {
    const registry = await seeded();
    expect(await ids(registry)).toEqual(["betaXroom", "delta's room", "gamma%room", "beta_room", "Alpha-Room"]);
  });

  it("filters by type (exact match)", async () => {
    const registry = await seeded();
    expect(await ids(registry, { type: "counter" })).toEqual(["beta_room", "Alpha-Room"]);
    expect(await ids(registry, { type: "Counter" })).toEqual([]);
    expect(await ids(registry, { type: "coun%" })).toEqual([]);
  });

  it("search matches partial IDs, case-insensitively", async () => {
    const registry = await seeded();
    expect(await ids(registry, { search: "alpha" })).toEqual(["Alpha-Room"]);
    expect(await ids(registry, { search: "ROOM" })).toHaveLength(5);
  });

  it("search treats % and _ literally, not as LIKE wildcards", async () => {
    const registry = await seeded();
    expect(await ids(registry, { search: "_" })).toEqual(["beta_room"]);
    expect(await ids(registry, { search: "beta_" })).toEqual(["beta_room"]);
    expect(await ids(registry, { search: "%" })).toEqual(["gamma%room"]);
    expect(await ids(registry, { search: "\\" })).toEqual([]);
  });

  it("search with quotes and SQL fragments is matched as text", async () => {
    const registry = await seeded();
    expect(await ids(registry, { search: "'" })).toEqual(["delta's room"]);
    expect(await ids(registry, { search: "' OR 1=1 --" })).toEqual([]);
    expect(await ids(registry, { search: '"); DROP TABLE actors; --' })).toEqual([]);
    expect(await ids(registry)).toHaveLength(5);
  });

  it("combines type and search", async () => {
    const registry = await seeded();
    expect(await ids(registry, { type: "chat", search: "beta" })).toEqual(["betaXroom"]);
  });

  it("empty search matches everything", async () => {
    const registry = await seeded();
    expect(await ids(registry, { search: "" })).toHaveLength(5);
  });

  it("limit and offset page through results", async () => {
    const registry = await seeded();
    expect(await ids(registry, { limit: 2 })).toEqual(["betaXroom", "delta's room"]);
    expect(await ids(registry, { limit: 2, offset: 2 })).toEqual(["gamma%room", "beta_room"]);
    expect(await ids(registry, { limit: 2, offset: 4 })).toEqual(["Alpha-Room"]);
    expect(await ids(registry, { limit: 2, offset: 100 })).toEqual([]);
  });

  it("limit 0 returns no rows", async () => {
    const registry = await seeded();
    expect(await ids(registry, { limit: 0 })).toEqual([]);
  });

  it("a huge limit returns every row", async () => {
    const registry = freshRegistry();
    for (let i = 0; i < 3; i++) await registry.touch("counter", `a-${i}`, 1);
    expect(await ids(registry, { limit: Number.MAX_SAFE_INTEGER })).toHaveLength(3);
  });

  it("defaults to 50 rows", async () => {
    const registry = freshRegistry();
    for (let i = 0; i < 55; i++) await registry.touch("counter", `a-${i}`, 1);
    expect(await ids(registry)).toHaveLength(50);
  });

  it("ordering is stable across pages when timestamps tie", async () => {
    const registry = freshRegistry();
    const all = Array.from({ length: 12 }, (_, i) => `same-ms-${String(i).padStart(2, "0")}`);
    // Same timestamp for every row: only a tiebreaker keeps pages disjoint.
    await Promise.all([...all].reverse().map((id) => registry.touch("counter", id, 1)));
    await runInDurableObject(registry, (_instance, state) => {
      state.storage.sql.exec("UPDATE actors SET last_active_at = 1000");
    });

    const pages: string[] = [];
    for (let offset = 0; offset < all.length; offset += 5) {
      pages.push(...(await ids(registry, { limit: 5, offset })));
    }
    expect(pages).toEqual(all);
    expect(await ids(registry, { limit: 100 })).toEqual(pages);
  });

  it("getActorTypes lists distinct types alphabetically", async () => {
    const registry = await seeded();
    expect(await registry.getActorTypes()).toEqual(["chat", "counter"]);
    expect(await freshRegistry().getActorTypes()).toEqual([]);
  });
});

describe("StudioRegistry: concurrency and restarts", () => {
  it("many actors registering at the same time all land", async () => {
    const registry = freshRegistry();
    const names = Array.from({ length: 25 }, (_, i) => `c-${i}`);
    await Promise.all(names.map((n) => registry.touch("counter", n, 1)));
    expect((await ids(registry, { limit: 100 })).sort()).toEqual([...names].sort());
  });

  it("the same actor registering from two stubs at once yields one row", async () => {
    const id = env.STUDIO_REGISTRY.idFromName(`registry-dup-${Date.now()}`);
    const a = env.STUDIO_REGISTRY.get(id);
    const b = env.STUDIO_REGISTRY.get(id);
    await Promise.all([a.touch("counter", "x", 1), b.touch("counter", "x", 1), a.updateConnections("counter", "x", 1)]);
    const rows = await list(a);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.connectionCount).toBe(1);
  });

  it("rows survive a registry instance restart (fresh in-memory state)", async () => {
    const registry = freshRegistry();
    await registry.touch("counter", "persisted", 1);
    // Simulate eviction: the migration flag lives in memory only.
    await runInDurableObject(registry, (instance) => {
      Reflect.set(instance, "migrated", false);
    });
    expect(await ids(registry)).toEqual(["persisted"]);
  });
});

describe("StudioRegistry: driven by real actors", () => {
  it("an actor registers on first activity", async () => {
    const actorId = `reg-first-${Date.now()}`;
    const stub = env.COUNTER.get(env.COUNTER.idFromName(actorId));
    await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });
    await eventually(async () => {
      const rows = await rowsFor([actorId]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorType: "counter", version: 1 });
    });
  });

  it("a burst of messages coalesces into one row", async () => {
    const actorId = `reg-burst-${Date.now()}`;
    const stub = env.COUNTER.get(env.COUNTER.idFromName(actorId));
    await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });
    for (let i = 0; i < 10; i++) await stub.send("user-1", "user", { type: "INCREMENT", amount: 1 });
    await eventually(async () => {
      expect(await rowsFor([actorId])).toHaveLength(1);
    });
  });

  it("naming an auto-spawned actor via spawn() leaves no row under its hex ID", async () => {
    const actorId = `reg-rename-${Date.now()}`;
    const doId = env.COUNTER.idFromName(actorId);
    const stub = env.COUNTER.get(doId);
    const hexId = doId.toString();

    await stub.getSnapshot("user-1", "user"); // auto-spawn under the hex ID
    await eventually(async () => {
      expect((await rowsFor([hexId])).length).toBe(1);
    });

    await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });
    await eventually(async () => {
      const rows = await rowsFor([hexId, actorId]);
      expect(rows.map((r) => r.actorId)).toEqual([actorId]);
    });
  });

  it("connection counts follow connects and disconnects", async () => {
    const actorId = `reg-conn-${Date.now()}`;
    const stub = env.COUNTER.get(env.COUNTER.idFromName(actorId));
    await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });

    const expectCount = (n: number) =>
      eventually(async () => {
        expect((await rowsFor([actorId]))[0]?.connectionCount).toBe(n);
      });

    const ws1 = await openSocket(stub, actorId, "user-1");
    await expectCount(1);
    const ws2 = await openSocket(stub, actorId, "user-2");
    await expectCount(2);
    ws1.close(1000, "done");
    await expectCount(1);
    ws2.close(1000, "done");
    await expectCount(0);
  });

  it("connection counts stay correct after the actor wakes from hibernation", async () => {
    const actorId = `reg-hib-${Date.now()}`;
    const stub = env.COUNTER.get(env.COUNTER.idFromName(actorId));
    await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });

    const expectCount = (n: number) =>
      eventually(async () => {
        expect((await rowsFor([actorId]))[0]?.connectionCount).toBe(n);
      });

    const ws1 = await openSocket(stub, actorId, "user-1");
    const ws2 = await openSocket(stub, actorId, "user-2");
    await expectCount(2);

    // Hibernation wake: sockets survive, the in-memory connection map does not.
    await runInDurableObject(stub, (instance) => {
      const connections: unknown = Reflect.get(instance, "connections");
      if (!(connections instanceof Map)) throw new Error("expected connections map");
      connections.clear();
    });

    const ws3 = await openSocket(stub, actorId, "user-3");
    await expectCount(3);
    ws1.close(1000, "done");
    await expectCount(2);
    ws2.close(1000, "done");
    ws3.close(1000, "done");
    await expectCount(0);
  });
});
