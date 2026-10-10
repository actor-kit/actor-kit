/**
 * Causation and correlation ids (ADR-017 §4). Every journal event has a correlation id and,
 * unless it starts a flow, a causation id:
 *
 * - A client or service message (and init, lifecycle, migrate, restore) starts a flow: the
 *   correlation id is the event's own id (`${actorType}/${actorId}/${seq}`), no causation.
 * - Service results, timer firings and forwards received carry the correlation id of the event
 *   that declared the effect; the causation id is the effect (`${actorType}/${actorId}/${seq}:${index}`).
 * - Link updates carry the correlation id of the source's event that changed the view; the
 *   causation id is that event's id.
 */
import { schema, string, view } from "@actor-kit/core";
import { replayJournal, simulate } from "@actor-kit/test";
import {
  ACTOR_KIT_MIGRATIONS,
  appendJournalEvent,
  createLiveFacts,
  defineActor,
  effectCauseId,
  eventId,
  type JournalEvent,
  journalTrace,
  link,
  liveStepFacts,
  message,
  parseCauseId,
  readJournal,
  resolveJournalConfig,
  step,
  timelineEntry,
  timer,
} from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createNodeSql } from "./helpers/node-sql";

describe("ids", () => {
  it("an event id is type/id/seq, an effect cause is type/id/seq:index", () => {
    expect(eventId("room", "r1", 4)).toBe("room/r1/4");
    expect(effectCauseId("room", "r1", "4:2")).toBe("room/r1/4:2");
  });

  it("parses event and effect ids, actor ids may contain slashes", () => {
    expect(parseCauseId("room/r1/4")).toEqual({ actorType: "room", actorId: "r1", seq: 4 });
    expect(parseCauseId("room/r1/4:2")).toEqual({ actorType: "room", actorId: "r1", seq: 4, index: 2 });
    expect(parseCauseId("room/a/b/12")).toEqual({ actorType: "room", actorId: "a/b", seq: 12 });
  });

  it("parses multi-digit effect indexes", () => {
    expect(parseCauseId("room/r1/4:12")).toEqual({ actorType: "room", actorId: "r1", seq: 4, index: 12 });
  });

  it.each(["/x/y/3", "", "room", "room/4", "/r1/4", "room//4", "room/r1/x", "room/r1/4:", "room/r1/04", "room/r1/4:x"])(
    "refuses %j",
    (id) => {
      expect(parseCauseId(id)).toBeNull();
    },
  );

  it("journalTrace: an inherited trace is kept; otherwise the event starts its own flow", () => {
    expect(journalTrace(undefined, "a/1/3")).toEqual({ correlationId: "a/1/3", causationId: null });
    expect(journalTrace({ correlationId: "b/2/1", causationId: "b/2/1:0" }, "a/1/3")).toEqual({
      correlationId: "b/2/1",
      causationId: "b/2/1:0",
    });
  });
});

describe("the step core carries a cause's trace onto its journal draft", () => {
  const def = {
    roles: { any: () => true },
    messages: { any: { PING: { schema: z.object({}), handler: (s: number) => s + 1 } } },
  };
  const facts = () => liveStepFacts(createLiveFacts(), () => []);
  const ping = { type: "message", name: "PING", payload: {}, caller: "u", callerType: "user", role: "any" } as const;

  it("with a trace", () => {
    const trace = { correlationId: "x/1/1", causationId: "x/1/1:0" };
    expect(step(def, 0, { ...ping, trace }, facts(), {}).event.trace).toEqual(trace);
  });

  it("without one, the draft has no trace", () => {
    expect("trace" in step(def, 0, ping, facts(), {}).event).toBe(false);
  });
});

