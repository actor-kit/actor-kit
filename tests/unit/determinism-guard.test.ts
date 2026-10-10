/**
 * Determinism guards (ADR-016 §5). While a handler runs under testActor(), simulate() or replayJournal(),
 * the nondeterministic globals throw NondeterminismError (use ctx.now() / ctx.random() / ctx.id()). They
 * are restored afterwards, also when the handler throws. A service's fn is exempt; the Workers runtime
 * never patches globals.
 */

import { schema, uint32, view } from "@actor-kit/core";
import { replayJournal, simulate, testActor } from "@actor-kit/test";
import {
  createLiveFacts,
  defineActor,
  link,
  message,
  NondeterminismError,
  timer,
  withDeterminismGuard,
} from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const reads: Record<string, () => unknown> = {
  "Date.now()": () => Date.now(),
  "new Date()": () => new Date(),
  "Date()": () => Date(),
  "performance.now()": () => performance.now(),
  "Math.random()": () => Math.random(),
  "crypto.randomUUID()": () => crypto.randomUUID(),
  "crypto.getRandomValues()": () => crypto.getRandomValues(new Uint8Array(4)),
};

function thrown(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("withDeterminismGuard", () => {
  it.each(Object.keys(reads))("%s throws NondeterminismError inside, naming what to use", (name) => {
    const error = thrown(() => withDeterminismGuard(() => reads[name]?.()));
    expect(error).toBeInstanceOf(NondeterminismError);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/NondeterminismError: .* is not allowed in a handler: use ctx\.(now|random|id)\(\)/);
  });

  it("names the ctx function for each global", () => {
    const message = (name: string) => String(thrown(() => withDeterminismGuard(() => reads[name]?.())));
    expect(message("Date.now()")).toContain("Date.now() is not allowed in a handler: use ctx.now()");
    expect(message("new Date()")).toContain("use ctx.now()");
    expect(message("performance.now()")).toContain("use ctx.now()");
    expect(message("Math.random()")).toContain("use ctx.random()");
    expect(message("crypto.randomUUID()")).toContain("use ctx.id()");
    expect(message("crypto.getRandomValues()")).toContain("use ctx.random()");
  });

  it("dates from a value still work, and Date is still Date", () => {
    withDeterminismGuard(() => {
      expect(new Date(0).toISOString()).toBe("1970-01-01T00:00:00.000Z");
      expect(Date.UTC(2020, 0, 1)).toBe(1577836800000);
      expect(Date.parse("1970-01-01T00:00:01Z")).toBe(1000);
      expect(new Date(5) instanceof Date).toBe(true);
    });
  });

  it("restores every global afterwards, also when the handler throws, and returns its value", () => {
    const before = { now: Date.now, Date, random: Math.random, perf: performance.now, uuid: crypto.randomUUID };
    const getRandomValues = crypto.getRandomValues;
    expect(withDeterminismGuard(() => 42)).toBe(42);
    expect(() =>
      withDeterminismGuard(() => {
        throw new Error("handler failed");
      }),
    ).toThrow("handler failed");
    expect({ now: Date.now, Date, random: Math.random, perf: performance.now, uuid: crypto.randomUUID }).toEqual(
      before,
    );
    expect(crypto.getRandomValues).toBe(getRandomValues);
    const descriptors = () => ({
      perf: Object.getOwnPropertyDescriptor(performance, "now"),
      random: Object.getOwnPropertyDescriptor(Math, "random"),
      uuid: Object.getOwnPropertyDescriptor(crypto, "randomUUID"),
    });
    const own = descriptors();
    withDeterminismGuard(() => undefined);
    expect(descriptors()).toEqual(own);
    expect(typeof Date.now()).toBe("number");
    expect(typeof crypto.randomUUID()).toBe("string");
  });

  it("nests: the inner guard leaves the outer one in place", () => {
    withDeterminismGuard(() => {
      withDeterminismGuard(() => undefined);
      expect(() => Math.random()).toThrow(NondeterminismError);
    });
    expect(typeof Math.random()).toBe("number");
  });

  it("ctx.now(), ctx.id() and ctx.random() still read the real sources inside", () => {
    const { ctx } = createLiveFacts();
    withDeterminismGuard(() => {
      expect(typeof ctx.now()).toBe("number");
      expect(ctx.id()).toMatch(/^[0-9a-f-]{36}$/);
      expect(ctx.random()).toBeLessThan(1);
    });
  });
});

type S = { n: number; at: number };

const Clocky = defineActor("clocky", {
  input: z.object({}),
  init: (): S => ({ n: 0, at: 0 }),
  roles: { any: () => true },
  services: {
    fetchTime: {
      fn: async () => Date.now(),
      onDone: (s: S) => ({ ...s, at: Date.now() }),
      onError: (s: S) => ({ ...s, at: Math.random() }),
    },
  },
  timers: { tick: timer(z.object({}), (s: S) => ({ ...s, at: performance.now() })) },
  lifecycle: { connect: (s: S) => ({ ...s, at: Date.now() }) },
  messages: {
    GOOD: message(z.object({}), (s: S, _p, ctx) => ({ n: s.n + 1, at: ctx.now() })),
    BAD: message(z.object({}), (s: S) => ({ ...s, at: Date.now() })),
    FETCH: message(z.object({}), (s: S, _p, ctx) => {
      ctx.execute("fetchTime", {});
      return s;
    }),
    LATER: message(z.object({}), (s: S, _p, ctx) => {
      ctx.schedule("tick", { in: "1s", payload: {} });
      return s;
    }),
  },
  views: { any: view.shared(schema({ n: uint32 }), (s: S) => ({ n: s.n })) },
});

