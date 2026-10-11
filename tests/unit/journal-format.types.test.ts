/**
 * ADR-018 F: the journal format, frozen for 0.3.
 * - emit everywhere: lifecycle, service onDone/onError and link callbacks get a typed ctx.emit (effect
 *   index rules as in handlers; a callback that only emits is still journaled; published like any emit).
 * - emitted-event upcasters and renames in `versions` steps: replay upcasts recorded events first.
 */
import { replayJournal, simulate } from "@actor-kit/test";
import {
  compileVersions,
  JournalEmittedDivergenceError,
  type JournalEvent,
  rebuildFromJournal,
  setup,
  toRuntimeDef,
  upcastEmitted,
  version,
} from "@actor-kit/worker/testing";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

type S = { n: number };

const feedKit = setup({ events: {} });
const Feed = feedKit.actor("feed", {
  input: z.object({}),
  init: (): S => ({ n: 0 }),
  roles: { any: () => true },
  messages: { BUMP: feedKit.message(z.object({}), (s: S) => ({ n: s.n + 1 })) },
  views: { any: { fn: (s: S) => ({ n: s.n }) } },
});

const kit = setup({
  events: {
    Joined: z.object({ who: z.string() }),
    Charged: z.object({ effectId: z.string() }),
    Failed: z.object({ tag: z.string() }),
    Synced: z.object({ n: z.number() }),
  },
});

const Hub = kit.actor("hub", {
  input: z.object({}),
  init: (): S => ({ n: 0 }),
  roles: { any: () => true },
  publish: { queue: "HUB_EVENTS", events: ["Charged"] },
  messages: {
    BUY: kit.message(z.object({}), (s: S, _p, ctx) => {
      ctx.execute("charge", {});
      return s;
    }),
    FOLLOW: kit.message(z.object({}), (s: S, _p, ctx) => {
      ctx.link("feed", "f1");
      return s;
    }),
  },
  lifecycle: {
    connect: (s: S, event, ctx) => {
      ctx.emit("Joined", { who: event.caller });
      if (event.caller === "type-check-only") {
        // @ts-expect-error not a declared event
        ctx.emit("Nope", {});
      }
      return s;
    },
  },
  services: {
    charge: kit.service({
      fn: async () => "ok",
      onDone: (s: S, _r, _i, ctx) => {
        ctx.emit("Charged", { effectId: ctx.effectId });
        expectTypeOf(ctx.emit).parameter(0).toEqualTypeOf<"Joined" | "Charged" | "Failed" | "Synced">();
        return s;
      },
      onError: (s: S, error, _i, ctx) => {
        ctx.emit("Failed", { tag: error._tag });
        return s;
      },
    }),
  },
  links: {
    feed: kit.link(Feed, {
      onUpdate: (s: S, view: { n: number }, _id, ctx) => {
        ctx.emit("Synced", { n: view.n });
        return s;
      },
    }),
  },
  views: {},
});

describe("emit in lifecycle, service and link callbacks", () => {
  it("lifecycle.connect emits; the transition is journaled although the state did not change", async () => {
    const sim = simulate({ contracts: [Hub] });
    const hub = await sim.spawn(Hub, "h", {});
    hub.connect("ann");
    expect(sim.events().map((e) => [e.name, e.payload])).toEqual([["Joined", { who: "ann" }]]);
    expect(hub.journal.events.at(-1)).toMatchObject({ causeType: "lifecycle.connect", emitted: [{ name: "Joined" }] });
    await replayJournal(Hub, hub.journal);
  });

  it("onDone and onError emit; a published event from onDone goes to the queue", async () => {
    const sim = simulate({ contracts: [Hub] });
    const hub = await sim.spawn(Hub, "h", {});
    hub.send("u", { type: "BUY" });
    hub.send("u", { type: "BUY" });
    sim.resolve("2:0", "ok");
    sim.reject("3:0", "boom");
    expect(sim.events().map((e) => e.name)).toEqual(["Charged", "Failed"]);
    expect(sim.published("HUB_EVENTS")).toMatchObject([{ name: "Charged", payload: { effectId: "2:0" } }]);
    await replayJournal(Hub, hub.journal);
  });

  it("link onUpdate emits", async () => {
    const sim = simulate({ contracts: [Hub, Feed] });
    await sim.spawn(Feed, "f1", {});
    const hub = await sim.spawn(Hub, "h", {});
    hub.send("u", { type: "FOLLOW" });
    sim.actor(Feed, "f1").send("u", { type: "BUMP" });
    expect(sim.events().map((e) => [e.name, e.payload])).toEqual([
      ["Synced", { n: 0 }],
      ["Synced", { n: 1 }],
    ]);
    await replayJournal(Hub, hub.journal);
  });

  it("onUnlink emits too", async () => {
    const Leaver = kit.actor("leaver", {
      input: z.object({}),
      init: (): S => ({ n: 0 }),
      roles: { any: () => true },
      messages: {
        DROP: kit.message(z.object({}), (s: S, _p, ctx) => {
          ctx.link("feed", "f1");
          ctx.unlink("feed", "f1");
          return s;
        }),
      },
      links: {
        feed: kit.link(Feed, {
          onUpdate: (s: S) => s,
          onUnlink: (s: S, id, ctx) => {
            ctx.emit("Synced", { n: id === "f1" ? 1 : 0 });
            return s;
          },
        }),
      },
      views: {},
    });
    const sim = simulate({ contracts: [Leaver, Feed] });
    const leaver = await sim.spawn(Leaver, "l", {});
    leaver.send("u", { type: "DROP" });
    expect(sim.events().map((e) => [e.name, e.payload])).toEqual([["Synced", { n: 1 }]]);
  });

  it("a standalone link() has no events to emit", () => {
    const plain = setup({});
    plain.link(Feed, {
      onUpdate: (s: S, _view, _id, ctx) => {
        // @ts-expect-error no events are declared
        ctx.emit("Synced", { n: 1 });
        return s;
      },
    });
    expect(true).toBe(true);
  });
});