describe("the journal stores the ids", () => {
  const draft = {
    causeType: "message" as const,
    name: "PING",
    payload: {},
    caller: "u",
    callerType: "user" as const,
    role: "any",
    facts: {},
  };
  const persisted = (seq: number) => ({ seq, stateJson: "1", checksum: "c", version: 1, now: 5 });

  it("writes and reads correlation and causation ids", () => {
    const sql = createNodeSql();
    for (const migration of ACTOR_KIT_MIGRATIONS) sql.exec(migration.sql);
    const config = resolveJournalConfig(undefined);
    appendJournalEvent(sql, config, draft, { ...persisted(1), correlationId: "a/1/1", causationId: null });
    appendJournalEvent(sql, config, draft, { ...persisted(2), correlationId: "b/2/7", causationId: "b/2/7:1" });
    appendJournalEvent(sql, config, draft, persisted(3));
    const [first, second, third] = readJournal(sql).events;
    expect(first).toMatchObject({ correlationId: "a/1/1" });
    expect(first !== undefined && "causationId" in first).toBe(false);
    expect(second).toMatchObject({ correlationId: "b/2/7", causationId: "b/2/7:1" });
    // Rows written without ids (before ADR-017) read without them.
    expect(third !== undefined && ("correlationId" in third || "causationId" in third)).toBe(false);
    sql.close();
  });
});

describe("Studio timeline entries show the ids", () => {
  const base: JournalEvent = {
    seq: 2,
    causeType: "init",
    name: null,
    payload: {},
    caller: null,
    callerType: null,
    role: null,
    facts: {},
    codeVersion: 1,
    stateChecksum: "c",
    createdAt: 1,
  };
  it("null when the event has none", () => {
    expect(timelineEntry(base, "{}", (l) => l)).toMatchObject({ correlationId: null, causationId: null });
  });
  it("as recorded", () => {
    const traced = { ...base, correlationId: "a/1/1", causationId: "a/1/1:0" };
    expect(timelineEntry(traced, "{}", (l) => l)).toMatchObject({ correlationId: "a/1/1", causationId: "a/1/1:0" });
  });
});

// --- Across actors, in simulate() (the same step core and id rules as the Durable Object) ---

type Room = { pings: number };
const RoomContract = defineActor("room", {
  input: z.object({}),
  init: (): Room => ({ pings: 0 }),
  roles: { any: () => true },
  messages: { PING: message(z.object({}), (s: Room) => ({ pings: s.pings + 1 })) },
  views: { any: view.shared(schema({ pings: string }), (s: Room) => ({ pings: String(s.pings) })) },
});

type Desk = { log: string[] };
const DeskContract = defineActor("desk", {
  input: z.object({}),
  init: (): Desk => ({ log: [] }),
  roles: { any: () => true },
  messages: {
    WATCH: message(z.object({ id: z.string() }), (s: Desk, { id }, ctx) => {
      ctx.link("room", id);
      return s;
    }),
    POKE: message(z.object({ id: z.string() }), (s: Desk, { id }, ctx) => {
      ctx.forward("room", id, { type: "PING" });
      return s;
    }),
    FETCH: message(z.object({}), (s: Desk, _p, ctx) => {
      ctx.execute("LOAD", {});
      ctx.schedule("later", { in: 10, key: "k" });
      return s;
    }),
  },
  services: {
    LOAD: { fn: async () => 1, onDone: (s: Desk) => ({ log: [...s.log, "loaded"] }) },
  },
  timers: { later: timer(z.object({}).optional(), (s: Desk) => ({ log: [...s.log, "later"] })) },
  links: {
    room: link(RoomContract, { onUpdate: (s: Desk, v: { pings: string }) => ({ log: [...s.log, `room:${v.pings}`] }) }),
  },
  views: {},
});

const ids = (events: readonly JournalEvent[]) =>
  events.map((e) => [e.seq, e.causeType, e.correlationId, e.causationId]);

