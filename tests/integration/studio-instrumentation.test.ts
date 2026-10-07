/**
 * Actor-side studio instrumentation: timeline retention + causes, __getTimeline
 * pagination, __studio role bypass, hibernation survival, studio.requestView,
 * and the studio-disabled opt-out.
 *
 * "Restart" and "hibernation wake" are simulated by constructing a fresh actor
 * instance on the same DurableObjectState inside runInDurableObject(): storage
 * and accepted WebSockets survive, every in-memory field starts empty — which is
 * exactly what the runtime does after eviction/hibernation.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PROBE_TIMELINE_SIZE, PROBE_VERSION, StudioProbe } from "./src/studio-probe";
import { Counter } from "./src/worker";

// --- Boundary schemas (parse everything that comes back from the DO) ---

const TimelineEntrySchema = z.object({
  id: z.number().int().positive(),
  causeType: z.string(),
  causeData: z.string(),
  stateSnapshot: z.string(),
  checksum: z.string().min(1),
  createdAt: z.number().int().positive(),
});
type TimelineEntry = z.infer<typeof TimelineEntrySchema>;

const TimelinePageSchema = z.object({ entries: z.array(TimelineEntrySchema), hasMore: z.boolean() });

const ProbeStateSchema = z.object({
  owner: z.string(),
  count: z.number(),
  connects: z.number(),
  disconnects: z.number(),
  lastResult: z.string(),
  migratedFrom: z.number(),
});

const ConnectionSchema = z.object({
  caller: z.string(),
  callerType: z.enum(["user", "service"]),
  connectedAt: z.number(),
  role: z.string().nullable(),
});

const InspectSchema = z.object({
  state: z.unknown(),
  version: z.number(),
  actorId: z.string().nullable(),
  connections: z.array(ConnectionSchema),
});

const CauseSchemas = {
  init: z.object({}).strict(),
  migrate: z.object({ fromVersion: z.number(), toVersion: z.number() }).strict(),
  message: z
    .object({
      messageType: z.string(),
      caller: z.string(),
      callerType: z.enum(["user", "service"]),
      role: z.string(),
      payload: z.unknown(),
    })
    .strict(),
  "lifecycle.connect": z
    .object({ caller: z.string(), callerType: z.enum(["user", "service"]), role: z.string() })
    .strict(),
  "lifecycle.disconnect": z
    .object({ caller: z.string(), callerType: z.enum(["user", "service"]), role: z.string() })
    .strict(),
  "service.onDone": z.object({ service: z.string(), input: z.unknown(), result: z.unknown() }).strict(),
  "service.onError": z.object({ service: z.string(), input: z.unknown(), error: z.string() }).strict(),
};

const StudioMessageSchema = z.object({ type: z.string() }).passthrough();
const StudioTimelineMsgSchema = z.object({ type: z.literal("studio.timeline"), entry: TimelineEntrySchema });
const StudioConnectionMsgSchema = z.object({
  type: z.literal("studio.connection"),
  action: z.enum(["connect", "disconnect"]),
  connection: z.object({ caller: z.string(), callerType: z.enum(["user", "service"]) }).passthrough(),
});
const StudioViewMsgSchema = z.object({
  type: z.literal("studio.view"),
  role: z.string().optional(),
  caller: z.string().nullable().optional(),
  callerRole: z.string().nullable().optional(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});
const StudioErrorMsgSchema = z.object({ type: z.literal("studio.error"), error: z.string() });

const RegistryEntrySchema = z.object({ actorType: z.string(), actorId: z.string(), connectionCount: z.number() });

// --- Helpers ---

let seq = 0;
function uniqueName(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

function probe(name: string) {
  return env.STUDIO_PROBE.get(env.STUDIO_PROBE.idFromName(name));
}

async function spawnProbe(name: string) {
  const stub = probe(name);
  await stub.spawn({ actorId: name, caller: "svc", callerType: "service", input: { owner: "member-owner" } });
  return stub;
}

async function timeline(stub: { __getTimeline(opts?: unknown): Promise<unknown> }, opts?: unknown) {
  return TimelinePageSchema.parse(await stub.__getTimeline(opts));
}

async function inspect(stub: { __inspect(): Promise<unknown> }) {
  return InspectSchema.parse(await stub.__inspect());
}

async function probeState(stub: { __inspect(): Promise<unknown> }) {
  return ProbeStateSchema.parse((await inspect(stub)).state);
}

/** Collects every string frame a client-side WebSocket receives. */
class Inbox {
  readonly frames: string[] = [];
  private waiters: Array<() => void> = [];
  constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") this.frames.push(event.data);
      for (const w of this.waiters) w();
    });
  }

  messages(): Array<z.infer<typeof StudioMessageSchema>> {
    return this.frames.map((f) => StudioMessageSchema.parse(JSON.parse(f)));
  }

  /** Wait for the first frame (at or after index `from`) matching the predicate. */
  async next(predicate: (msg: z.infer<typeof StudioMessageSchema>) => boolean, from = 0, timeout = 2000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const found = this.messages().slice(from).find(predicate);
      if (found !== undefined) return found;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timeout waiting for frame; got ${JSON.stringify(this.frames)}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

type Fetchable = { fetch(input: string, init?: RequestInit): Promise<Response> };

async function connect(stub: Fetchable, caller: string, callerType: "user" | "service" = "user") {
  const res = await stub.fetch("http://localhost/ws", {
    headers: { Upgrade: "websocket", "X-Actor-Kit-Caller-Id": caller, "X-Actor-Kit-Caller-Type": callerType },
  });
  const ws = res.webSocket;
  if (ws === null) throw new Error(`upgrade failed for ${caller}: ${res.status}`);
  ws.accept();
  return new Inbox(ws);
}

async function connectStudio(stub: Fetchable) {
  const inbox = await connect(stub, "__studio", "service");
  await inbox.next((m) => m.type === "studio.snapshot");
  return inbox;
}

async function closeAndSettle(inbox: Inbox) {
  inbox.ws.close(1000, "done");
  await settle();
}

/** Settle an RPC call that is expected to fail and return its error message ("" if it resolved). */
async function rpcError(call: Promise<unknown>): Promise<string> {
  try {
    await call;
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function settle(ms = 50) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeout = 2000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > deadline) return v;
    await settle(10);
  }
}

