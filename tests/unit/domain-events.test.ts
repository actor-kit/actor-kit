/**
 * Domain events (ADR-017 §2): `events` declares names and payload schemas; `ctx.emit` parses the
 * payload and records the event on the transition's journal row (`emitted`). A transition that only
 * emits is still journaled. replayJournal() checks replay emits the same events, in order, and
 * fails on the first difference. testActor returns `emitted`; simulate() exposes `sim.events()`.
 * `setup({ events })` types `ctx.emit` by the declared events.
 */
import { replayJournal, simulate, testActor } from "@actor-kit/test";
import {
  ACTOR_KIT_MIGRATIONS,
  appendJournalEvent,
  createLiveFacts,
  defineActor,
  JournalEmittedDivergenceError,
  liveStepFacts,
  message,
  readJournal,
  resolveJournalConfig,
  setup,
  step,
} from "@actor-kit/worker/testing";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { createNodeSql } from "./helpers/node-sql";

type Bid = { bidder: string; amount: number };
type S = { bids: Bid[] };

const auction = setup({
  events: {
    BidPlaced: z.object({ bidder: z.string(), amount: z.number() }),
    BidIgnored: z.object({ bidder: z.string(), amount: z.number(), reason: z.literal("too_low") }),
  },
});

const highest = (s: S) => Math.max(0, ...s.bids.map((b) => b.amount));

const Auction = defineActor("auction", {
  input: z.object({}),
  init: (): S => ({ bids: [] }),
  roles: { any: () => true },
  events: auction.events,
  messages: {
    BID: auction.message(z.object({ amount: z.number() }), (s: S, { amount }, ctx) => {
      if (amount <= highest(s)) {
        ctx.emit("BidIgnored", { bidder: ctx.caller, amount, reason: "too_low" });
        return s;
      }
      ctx.emit("BidPlaced", { bidder: ctx.caller, amount });
      return { bids: [...s.bids, { bidder: ctx.caller, amount }] };
    }),
    BAD: message(z.object({ name: z.string() }), (s: S, { name }, ctx) => {
      ctx.emit(name, { bidder: 1 });
      return s;
    }),
    LATER: message(z.object({}), (s: S, _p, ctx) => {
      ctx.schedule("close", { in: 5 });
      return s;
    }),
  },
  timers: {
    close: auction.timer(z.object({}).optional(), (s: S, _p, ctx) => {
      ctx.emit("BidPlaced", { bidder: "house", amount: highest(s) });
      return s;
    }),
  },
  views: {},
});

describe("types", () => {
  it("ctx.emit is typed by the declared events", () => {
    auction.message(z.object({}), (s: S, _p, ctx) => {
      expectTypeOf(ctx.emit).parameter(0).toEqualTypeOf<"BidPlaced" | "BidIgnored">();
      // @ts-expect-error not a declared event
      ctx.emit("Nope", {});
      // @ts-expect-error wrong payload
      ctx.emit("BidPlaced", { bidder: "a" });
      return s;
    });
  });
});

describe("the step core records emitted events", () => {
  const def = { ...Auction.def, messages: { any: Auction.def.messages } };
  const facts = () => liveStepFacts(createLiveFacts(), () => []);
  const bid = (amount: number, state: S = { bids: [] }) =>
    step(
      def,
      state,
      { type: "message", name: "BID", payload: { amount }, caller: "ann", callerType: "user", role: "any" },
      facts(),
      {},
    );

  it("on the journal draft, in order, with parsed payloads", () => {
    expect(bid(5).event.emitted).toEqual([{ name: "BidPlaced", payload: { bidder: "ann", amount: 5 } }]);
  });

  it("a transition that emits nothing has no emitted key", () => {
    const later = step(
      def,
      { bids: [] },
      { type: "message", name: "LATER", payload: {}, caller: "a", callerType: "user", role: "any" },
      facts(),
      {},
    );
    expect("emitted" in later.event).toBe(false);
  });

  it("an undeclared event or an invalid payload fails the transition", () => {
    const send = (name: string) =>
      step(
        def,
        { bids: [] },
        { type: "message", name: "BAD", payload: { name }, caller: "a", callerType: "user", role: "any" },
        facts(),
        {},
      );
    expect(() => send("Nope")).toThrow('Event "Nope" is not declared on this actor');
    expect(() => send("BidPlaced")).toThrow(/Event "BidPlaced": invalid payload/);
  });
});

