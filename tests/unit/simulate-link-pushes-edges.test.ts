/**
 * simulate() link pushes, edge cases: which links a push follows (type and id both match), views
 * that are not objects, subscribers with no view, onUpdate that changes nothing, unlink(name)
 * keeping the subscription (as the runtime does), undeclared and link-less unlinks, and timer
 * order ties (same deadline: by seq, then by index).
 */
import { schema, string, uint32, view } from "@actor-kit/core";
import { simulate } from "@actor-kit/test";
import { defineActor, link, message, timer } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

type Src = { v: string; shape: "object" | "array" | "string" };
const SourceContract = defineActor("source", {
  input: z.object({}),
  init: (): Src => ({ v: "a", shape: "object" }),
  roles: {
    silent: (_s: Src, caller: string) => caller.endsWith(":mute"),
    any: () => true,
  },
  messages: {
    SET: message(z.object({ v: z.string() }), (s: Src, { v }) => ({ ...s, v })),
    SHAPE: message(z.object({ shape: z.enum(["object", "array", "string"]) }), (s: Src, { shape }) => ({
      ...s,
      shape,
    })),
  },
  views: {
    any: {
      fn: (s: Src) => (s.shape === "object" ? { v: s.v } : s.shape === "array" ? [s.v] : `str-${s.v}`),
    },
  },
});

type Sink = { got: unknown[]; touched: number };
const SinkContract = defineActor("sink", {
  input: z.object({}),
  init: (): Sink => ({ got: [], touched: 0 }),
  roles: { any: () => true },
  links: {
    src: link(SourceContract, {
      onUpdate: (s: Sink, linked: unknown) => ({ ...s, got: [...s.got, linked] }),
    }),
    quiet: link(SourceContract, { onUpdate: (s: Sink) => s }),
  },
  messages: {
    FOLLOW: message(z.object({ id: z.string(), via: z.string().default("src") }), (s: Sink, { id, via }, ctx) => {
      ctx.link(via, id);
      return s;
    }),
    DROP: message(z.object({ name: z.string(), id: z.string().optional() }), (s: Sink, { name, id }, ctx) => {
      ctx.unlink(name, id);
      return s;
    }),
    TOUCH: message(z.object({}), (s: Sink) => ({ ...s, touched: s.touched + 1 })),
  },
  views: { any: view.shared(schema({ n: uint32 }), (s: Sink) => ({ n: s.got.length })) },
});

async function world() {
  const sim = simulate({ contracts: [SourceContract, SinkContract] });
  const s1 = await sim.spawn(SourceContract, "s1", {});
  const s2 = await sim.spawn(SourceContract, "s2", {});
  const sink = await sim.spawn(SinkContract, "k1", {});
  return { sim, s1, s2, sink };
}

describe("simulate: which links a push follows", () => {
  it("only links to that type and that id", async () => {
    const { sim, s2, sink } = await world();
    sink.send("u", { type: "FOLLOW", id: "s1" });
    s2.send("u", { type: "SET", v: "other source" });
    expect(sink.state.got).toEqual([{ v: "a", role: "any" }]);
    // An actor of another type with the followed id pushes nothing to the sink.
    const twin = await sim.spawn(SinkContract, "s1", {});
    twin.send("u", { type: "TOUCH" });
    expect(sink.state.got).toHaveLength(1);
  });

  it("a view that is not an object arrives as just the role", async () => {
    const { s1, sink } = await world();
    sink.send("u", { type: "FOLLOW", id: "s1" });
    s1.send("u", { type: "SHAPE", shape: "array" });
    s1.send("u", { type: "SHAPE", shape: "string" });
    expect(sink.state.got).toEqual([{ v: "a", role: "any" }, { role: "any" }, { role: "any" }]);
  });

  it("a subscriber whose role has no view gets nothing", async () => {
    const sim = simulate({ contracts: [SourceContract, SinkContract] });
    const s1 = await sim.spawn(SourceContract, "s1", {});
    const mute = await sim.spawn(SinkContract, "mute", {});
    mute.send("u", { type: "FOLLOW", id: "s1" });
    s1.send("u", { type: "SET", v: "b" });
    expect(mute.state.got).toEqual([]);
  });

  it("an onUpdate that changes nothing is not committed (no journal event)", async () => {
    const { s1, sink } = await world();
    sink.send("u", { type: "FOLLOW", id: "s1", via: "quiet" });
    s1.send("u", { type: "SET", v: "b" });
    expect(sink.journal.events.map((e) => e.causeType)).toEqual(["init", "message"]);
  });
});