function newest(page: z.infer<typeof TimelinePageSchema>): TimelineEntry {
  const entry = page.entries[0];
  if (entry === undefined) throw new Error("timeline is empty");
  return entry;
}

function cause<K extends keyof typeof CauseSchemas>(entry: TimelineEntry, type: K) {
  expect(entry.causeType).toBe(type);
  return CauseSchemas[type].parse(JSON.parse(entry.causeData));
}

async function registryEntry(actorType: string, actorId: string) {
  const registry = env.STUDIO_REGISTRY.get(env.STUDIO_REGISTRY.idFromName("registry"));
  const rows = z.array(RegistryEntrySchema).parse(await registry.listActors({ type: actorType, search: actorId }));
  return rows.find((r) => r.actorId === actorId);
}

// --- Timeline retention ---

describe("timeline retention", () => {
  it("caps at timelineSize and evicts the oldest entries first", async () => {
    const name = uniqueName("retention");
    const stub = await spawnProbe(name);
    for (let i = 1; i <= 7; i++) {
      await stub.send("member-1", "user", { type: "INCREMENT", amount: 1 });
    }

    const page = await timeline(stub, { limit: 100 });
    expect(page.entries).toHaveLength(PROBE_TIMELINE_SIZE);
    // init + 7 messages = ids 1..8; the 5 newest (8..4) survive, newest first.
    expect(page.entries.map((e) => e.id)).toEqual([8, 7, 6, 5, 4]);
    expect(page.entries.map((e) => ProbeStateSchema.parse(JSON.parse(e.stateSnapshot)).count)).toEqual([7, 6, 5, 4, 3]);
    expect(page.entries.every((e) => e.causeType === "message")).toBe(true);
  });

  it("survives a restart (SQLite) and keeps capping afterwards", async () => {
    const name = uniqueName("retention-restart");
    const stub = await spawnProbe(name);
    for (let i = 0; i < 3; i++) await stub.send("member-1", "user", { type: "INCREMENT", amount: 1 });
    const before = await timeline(stub);

    const after = await runInDurableObject(stub, async (_instance, state) => {
      const fresh = new StudioProbe(state, env);
      const restored = TimelinePageSchema.parse(await fresh.__getTimeline());
      for (let i = 0; i < 4; i++) await fresh.send("member-1", "user", { type: "INCREMENT", amount: 1 });
      const capped = TimelinePageSchema.parse(await fresh.__getTimeline({ limit: 100 }));
      return { restored, capped };
    });

    expect(after.restored).toEqual(before);
    expect(after.capped.entries).toHaveLength(PROBE_TIMELINE_SIZE);
    expect(after.capped.entries.map((e) => e.id)).toEqual([8, 7, 6, 5, 4]);
  });

  it("rejects a non-positive timelineSize at definition time", async () => {
    const { actor } = await import("@actor-kit/worker");
    const def = {
      input: z.object({}),
      init: () => ({}),
      roles: { user: () => true },
      views: {},
    };
    expect(() => actor("bad-size", { ...def, studio: { timelineSize: 0 } })).toThrow(/timelineSize/);
    expect(() => actor("bad-size", { ...def, studio: { timelineSize: -1 } })).toThrow(/timelineSize/);
    expect(() => actor("bad-size", { ...def, studio: { timelineSize: 2.5 } })).toThrow(/timelineSize/);
  });
});