describe("emitted-event upcasters and renames in versions", () => {
  // Compiled inside each test, so a broken compiler fails the test rather than the file's collection.
  const chain = () =>
    compileVersions([
      version(1, z.object({})),
      version(2, z.object({}), {
        emitted: { BidPlaced: (p) => ({ ...p, currency: "USD" }) },
        renames: { BidPlaced: "BidMade" },
      }),
      version(3, z.object({}), { emitted: { BidMade: (p) => ({ ...p, v3: true }) } }),
    ]);

  it("upcast through every later step: payload first, then the rename, keyed by the name before the step", () => {
    expect(chain().upcastEmitted({ name: "BidPlaced", payload: { amount: 5 } }, 1)).toEqual({
      name: "BidMade",
      payload: { amount: 5, currency: "USD", v3: true },
    });
    expect(chain().upcastEmitted({ name: "BidMade", payload: { amount: 5 } }, 2)).toEqual({
      name: "BidMade",
      payload: { amount: 5, v3: true },
    });
    expect(chain().upcastEmitted({ name: "Other", payload: 7 }, 1)).toEqual({ name: "Other", payload: 7 });
    // An event written at version 2 is already in version 2's vocabulary: only later steps apply.
    expect(chain().upcastEmitted({ name: "BidPlaced", payload: { amount: 1 } }, 2)).toEqual({
      name: "BidPlaced",
      payload: { amount: 1 },
    });
  });

  it("upcastEmitted reads a journal entry in the current vocabulary", () => {
    const event: JournalEvent = {
      seq: 3,
      causeType: "message",
      name: "BID",
      payload: {},
      caller: "a",
      callerType: "user",
      role: "r",
      facts: {},
      codeVersion: 1,
      stateChecksum: "",
      createdAt: 0,
      emitted: [{ name: "BidPlaced", payload: { amount: 1 } }],
    };
    expect(upcastEmitted(chain(), event)).toEqual([
      { name: "BidMade", payload: { amount: 1, currency: "USD", v3: true } },
    ]);
    expect(upcastEmitted({}, event)).toEqual([{ name: "BidPlaced", payload: { amount: 1 } }]);
    const { emitted: _emitted, ...silent } = event;
    expect(upcastEmitted({}, silent)).toEqual([]);
  });

  it("a rebuild by replay compares upcast recorded events with what the new handlers emit", async () => {
    type B = { bids: number[] };
    const v1 = setup({ events: { BidPlaced: z.object({ amount: z.number() }) } });
    const Auction1 = v1.actor("auction", {
      input: z.object({}),
      init: (): B => ({ bids: [] }),
      roles: { any: () => true },
      messages: {
        BID: v1.message(z.object({ amount: z.number() }), (s: B, { amount }, ctx) => {
          ctx.emit("BidPlaced", { amount });
          return { bids: [...s.bids, amount] };
        }),
      },
      views: {},
    });
    const sim = simulate({ contracts: [Auction1] });
    const a = await sim.spawn(Auction1, "a", {});
    a.send("u", { type: "BID", amount: 5 });

    const v2 = setup({ events: { BidMade: z.object({ amount: z.number(), currency: z.string() }) } });
    const handlers = (currency: string) => ({
      BID: v2.message(z.object({ amount: z.number() }), (s: B, { amount }, ctx) => {
        ctx.emit("BidMade", { amount, currency });
        return { bids: [...s.bids, amount] };
      }),
    });
    const versions = (renamed: boolean) =>
      [
        version(1, z.object({ bids: z.array(z.number()) })),
        version(2, z.object({ bids: z.array(z.number()) }), {
          rebuild: "replay",
          ...(renamed
            ? { emitted: { BidPlaced: (p) => ({ ...p, currency: "USD" }) }, renames: { BidPlaced: "BidMade" } }
            : {}),
        }),
      ] as const;
    const Auction2 = (renamed: boolean, currency: string) =>
      v2.actor("auction", {
        input: z.object({}),
        init: (): B => ({ bids: [] }),
        roles: { any: () => true },
        versions: versions(renamed),
        messages: handlers(currency),
        views: {},
      });

    // As the runtime stores it: messages role-nested.
    const rebuild = (contract: ReturnType<typeof Auction2>) =>
      rebuildFromJournal({ ...toRuntimeDef(contract.def), messages: { any: contract.def.messages } }, a.journal);
    await expect(rebuild(Auction2(true, "USD"))).resolves.toEqual({ bids: [5] });
    const drifted = await rebuild(Auction2(true, "EUR")).catch((e: unknown) => e);
    expect(drifted).toBeInstanceOf(JournalEmittedDivergenceError);
    const unrenamed = await rebuild(Auction2(false, "USD")).catch((e: unknown) => e);
    expect(unrenamed).toBeInstanceOf(JournalEmittedDivergenceError);
  });
});