describe("simulate: ids across a flow", () => {
  it("messages start flows; service results and timers continue the declaring event's flow", async () => {
    const sim = simulate({ contracts: [RoomContract, DeskContract] });
    const desk = await sim.spawn(DeskContract, "d1", {});
    desk.send("u", { type: "FETCH" });
    sim.resolve("2:0", 1);
    sim.advance(20);
    expect(ids(desk.journal.events)).toEqual([
      [1, "init", "desk/d1/1", undefined],
      [2, "message", "desk/d1/2", undefined],
      [3, "service.onDone", "desk/d1/2", "desk/d1/2:0"],
      [4, "timer", "desk/d1/2", "desk/d1/2:1"],
    ]);
    await replayJournal(DeskContract, desk.journal);
  });

  it("a forward carries the flow to the target, caused by the forward effect", async () => {
    const sim = simulate({ contracts: [RoomContract, DeskContract] });
    const room = await sim.spawn(RoomContract, "r1", {});
    const desk = await sim.spawn(DeskContract, "d1", {});
    desk.send("u", { type: "POKE", id: "r1" });
    expect(ids(room.journal.events).at(-1)).toEqual([2, "message", "desk/d1/2", "desk/d1/2:0"]);
  });

  it("a link push carries the source event's flow, caused by that event", async () => {
    const sim = simulate({ contracts: [RoomContract, DeskContract] });
    const room = await sim.spawn(RoomContract, "r1", {});
    const desk = await sim.spawn(DeskContract, "d1", {});
    desk.send("u", { type: "WATCH", id: "r1" }); // seq 2; the room pushes its current view (after its seq 1)
    room.send("v", { type: "PING" }); // room seq 2 → push
    expect(ids(desk.journal.events).slice(2)).toEqual([
      [3, "link.onUpdate", "room/r1/1", "room/r1/1"],
      [4, "link.onUpdate", "room/r1/2", "room/r1/2"],
    ]);
  });
});

describe("simulate: ids when the declaring actor keeps no journal", () => {
  const Quiet = defineActor("quiet", {
    input: z.object({}),
    init: (): Desk => ({ log: [] }),
    roles: { any: () => true },
    messages: {
      POKE: message(z.object({ id: z.string() }), (s: Desk, { id }, ctx) => {
        ctx.forward("room", id, { type: "PING" });
        return { log: [...s.log, "poked"] };
      }),
    },
    links: { room: link(RoomContract, { onUpdate: (s: Desk) => s }) },
    views: {},
    journal: false,
  });

  it("a forward from it starts the target's flow at the forwarding event's id", async () => {
    const sim = simulate({ contracts: [RoomContract, Quiet] });
    const room = await sim.spawn(RoomContract, "r1", {});
    const quiet = await sim.spawn(Quiet, "q1", {});
    quiet.send("u", { type: "POKE", id: "r1" });
    expect(ids(room.journal.events).at(-1)).toEqual([2, "message", "quiet/q1/2", "quiet/q1/2:0"]);
  });

  it("a push from it carries its newest event's id", async () => {
    const QuietRoom = defineActor("room", { ...RoomContract.def, journal: false });
    const sim = simulate({ contracts: [QuietRoom, DeskContract] });
    const room = await sim.spawn(QuietRoom, "r1", {});
    const desk = await sim.spawn(DeskContract, "d1", {});
    room.send("v", { type: "PING" });
    desk.send("u", { type: "WATCH", id: "r1" });
    expect(ids(desk.journal.events).at(-1)).toEqual([3, "link.onUpdate", "room/r1/2", "room/r1/2"]);
  });

  it("a push after a forwarded event carries the forwarder's flow (not an older event's)", async () => {
    const sim = simulate({ contracts: [RoomContract, DeskContract] });
    const room = await sim.spawn(RoomContract, "r1", {});
    const desk = await sim.spawn(DeskContract, "d1", {});
    room.send("v", { type: "PING" }); // room seq 2
    desk.send("u", { type: "WATCH", id: "r1" }); // desk seq 2, push → desk seq 3
    desk.send("u", { type: "POKE", id: "r1" }); // desk seq 4 → room seq 3 → push → desk seq 5
    expect(ids(desk.journal.events).at(-1)).toEqual([5, "link.onUpdate", "desk/d1/4", "room/r1/3"]);
  });
});