// --- Timeline causes ---

describe("timeline causes are well-formed", () => {
  it("init", async () => {
    const stub = await spawnProbe(uniqueName("cause-init"));
    const entry = newest(await timeline(stub));
    expect(cause(entry, "init")).toEqual({});
    expect(ProbeStateSchema.parse(JSON.parse(entry.stateSnapshot)).owner).toBe("member-owner");
  });

  it("message", async () => {
    const stub = await spawnProbe(uniqueName("cause-message"));
    await stub.send("member-1", "user", { type: "INCREMENT", amount: 4 });
    expect(cause(newest(await timeline(stub)), "message")).toEqual({
      messageType: "INCREMENT",
      caller: "member-1",
      callerType: "user",
      role: "member",
      payload: { amount: 4 },
    });
  });

  it("rejected messages do not produce an entry", async () => {
    const stub = await spawnProbe(uniqueName("cause-rejected"));
    const before = await timeline(stub);
    const result = await stub.send("member-1", "user", { type: "INCREMENT", amount: -1 });
    expect(result.ok).toBe(false);
    expect(await timeline(stub)).toEqual(before);
  });

  it("lifecycle.connect and lifecycle.disconnect", async () => {
    const stub = await spawnProbe(uniqueName("cause-lifecycle"));
    const client = await connect(stub, "member-1");
    await client.next((m) => m.type === "snapshot");

    const connectEntry = newest(await timeline(stub));
    expect(cause(connectEntry, "lifecycle.connect")).toEqual({
      caller: "member-1",
      callerType: "user",
      role: "member",
    });
    expect(ProbeStateSchema.parse(JSON.parse(connectEntry.stateSnapshot)).connects).toBe(1);

    await closeAndSettle(client);
    const disconnectEntry = newest(
      await waitFor(
        () => timeline(stub),
        (p) => newest(p).id > connectEntry.id,
      ),
    );
    expect(cause(disconnectEntry, "lifecycle.disconnect")).toEqual({
      caller: "member-1",
      callerType: "user",
      role: "member",
    });
    expect(ProbeStateSchema.parse(JSON.parse(disconnectEntry.stateSnapshot)).disconnects).toBe(1);
  });

  it("service.onDone", async () => {
    const stub = await spawnProbe(uniqueName("cause-ondone"));
    await stub.send("member-1", "user", { type: "RUN_OK", tag: "a" });
    const page = await waitFor(
      () => timeline(stub),
      (p) => newest(p).causeType === "service.onDone",
    );
    const entry = newest(page);
    expect(cause(entry, "service.onDone")).toEqual({
      service: "OK_SVC",
      input: { tag: "a" },
      result: { echoed: "a" },
    });
    expect(ProbeStateSchema.parse(JSON.parse(entry.stateSnapshot)).lastResult).toBe("done:a");
  });

  it("service.onError", async () => {
    const stub = await spawnProbe(uniqueName("cause-onerror"));
    await stub.send("member-1", "user", { type: "RUN_FAIL", tag: "b" });
    const page = await waitFor(
      () => timeline(stub),
      (p) => newest(p).causeType === "service.onError",
    );
    const entry = newest(page);
    expect(cause(entry, "service.onError")).toEqual({
      service: "FAIL_SVC",
      input: { tag: "b" },
      error: "boom:b",
    });
  });

  it("migrate: loading an older persisted version records a migrate entry and persists the result", async () => {
    const name = uniqueName("cause-migrate");
    const stub = await spawnProbe(name);

    const result = await runInDurableObject(stub, async (_instance, state) => {
      // Overwrite with a v1 snapshot as an older deploy would have written it.
      state.storage.sql.exec(
        "INSERT OR REPLACE INTO snapshots (id, version, state, state_tracker, actor_id, checksum, updated_at) VALUES (1, 1, ?, NULL, ?, 'old', 1)",
        JSON.stringify({ owner: "member-owner", count: 9 }),
        name,
      );
      const fresh = new StudioProbe(state, env);
      const page = TimelinePageSchema.parse(await fresh.__getTimeline());
      const row = state.storage.sql.exec("SELECT version, state FROM snapshots WHERE id = 1").one();
      return { page, persistedVersion: row["version"], persistedState: row["state"] };
    });

    const entry = newest(result.page);
    expect(cause(entry, "migrate")).toEqual({ fromVersion: 1, toVersion: PROBE_VERSION });
    const migrated = ProbeStateSchema.parse(JSON.parse(entry.stateSnapshot));
    expect(migrated).toMatchObject({ count: 9, migratedFrom: 1 });
    expect(result.persistedVersion).toBe(PROBE_VERSION);
    expect(ProbeStateSchema.parse(JSON.parse(z.string().parse(result.persistedState))).migratedFrom).toBe(1);
  });

  it("live studio.timeline pushes carry the entry id (same shape as __getTimeline)", async () => {
    const stub = await spawnProbe(uniqueName("cause-live-id"));
    const studio = await connectStudio(stub);
    const from = studio.frames.length;

    await stub.send("member-1", "user", { type: "INCREMENT", amount: 2 });
    const pushed = StudioTimelineMsgSchema.parse(await studio.next((m) => m.type === "studio.timeline", from));

    expect(pushed.entry).toEqual(newest(await timeline(stub)));
    await closeAndSettle(studio);
  });
});