describe("simulate: unlinks and subscriptions", () => {
  it("unlink(name) keeps the subscription: a re-link to an unchanged view gets no new push", async () => {
    const { sink } = await world();
    sink.send("u", { type: "FOLLOW", id: "s1" });
    sink.send("u", { type: "DROP", name: "src" });
    sink.send("u", { type: "FOLLOW", id: "s1" });
    expect(sink.state.got).toHaveLength(1);
  });

  it("unlink(name, id) of another target leaves this one's subscription alone", async () => {
    const { s1, sink } = await world();
    sink.send("u", { type: "FOLLOW", id: "s1" });
    sink.send("u", { type: "FOLLOW", id: "s2" });
    sink.send("u", { type: "DROP", name: "src", id: "s2" });
    expect(sink.state.got).toHaveLength(2);
    // s1's dedupe is untouched: the same view is not pushed again.
    s1.send("u", { type: "SET", v: "a" });
    expect(sink.state.got).toHaveLength(2);
    sink.send("u", { type: "FOLLOW", id: "s2" });
    expect(sink.state.got).toHaveLength(3);
    expect(sink.links).toEqual([
      { name: "src", id: "s1" },
      { name: "src", id: "s2" },
    ]);
  });

  it("unlinking an undeclared link, or from an actor with no links, is a no-op", async () => {
    const { sink } = await world();
    expect(sink.send("u", { type: "DROP", name: "nowhere", id: "s1" })).toEqual({ ok: true });
    const Loner = defineActor("loner", {
      input: z.object({}),
      init: () => ({}),
      roles: { any: () => true },
      messages: {
        DROP: message(z.object({}), (s: object, _p, ctx) => {
          ctx.unlink("anything", "x");
          return s;
        }),
      },
      views: {},
    });
    const sim = simulate();
    const loner = await sim.spawn(Loner, "l1", {});
    expect(loner.send("u", { type: "DROP" })).toEqual({ ok: true });
  });
});

describe("simulate: init link views", () => {
  it("a string view is not spread: the init gets just the role", async () => {
    const sim = simulate({ contracts: [SourceContract] });
    const s1 = await sim.spawn(SourceContract, "s1", {});
    s1.send("u", { type: "SHAPE", shape: "string" });
    const Reader = defineActor("reader", {
      input: z.object({}),
      init: async (_i: unknown, ctx: { link(n: string, id: string): Promise<unknown> }) => ({
        v: await ctx.link("src", "s1"),
      }),
      roles: { any: () => true },
      links: { src: link(SourceContract, { onUpdate: (s: { v: unknown }) => s }) },
      messages: {},
      views: {},
    });
    expect((await sim.spawn(Reader, "r1", {})).state).toEqual({ v: { role: "any" } });
  });
});

describe("simulate: timers due at the same moment", () => {
  type Log = { fired: string[] };
  const Clock = defineActor("clock", {
    input: z.object({}),
    init: (): Log => ({ fired: [] }),
    roles: { any: () => true },
    messages: {
      ONE: message(z.object({ key: z.string() }), (s: Log, { key }, ctx) => {
        ctx.schedule("tick", { at: 1000, key, payload: { key } });
        return s;
      }),
      TWO: message(z.object({ a: z.string(), b: z.string() }), (s: Log, { a, b }, ctx) => {
        ctx.schedule("tick", { at: 1000, key: a, payload: { key: a } });
        ctx.schedule("tick", { at: 1000, key: b, payload: { key: b } });
        return s;
      }),
    },
    timers: {
      tick: timer(z.object({ key: z.string() }), (s: Log, { key }) => ({ fired: [...s.fired, key] })),
    },
    views: { any: view.shared(schema({ n: string }), (s: Log) => ({ n: s.fired.join(",") })) },
  });

  it("fire in the order they were scheduled: by transition, then by position in it", async () => {
    const sim = simulate();
    const clock = await sim.spawn(Clock, "c1", {});
    clock.send("u", { type: "ONE", key: "first" });
    clock.send("u", { type: "TWO", a: "second", b: "third" });
    clock.send("u", { type: "ONE", key: "fourth" });
    sim.advance(1000);
    expect(clock.state.fired).toEqual(["first", "second", "third", "fourth"]);
  });
});