describe("testActor", () => {
  it("a handler that reads Date.now() fails its first unit test", async () => {
    const t = testActor(Clocky);
    const state = t.init({});
    expect((await t.send(state, "u", { type: "GOOD" })).state.n).toBe(1);
    await expect(t.send(state, "u", { type: "BAD" })).rejects.toBeInstanceOf(NondeterminismError);
    expect(typeof Date.now()).toBe("number");
  });

  it("init is guarded", () => {
    const Bad = defineActor("bad-init", {
      input: z.object({}),
      init: () => ({ at: Date.now() }),
      roles: { any: () => true },
      messages: {},
      views: { any: view.shared(schema({ n: uint32 }), () => ({ n: 0 })) },
    });
    expect(() => testActor(Bad).init({})).toThrow(NondeterminismError);
  });
});

describe("simulate", () => {
  it("guards messages, onDone, onError, timers and lifecycle; never a service's fn", async () => {
    const sim = simulate();
    const actor = await sim.spawn(Clocky, "c", {});
    expect(() => actor.send("u", { type: "BAD" })).toThrow(NondeterminismError);
    actor.send("u", { type: "FETCH" });
    expect(() => sim.resolve(sim.pendingEffects()[0] ?? "", 1)).toThrow(NondeterminismError);
    actor.send("u", { type: "FETCH" });
    expect(() => sim.reject(sim.pendingEffects().at(-1) ?? "", "x")).toThrow(NondeterminismError);
    actor.send("u", { type: "LATER" });
    expect(() => sim.advance("1s")).toThrow(NondeterminismError);
    expect(() => actor.connect("u")).toThrow(NondeterminismError);
    expect(typeof Math.random()).toBe("number");
    await expect(Clocky.def.services.fetchTime.fn()).resolves.toEqual(expect.any(Number));
  });

  it("guards link callbacks", async () => {
    const Source = defineActor("source", {
      input: z.object({}),
      init: () => ({ v: 1 }),
      roles: { any: () => true },
      messages: {},
      views: { any: view.shared(schema({ v: uint32 }), (s: { v: number }) => s) },
    });
    const Watcher = defineActor("watcher", {
      input: z.object({}),
      init: () => ({ seen: 0 }),
      roles: { any: () => true },
      links: { source: link(Source, { onUpdate: (s: { seen: number }) => ({ seen: s.seen + Math.random() }) }) },
      messages: {
        WATCH: message(z.object({}), (s: { seen: number }, _p, ctx) => {
          ctx.link("source", "s1");
          return s;
        }),
      },
      views: { any: view.shared(schema({ seen: uint32 }), () => ({ seen: 0 })) },
    });
    const sim = simulate({ contracts: [Source, Watcher] });
    await sim.spawn(Source, "s1", {});
    const watcher = await sim.spawn(Watcher, "w1", {});
    expect(() => watcher.send("u", { type: "WATCH" })).toThrow(NondeterminismError);
  });
});

describe("replayJournal", () => {
  it("a handler that reads the clock fails replay with NondeterminismError", async () => {
    const sim = simulate();
    const actor = await sim.spawn(Clocky, "c", {});
    actor.send("u", { type: "GOOD" });
    await replayJournal(Clocky, actor.journal);
    const Drifted = defineActor("clocky", {
      ...Clocky.def,
      messages: { ...Clocky.def.messages, GOOD: message(z.object({}), (s: S) => ({ ...s, at: Date.now() })) },
    });
    await expect(replayJournal(Drifted, actor.journal)).rejects.toBeInstanceOf(NondeterminismError);
  });
});

describe("guard edges (mutation)", () => {
  it.each(Object.keys(reads))("the message starts with what was called: %s", (name) => {
    expect(String(thrown(() => withDeterminismGuard(() => reads[name]?.())))).toContain(`${name} is not allowed`);
  });

  it("ctx.now() works inside nested guards", () => {
    const { ctx } = createLiveFacts();
    withDeterminismGuard(() => withDeterminismGuard(() => expect(typeof ctx.now()).toBe("number")));
  });

  it("a raw definition's handlers see an empty env when none is given", async () => {
    const t = testActor({
      input: z.object({}),
      init: () => ({ env: null as unknown }),
      roles: { any: () => true },
      messages: {
        any: {
          ENV: {
            schema: z.object({}),
            handler: (_s: { env: unknown }, _p: unknown, ctx: unknown) => ({
              env: ctx !== null && typeof ctx === "object" && "env" in ctx ? ctx.env : "none",
            }),
          },
        },
      },
      views: { any: { fn: () => ({}) } },
    });
    expect((await t.send(t.init({}), "u", { type: "ENV" })).state).toEqual({ env: {} });
  });
});