// --- __getTimeline pagination ---

describe("__getTimeline pagination", () => {
  async function counterWith(entries: number) {
    const name = uniqueName("page");
    const stub = env.COUNTER.get(env.COUNTER.idFromName(name));
    await stub.spawn({ actorId: name, caller: "u", callerType: "user", input: {} });
    for (let i = 1; i < entries; i++) await stub.send("u", "user", { type: "INCREMENT", amount: 1 });
    return stub;
  }

  it("walks every entry exactly once with the before cursor (exclusive), even with equal timestamps", async () => {
    const stub = await counterWith(13);
    // Force every entry onto the same millisecond: the cursor must not depend on created_at.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE timeline SET created_at = 1700000000000");
    });

    const all = await timeline(stub, { limit: 100 });
    expect(all.entries).toHaveLength(13);

    const walked: number[] = [];
    const hasMores: boolean[] = [];
    let before: number | undefined;
    for (;;) {
      const page = await timeline(stub, before === undefined ? { limit: 4 } : { limit: 4, before });
      walked.push(...page.entries.map((e) => e.id));
      hasMores.push(page.hasMore);
      const last = page.entries[page.entries.length - 1];
      if (!page.hasMore || last === undefined) break;
      before = last.id;
    }

    expect(walked).toEqual(all.entries.map((e) => e.id));
    expect(new Set(walked).size).toBe(walked.length);
    expect(hasMores).toEqual([true, true, true, false]);
  });

  it("hasMore is false when the page ends exactly at the oldest entry", async () => {
    const stub = await counterWith(6);
    const first = await timeline(stub, { limit: 3 });
    expect(first.hasMore).toBe(true);
    const second = await timeline(stub, { limit: 3, before: first.entries[2]?.id });
    expect(second.entries).toHaveLength(3);
    expect(second.hasMore).toBe(false);
  });

  it("defaults to 50 entries", async () => {
    const stub = await counterWith(55);
    const page = await timeline(stub);
    expect(page.entries).toHaveLength(50);
    expect(page.hasMore).toBe(true);
  });

  it("a cursor at or past the start returns an empty page", async () => {
    const stub = await counterWith(3);
    const all = await timeline(stub);
    const oldest = all.entries[all.entries.length - 1];
    expect(await timeline(stub, { before: oldest?.id })).toEqual({ entries: [], hasMore: false });
    expect(await timeline(stub, { before: 1 })).toEqual({ entries: [], hasMore: false });
  });

  it("a cursor beyond the newest entry returns from the top", async () => {
    const stub = await counterWith(3);
    expect(await timeline(stub, { before: 1_000_000 })).toEqual(await timeline(stub));
  });

  it("an actor that has never been spawned has an empty timeline", async () => {
    const stub = probe(uniqueName("page-empty"));
    expect(await timeline(stub)).toEqual({ entries: [], hasMore: false });
  });

  it.each([
    ["limit 0", { limit: 0 }],
    ["negative limit", { limit: -5 }],
    ["fractional limit", { limit: 1.5 }],
    ["NaN limit", { limit: Number.NaN }],
    ["NaN before", { before: Number.NaN }],
    ["string before", { before: "abc" }],
    ["negative before", { before: -1 }],
    ["non-object opts", "limit=5"],
  ])("rejects invalid options: %s", async (_label, opts) => {
    const stub = await counterWith(8);
    expect(await rpcError(stub.__getTimeline(opts))).toMatch(/Invalid timeline options/);
  });
});