describe("journal", () => {
  it("stores emitted events on the row (none: no column value)", () => {
    const sql = createNodeSql();
    for (const migration of ACTOR_KIT_MIGRATIONS) sql.exec(migration.sql);
    const draft = {
      causeType: "message" as const,
      name: "BID",
      payload: {},
      caller: "a",
      callerType: "user" as const,
      role: "any",
      facts: {},
    };
    const persisted = (seq: number) => ({ seq, stateJson: "{}", checksum: "c", version: 1, now: 1 });
    const config = resolveJournalConfig(undefined);
    appendJournalEvent(
      sql,
      config,
      { ...draft, emitted: [{ name: "BidPlaced", payload: { amount: 1 } }] },
      persisted(1),
    );
    appendJournalEvent(sql, config, draft, persisted(2));
    const [first, second] = readJournal(sql).events;
    expect(first?.emitted).toEqual([{ name: "BidPlaced", payload: { amount: 1 } }]);
    expect(second !== undefined && "emitted" in second).toBe(false);
    sql.close();
  });
});

describe("simulate", () => {
  it("journals a transition that only emits, and lists every actor's events in order", async () => {
    const sim = simulate({ contracts: [Auction] });
    const a = await sim.spawn(Auction, "a1", {});
    a.send("ann", { type: "BID", amount: 5 });
    a.send("bob", { type: "BID", amount: 3 }); // ignored: state unchanged, still journaled
    a.send("u", { type: "LATER" });
    sim.advance(10);
    expect(a.journal.events.map((e) => [e.seq, e.emitted?.map((x) => x.name)])).toEqual([
      [1, undefined],
      [2, ["BidPlaced"]],
      [3, ["BidIgnored"]],
      [4, undefined],
      [5, ["BidPlaced"]],
    ]);
    expect(sim.events()).toEqual([
      { actor: { type: "auction", id: "a1" }, seq: 2, name: "BidPlaced", payload: { bidder: "ann", amount: 5 } },
      {
        actor: { type: "auction", id: "a1" },
        seq: 3,
        name: "BidIgnored",
        payload: { bidder: "bob", amount: 3, reason: "too_low" },
      },
      { actor: { type: "auction", id: "a1" }, seq: 5, name: "BidPlaced", payload: { bidder: "house", amount: 5 } },
    ]);
    await replayJournal(Auction, a.journal);
  });
});

describe("replayJournal checks emitted events", () => {
  async function journal() {
    const sim = simulate({ contracts: [Auction] });
    const a = await sim.spawn(Auction, "a1", {});
    a.send("ann", { type: "BID", amount: 5 });
    a.send("bob", { type: "BID", amount: 3 });
    return a.journal;
  }

  it("fails on the first difference: a different payload", async () => {
    const recorded = await journal();
    const events = recorded.events.map((e) =>
      e.seq === 2 ? { ...e, emitted: [{ name: "BidPlaced", payload: { bidder: "ann", amount: 6 } }] } : e,
    );
    const error = await replayJournal(Auction, { ...recorded, events }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JournalEmittedDivergenceError);
    expect(error).toMatchObject({ seq: 2, index: 0 });
    expect(String(error)).toContain('expected BidPlaced {"bidder":"ann","amount":6}');
  });

  it("fails when replay emits more or fewer events than were recorded", async () => {
    const recorded = await journal();
    const fewer = recorded.events.map((e) => (e.seq === 3 ? { ...e, emitted: [] } : e));
    await expect(replayJournal(Auction, { ...recorded, events: fewer })).rejects.toMatchObject({ seq: 3, index: 0 });
    const more = recorded.events.map((e) =>
      e.seq === 3 ? { ...e, emitted: [...(e.emitted ?? []), { name: "BidPlaced", payload: {} }] } : e,
    );
    const error = await replayJournal(Auction, { ...recorded, events: more }).catch((e: unknown) => e);
    expect(error).toMatchObject({ seq: 3, index: 1 });
    expect(String(error)).toContain("got nothing");
  });
});