// --- __studio role bypass ---

describe("__studio role bypass", () => {
  it("studio sockets are not connections, do not fire lifecycle hooks, and do not count in the registry", async () => {
    const name = uniqueName("bypass");
    const stub = await spawnProbe(name);
    const studio = await connectStudio(stub);

    expect((await inspect(stub)).connections).toEqual([]);
    expect(await probeState(stub)).toMatchObject({ connects: 0, disconnects: 0 });
    await settle(100);
    expect((await registryEntry("studio-probe", name))?.connectionCount).toBe(0);

    await closeAndSettle(studio);
    expect(await probeState(stub)).toMatchObject({ connects: 0, disconnects: 0 });
    // No lifecycle timeline entries either.
    const causes = (await timeline(stub)).entries.map((e) => e.causeType);
    expect(causes).not.toContain("lifecycle.connect");
    expect(causes).not.toContain("lifecycle.disconnect");
  });

  it("studio snapshot lists app connections but never the studio itself", async () => {
    const stub = await spawnProbe(uniqueName("bypass-snapshot"));
    const studioA = await connectStudio(stub);
    const client = await connect(stub, "member-1");
    await client.next((m) => m.type === "snapshot");

    const studioB = await connect(stub, "__studio", "service");
    const snap = z
      .object({ type: z.literal("studio.snapshot"), connections: z.array(ConnectionSchema) })
      .passthrough()
      .parse(await studioB.next((m) => m.type === "studio.snapshot"));
    expect(snap.connections.map((c) => c.caller)).toEqual(["member-1"]);
    expect((await inspect(stub)).connections.map((c) => c.caller)).toEqual(["member-1"]);

    await closeAndSettle(client);
    await closeAndSettle(studioA);
    await closeAndSettle(studioB);
  });

  it("studio sockets cannot send app messages", async () => {
    const stub = await spawnProbe(uniqueName("bypass-send"));
    const studio = await connectStudio(stub);
    const before = await timeline(stub);
    const from = studio.frames.length;

    studio.ws.send(JSON.stringify({ type: "INCREMENT", amount: 5 }));
    const reply = StudioErrorMsgSchema.parse(await studio.next((m) => m.type === "studio.error", from));
    expect(reply.error).toMatch(/INCREMENT/);

    expect((await probeState(stub)).count).toBe(0);
    expect(await timeline(stub)).toEqual(before);
    await closeAndSettle(studio);
  });

  it("studio sockets receive no app view projections", async () => {
    const stub = await spawnProbe(uniqueName("bypass-views"));
    const studio = await connectStudio(stub);
    await stub.send("member-1", "user", { type: "INCREMENT", amount: 1 });
    await studio.next((m) => m.type === "studio.timeline");
    expect(studio.messages().every((m) => m.type.startsWith("studio."))).toBe(true);
    await closeAndSettle(studio);
  });

  it("the reserved __studio caller id is rejected for user callers", async () => {
    const stub = await spawnProbe(uniqueName("bypass-reserved"));
    const res = await stub.fetch("http://localhost/ws", {
      headers: { Upgrade: "websocket", "X-Actor-Kit-Caller-Id": "__studio", "X-Actor-Kit-Caller-Type": "user" },
    });
    expect(res.status).toBe(403);
    expect(res.webSocket).toBeNull();
  });

  it("multi-tab: each socket is its own connection — one connect per tab, one disconnect per closed tab", async () => {
    const stub = await spawnProbe(uniqueName("bypass-multitab"));
    const studio = await connectStudio(stub);
    const SocketConnectionSchema = z.object({
      connectionId: z.string().min(1),
      caller: z.string(),
      callerType: z.enum(["user", "service"]),
    });
    const SocketNoticeSchema = StudioConnectionMsgSchema.extend({ connection: SocketConnectionSchema });
    const InspectSocketsSchema = z.object({ connections: z.array(SocketConnectionSchema) });
    const notices = (from = 0) =>
      studio
        .messages()
        .slice(from)
        .filter((m) => m.type === "studio.connection")
        .map((m) => SocketNoticeSchema.parse(m));
    const listed = async () => InspectSocketsSchema.parse(await stub.__inspect()).connections;

    const tab1 = await connect(stub, "member-1");
    const tab2 = await connect(stub, "member-1");
    await tab1.next((m) => m.type === "snapshot");
    await tab2.next((m) => m.type === "snapshot");

    // Two tabs of one caller: two connect notices with distinct connectionIds, two listed connections.
    const connects = notices();
    expect(connects.map((n) => n.action)).toEqual(["connect", "connect"]);
    expect(connects.map((n) => n.connection.caller)).toEqual(["member-1", "member-1"]);
    const [id1, id2] = connects.map((n) => n.connection.connectionId);
    if (id1 === undefined || id2 === undefined) throw new Error("expected two connect notices");
    expect(id1).not.toBe(id2);
    expect((await listed()).map((c) => c.connectionId).sort()).toEqual([id1, id2].sort());

    // Closing tab 1: exactly one disconnect, for tab 1's connectionId; tab 2 stays listed.
    const from = studio.frames.length;
    await closeAndSettle(tab1);
    await studio.next((m) => m.type === "studio.connection", from);
    const afterFirst = notices(from);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]).toMatchObject({
      action: "disconnect",
      connection: { connectionId: id1, caller: "member-1" },
    });
    expect(await listed()).toEqual([{ connectionId: id2, caller: "member-1", callerType: "user" }]);

    // Closing tab 2: one disconnect for tab 2's connectionId; the caller is gone entirely.
    const from2 = studio.frames.length;
    await closeAndSettle(tab2);
    await studio.next((m) => m.type === "studio.connection", from2);
    const afterSecond = notices(from2);
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0]).toMatchObject({
      action: "disconnect",
      connection: { connectionId: id2, caller: "member-1" },
    });
    expect(await listed()).toEqual([]);
    await closeAndSettle(studio);
  });
});

// --- Hibernation survival ---

describe("hibernation survival", () => {
  it("after wake the studio socket still gets live updates, view requests, and stays out of connections", async () => {
    const name = uniqueName("hibernate");
    const stub = await spawnProbe(name);
    const studio = await connectStudio(stub);
    const client = await connect(stub, "member-1");
    await client.next((m) => m.type === "snapshot");
    const from = studio.frames.length;

    const woke = await runInDurableObject(stub, async (_instance, state) => {
      const fresh = new StudioProbe(state, env);
      await fresh.send("member-1", "user", { type: "INCREMENT", amount: 2 });

      const studioServer = state.getWebSockets().find((ws) => state.getTags(ws).includes("caller:__studio"));
      if (studioServer === undefined) throw new Error("studio socket did not survive");
      await fresh.webSocketMessage(studioServer, JSON.stringify({ type: "studio.requestView", role: "admin" }));

      // A new app connection after wake: registry must count both app sockets, not the studio one.
      const res = await fresh.fetch(
        new Request("http://localhost/ws", {
          headers: { Upgrade: "websocket", "X-Actor-Kit-Caller-Id": "member-2", "X-Actor-Kit-Caller-Type": "user" },
        }),
      );
      res.webSocket?.accept();
      return InspectSchema.parse(await fresh.__inspect());
    });

    const pushed = StudioTimelineMsgSchema.parse(await studio.next((m) => m.type === "studio.timeline", from));
    expect(ProbeStateSchema.parse(JSON.parse(pushed.entry.stateSnapshot)).count).toBe(2);
    const view = StudioViewMsgSchema.parse(await studio.next((m) => m.type === "studio.view", from));
    expect(view.data).toMatchObject({ count: 2 });

    expect(woke.connections.map((c) => c.caller).sort()).toEqual(["member-1", "member-2"]);
    expect(studio.messages().every((m) => m.type.startsWith("studio."))).toBe(true);

    await settle(100);
    expect((await registryEntry("studio-probe", name))?.connectionCount).toBe(2);

    await closeAndSettle(client);
    await closeAndSettle(studio);
  });
});