describe("testActor", () => {
  it("returns emitted events", async () => {
    const t = testActor(Auction);
    const first = await t.send(t.init({}), "ann", { type: "BID", amount: 5 });
    expect(first.emitted).toEqual([{ name: "BidPlaced", payload: { bidder: "ann", amount: 5 } }]);
    const second = await t.send(first.state, "bob", { type: "BID", amount: 1 });
    expect(second.emitted).toEqual([{ name: "BidIgnored", payload: { bidder: "bob", amount: 1, reason: "too_low" } }]);
    await expect(t.send(first.state, "a", { type: "BAD", name: "Nope" })).rejects.toThrow(
      'Event "Nope" is not declared',
    );
  });
});

describe("Studio", () => {
  it("timeline entries carry emitted events; projection redacts their payloads", async () => {
    const { timelineEntry } = await import("@actor-kit/worker/testing");
    const { projectTimelineEntry } = await import("../../packages/worker/src/runtime/studio-project");
    const { compileRedaction } = await import("../../packages/worker/src/runtime/studio-redact");
    const event = {
      seq: 2,
      causeType: "message" as const,
      name: "BID",
      payload: {},
      caller: "a",
      callerType: "user" as const,
      role: "any",
      facts: {},
      codeVersion: 1,
      stateChecksum: "c",
      createdAt: 1,
      emitted: [{ name: "BidPlaced", payload: { bidder: "Juneau", amount: 5 } }],
    };
    const entry = timelineEntry(event, "{}", (l) => l);
    expect(JSON.parse(entry.emitted ?? "null")).toEqual(event.emitted);
    expect(timelineEntry({ ...event, emitted: undefined }, "{}", (l) => l).emitted).toBeNull();
    const redacted = await projectTimelineEntry(entry, { redactor: compileRedaction(["bidder"]), hashCaller: null });
    expect(JSON.parse(redacted.emitted ?? "null")).toEqual([
      { name: "BidPlaced", payload: { bidder: "[redacted]", amount: 5 } },
    ]);
    const plain = await projectTimelineEntry(entry, { redactor: compileRedaction([]), hashCaller: null });
    expect(plain.emitted).toBe(entry.emitted);
    const none = await projectTimelineEntry(
      { ...entry, emitted: null },
      { redactor: compileRedaction(["bidder"]), hashCaller: null },
    );
    expect(none.emitted).toBeNull();
    const odd = await projectTimelineEntry(
      { ...entry, emitted: '{"a":1}' },
      { redactor: compileRedaction(["x"]), hashCaller: null },
    );
    expect(odd.emitted).toBe('"[redacted]"');
    const items = await projectTimelineEntry(
      { ...entry, emitted: '[1,{"name":"X"}]' },
      { redactor: compileRedaction(["x"]), hashCaller: null },
    );
    expect(JSON.parse(items.emitted ?? "null")).toEqual(["[redacted]", { name: "X" }]);
  });

  it("the UI parses emitted events", async () => {
    const { TimelineEntrySchema } = await import("../../packages/studio/ui/src/protocol");
    const wire = { id: 1, causeType: "message", causeData: "{}", stateSnapshot: "{}", checksum: "c", createdAt: 1 };
    expect(TimelineEntrySchema.parse({ ...wire, emitted: '[{"name":"A","payload":1}]' }).emitted).toEqual([
      { name: "A", payload: 1 },
    ]);
    expect(TimelineEntrySchema.parse({ ...wire, emitted: null }).emitted).toBeUndefined();
    expect(TimelineEntrySchema.parse(wire).emitted).toBeUndefined();
  });
});

describe("examples/auction emits its domain events", () => {
  it("BidPlaced, BidIgnored and AuctionClosed, replayable", async () => {
    const { AuctionContract } = await import("../../examples/auction/src/auction");
    const sim = simulate({ contracts: [AuctionContract], now: 1_000 });
    const a = await sim.spawn(AuctionContract, "lot-1", { item: "lamp" });
    a.send("ann", { type: "BID", amount: 10 });
    a.send("bob", { type: "BID", amount: 5 });
    a.send("house", { type: "CLOSE" }, { callerType: "service" });
    expect(sim.events().map((e) => [e.seq, e.name, e.payload])).toEqual([
      [2, "BidPlaced", { bidder: "ann", amount: 10 }],
      [3, "BidIgnored", { bidder: "bob", amount: 5, reason: "too_low" }],
      [4, "AuctionClosed", { winner: "ann", amount: 10 }],
    ]);
    await replayJournal(AuctionContract, a.journal);
  });
});