// --- studio.requestView ---

describe("studio.requestView", () => {
  async function requestView(payload: unknown) {
    const stub = await spawnProbe(uniqueName("view"));
    await stub.send("member-1", "user", { type: "INCREMENT", amount: 3 });
    const studio = await connectStudio(stub);
    const from = studio.frames.length;
    studio.ws.send(typeof payload === "string" ? payload : JSON.stringify(payload));
    const reply = await studio.next((m) => m.type === "studio.view" || m.type === "studio.error", from);
    await closeAndSettle(studio);
    return reply;
  }

  it("shared view without a caller", async () => {
    const reply = StudioViewMsgSchema.parse(await requestView({ type: "studio.requestView", role: "admin" }));
    expect(reply).toMatchObject({ role: "admin", caller: null, data: { count: 3, connects: 0 } });
  });

  it("perCaller view for a caller that holds the role", async () => {
    const reply = StudioViewMsgSchema.parse(
      await requestView({ type: "studio.requestView", role: "member", caller: "member-owner" }),
    );
    expect(reply).toMatchObject({
      role: "member",
      caller: "member-owner",
      callerRole: "member",
      data: { count: 3, viewer: "member-owner", isOwner: "yes" },
    });
  });

  it("perCaller view without a caller is an error", async () => {
    const reply = StudioViewMsgSchema.parse(await requestView({ type: "studio.requestView", role: "member" }));
    expect(reply.data).toBeUndefined();
    expect(reply.error).toMatch(/caller/);
  });

  it("caller without a matching role: view is computed and callerRole reports the mismatch", async () => {
    const reply = StudioViewMsgSchema.parse(
      await requestView({ type: "studio.requestView", role: "member", caller: "stranger" }),
    );
    expect(reply).toMatchObject({ role: "member", caller: "stranger", callerRole: null });
    expect(reply.data).toMatchObject({ viewer: "stranger", isOwner: "no" });
  });

  it.each(["ghost", "__proto__", "constructor", "toString"])("unknown role %s is an error", async (role) => {
    const reply = StudioViewMsgSchema.parse(await requestView({ type: "studio.requestView", role }));
    expect(reply.role).toBe(role);
    expect(reply.error).toMatch(/No view for role/);
  });

  it.each([
    ["missing role", { type: "studio.requestView" }],
    ["numeric role", { type: "studio.requestView", role: 7 }],
    ["numeric caller", { type: "studio.requestView", role: "admin", caller: 7 }],
  ])("malformed request (%s) gets an error reply", async (_label, payload) => {
    const reply = StudioErrorMsgSchema.parse(await requestView(payload));
    expect(reply.error).toMatch(/studio.requestView/);
  });

  it("invalid JSON gets an error reply", async () => {
    const reply = StudioErrorMsgSchema.parse(await requestView("{not json"));
    expect(reply.error).toMatch(/JSON/);
  });
});

// --- Studio lookups are read-only ---

describe("studio lookups never create an actor", () => {
  it("__inspect / __getTimeline on a missing auto-spawnable actor do not spawn, persist, or register it", async () => {
    const name = uniqueName("phantom");
    const id = env.COUNTER.idFromName(name);
    const stub = env.COUNTER.get(id);

    const inspected = await stub.__inspect();
    expect(inspected).toEqual({
      initialized: false,
      state: null,
      version: 1,
      actorId: null,
      connections: [],
      outbox: [],
      activeLinks: [],
      linkSubscribers: [],
    });
    expect(await timeline(stub)).toEqual({ entries: [], hasMore: false });

    const tables = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray(),
    );
    expect(tables).toEqual([]);

    await settle(100);
    const registry = env.STUDIO_REGISTRY.get(env.STUDIO_REGISTRY.idFromName("registry"));
    // (Filter client-side: the registry's LIKE search rejects a 64-char hex ID as "pattern too complex".)
    const rows = z.array(RegistryEntrySchema).parse(await registry.listActors({ type: "counter", limit: 10_000 }));
    expect(rows.filter((r) => r.actorId === id.toString())).toEqual([]);

    // Normal entry points still auto-spawn afterwards.
    const snap = await stub.getSnapshot("u", "user");
    expect(snap.snapshot).toEqual({ count: 0, lastCaller: "" });
    expect(InspectSchema.extend({ initialized: z.boolean() }).parse(await stub.__inspect()).initialized).toBe(true);
    expect((await timeline(stub)).entries.map((e) => e.causeType)).toEqual(["init"]);
  });
});

describe("registry registration on first app connect", () => {
  async function counterRows() {
    const registry = env.STUDIO_REGISTRY.get(env.STUDIO_REGISTRY.idFromName("registry"));
    return z.array(RegistryEntrySchema).parse(await registry.listActors({ type: "counter", limit: 10_000 }));
  }

  it("an actor only ever reached over WebSocket appears in the registry with its connection count", async () => {
    const id = env.COUNTER.idFromName(uniqueName("ws-only"));
    const stub = env.COUNTER.get(id);
    const client = await connect(stub, "u");
    await client.next((m) => m.type === "snapshot");

    const rows = await waitFor(counterRows, (r) =>
      r.some((e) => e.actorId === id.toString() && e.connectionCount === 1),
    );
    expect(rows.find((e) => e.actorId === id.toString())).toMatchObject({ connectionCount: 1 });
    await closeAndSettle(client);
  });

  it("an actor persisted before the registry knew it is registered when an app client connects", async () => {
    const name = uniqueName("ws-preexisting");
    const stub = env.COUNTER.get(env.COUNTER.idFromName(name));
    await stub.spawn({ actorId: name, caller: "u", callerType: "user", input: {} });
    await settle(100); // let spawn's fire-and-forget touch land before we drop the row
    // Simulate a registry that lost (or never had) this actor, e.g. registry added after the actor.
    const registry = env.STUDIO_REGISTRY.get(env.STUDIO_REGISTRY.idFromName("registry"));
    await runInDurableObject(registry, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM actors WHERE actor_type = 'counter' AND actor_id = ?", name);
    });
    // Fresh instance: no debounce carried over from spawn (as after eviction).
    await runInDurableObject(stub, async (_instance, state) => {
      const fresh = new Counter(state, env);
      const res = await fresh.fetch(
        new Request("http://localhost/ws", {
          headers: { Upgrade: "websocket", "X-Actor-Kit-Caller-Id": "u", "X-Actor-Kit-Caller-Type": "user" },
        }),
      );
      res.webSocket?.accept();
    });

    const rows = await waitFor(counterRows, (r) => r.some((e) => e.actorId === name));
    expect(rows.find((e) => e.actorId === name)).toMatchObject({ connectionCount: 1 });
  });
});

// --- Studio disabled ---

describe("studio disabled (studio: { enabled: false })", () => {
  function off(name: string) {
    return env.STUDIO_OFF.get(env.STUDIO_OFF.idFromName(name));
  }

  it("rejects __inspect", async () => {
    const stub = off(uniqueName("off-inspect"));
    expect(await rpcError(stub.__inspect())).toMatch(/Studio is not enabled/);
  });

  it("rejects __getTimeline", async () => {
    const stub = off(uniqueName("off-timeline"));
    expect(await rpcError(stub.__getTimeline())).toMatch(/Studio is not enabled/);
  });

  it("rejects the studio WebSocket", async () => {
    const stub = off(uniqueName("off-ws"));
    const res = await stub.fetch("http://localhost/ws", {
      headers: { Upgrade: "websocket", "X-Actor-Kit-Caller-Id": "__studio", "X-Actor-Kit-Caller-Type": "service" },
    });
    expect(res.status).toBe(404);
    expect(res.webSocket).toBeNull();
  });

  it("records no timeline or connection rows and does not register", async () => {
    const name = uniqueName("off-rows");
    const stub = off(name);
    await stub.send("u", "user", { type: "INCREMENT" });
    const client = await connect(stub, "u");
    await client.next((m) => m.type === "snapshot");

    const counts = await runInDurableObject(stub, (_instance, state) => ({
      timeline: state.storage.sql.exec("SELECT COUNT(*) AS n FROM timeline").one()["n"],
      // Connections are no longer persisted (migration 0008 drops studio_connections): no such table may exist.
      connections: state.storage.sql
        .exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'studio_connections'")
        .one()["n"],
    }));
    expect(counts).toEqual({ timeline: 0, connections: 0 });
    await settle(100);
    const registry = env.STUDIO_REGISTRY.get(env.STUDIO_REGISTRY.idFromName("registry"));
    expect(await registry.listActors({ type: "studio-off" })).toEqual([]);
    await closeAndSettle(client);
  });
});
