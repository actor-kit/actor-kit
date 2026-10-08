/**
 * simulate() edges: the seeded sources exactly, default callers and caller types, effects of
 * lifecycle and timer handlers, cross-actor timer order, forwards, links, observe, and errors.
 */
import { schema, uint32, view } from "@actor-kit/core";
import { simulate, testActor } from "@actor-kit/test";
import { defineActor, link, message, timer, version } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { nextRandom, uuidFrom } from "../../packages/test/src/seeded";
import { toSimDef } from "../../packages/test/src/sim-def";

describe("seeded sources", () => {
  it("mulberry32 from a known state", () => {
    const first = nextRandom(1);
    expect(first.state).toBe(1831565814);
    expect(first.value).toBeCloseTo(0.6270739405881613, 15);
    expect(nextRandom(first.state).value).toBeCloseTo(0.002735721180215478, 15);
  });

  it("uuids put random hex in x, the variant in y, and 4 in the version slot", () => {
    expect(uuidFrom(() => 0)).toBe("00000000-0000-4000-8000-000000000000");
    expect(uuidFrom(() => 0.999)).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(uuidFrom(() => 0.5)).toBe("88888888-8888-4888-8888-888888888888");
  });
});

describe("toSimDef", () => {
  const base = { input: z.object({}), init: () => ({}), roles: { r: () => true }, views: {} };

  it("works without messages", () => {
    expect(toSimDef({ name: "a", def: base }).messages).toEqual({ r: {} });
  });

  it.each([
    ["no input.safeParse", { ...base, input: {} }],
    ["no roles", { ...base, roles: null }],
    ["no views", { ...base, views: undefined }],
    ["no init", { ...base, init: 1 }],
  ])("refuses a def with %s", (_what, def) => {
    expect(() => toSimDef({ name: "x", def })).toThrow(/not an actor contract/);
  });

  it.each([
    ["a non-object", 1],
    ["no handler", { schema: z.object({}) }],
    ["no schema", { handler: () => 1 }],
  ])("refuses a message that is %s", (_what, slot) => {
    expect(() => toSimDef({ name: "x", def: { ...base, messages: { M: slot } } })).toThrow(
      /not a message\(\) definition/,
    );
  });
});

type S = { log: string[] };
const add = (s: S, line: string): S => ({ log: [...s.log, line] });

const HubState = z.object({ log: z.array(z.string()) });
const ClockState = z.object({ n: z.number() });

const Hub = defineActor("hub", {
  versions: [version(1, HubState), version(2, HubState), version(3, HubState)],
  input: z.object({}),
  init: (): S => ({ log: [] }),
  roles: {
    sys: (_s: S, caller: string) => caller === "system",
    svc: (_s: S, _c: string, { callerType }: { callerType: string }) => callerType === "service",
    user: (_s: S, _c: string, { callerType }: { callerType: string }) => callerType === "user",
  },
  messages: {
    WHO: message(z.object({}), {
      guard: (_s: S, _p: unknown, ctx: { caller: string; callerType: string; role: string; env: unknown }) =>
        ctx.caller !== "blocked" && ctx.env !== "off",
      handler: (s: S, _p, ctx) => add(s, `${ctx.caller}:${ctx.callerType}:${ctx.role}`),
    }),
    FORWARD: message(z.object({ link: z.string(), to: z.string() }), (s: S, { link: name, to }, ctx) => {
      ctx.forward(name, to, { type: "WHO" });
      return s;
    }),
    LINKS: message(z.object({}), (s: S, _p, ctx) => {
      ctx.link("feed", "x");
      ctx.link("news", "x");
      ctx.link("feed", "y");
      return s;
    }),
    DROP_FEED_X: message(z.object({}), (s: S, _p, ctx) => {
      ctx.unlink("feed", "x");
      return s;
    }),
    DROP_NEWS: message(z.object({}), (s: S, _p, ctx) => {
      ctx.unlink("news");
      return s;
    }),
    LATER: message(z.object({ inMs: z.number(), tag: z.string() }), (s: S, { inMs, tag }, ctx) => {
      ctx.schedule("ping", { in: inMs, payload: { tag } });
      return s;
    }),
    SCHEDULE_THEN_CANCEL: message(z.object({}), (s: S, _p, ctx) => {
      ctx.schedule("ping", { in: 5, key: "k", payload: { tag: "k" } });
      ctx.cancel("k");
      return s;
    }),
    LOOP: message(z.object({}), (s: S, _p, ctx) => {
      ctx.schedule("loop", { in: 0, key: "loop" });
      return s;
    }),
    SAME: message(z.object({}), (s: S) => s),
  },
  timers: {
    ping: timer(z.object({ tag: z.string() }), (s: S, { tag }, ctx) => {
      ctx.forward("hub", "h2", { type: "WHO" });
      return add(s, `ping:${tag}@${ctx.now()}`);
    }),
    loop: timer(z.unknown(), (s: S, _p, ctx) => {
      ctx.schedule("loop", { in: 0, key: "loop" });
      return s;
    }),
  },
  services: {
    SAVE: {
      fn: async () => null,
      onDone: (s: S) => s,
      onError: (s: S, error: { message: string }) => add(s, `error:${error.message}`),
    },
  },
  lifecycle: {
    connect: (s: S, e: { caller: string }, ctx: { execute(n: string, i: unknown): void }) => {
      if (e.caller === "saver") ctx.execute("SAVE", {});
      return s;
    },
    disconnect: (s: S, e: { caller: string }, ctx: { schedule(n: string, o: unknown): void }) => {
      if (e.caller === "saver") ctx.schedule("ping", { in: 5, payload: { tag: "bye" } });
      return s;
    },
  },
  links: {
    feed: link(
      { name: "hub" },
      { onUpdate: (s: S) => s, onUnlink: (s: S, id?: string) => add(s, `unlink:feed:${id}`) },
    ),
    news: link(
      { name: "hub" },
      { onUpdate: (s: S) => s, onUnlink: (s: S, id?: string) => add(s, `unlink:news:${id}`) },
    ),
  },
  views: {
    sys: view.shared(schema({ n: uint32 }), (s: S) => ({ n: s.log.length })),
    user: view.shared(schema({ n: uint32 }), (s: S) => ({ n: s.log.length })),
  },
});

async function hubs(names = ["h1", "h2"], env: unknown = { E: 1 }) {
  const sim = simulate({ contracts: [Hub], env, now: 0 });
  for (const name of names) await sim.spawn(Hub, name, {});
  return sim;
}

describe("simulate: callers", () => {
  it("defaults to user callers and passes caller, type, role and env to guard and handler", async () => {
    const sim = await hubs();
    const h1 = sim.actor(Hub, "h1");
    expect(h1.role("bob")).toBe("user");
    expect(h1.view("bob")).toEqual({ n: 0 });
    h1.send("bob", { type: "WHO" });
    h1.send("ops", { type: "WHO" }, { callerType: "service" });
    expect(h1.send("blocked", { type: "WHO" })).toEqual({ ok: false, error: "guard_failed" });
    expect(h1.state.log).toEqual(["bob:user:user", "ops:service:svc"]);
  });

  it("a guard sees the simulation's env", async () => {
    const sim = await hubs(["h1"], "off");
    expect(sim.actor(Hub, "h1").send("bob", { type: "WHO" })).toEqual({ ok: false, error: "guard_failed" });
  });

  it("a role without a view is an error", async () => {
    const sim = await hubs();
    expect(() => sim.actor(Hub, "h1").view("ops", { callerType: "service" })).toThrow(
      'simulate: no view for role "svc"',
    );
  });

  it("journals the code version", async () => {
    const sim = await hubs();
    const h1 = sim.actor(Hub, "h1");
    h1.send("bob", { type: "WHO" });
    expect(h1.journal.events.map((e) => e.codeVersion)).toEqual([3, 3]);
  });

  it("init is journaled with the system service caller unless one is given", async () => {
    const sim = simulate({ contracts: [Hub] });
    const a = await sim.spawn(Hub, "a", {});
    const b = await sim.spawn(Hub, "b", {}, { caller: "jon", callerType: "user" });
    expect(a.journal.events[0]).toMatchObject({ caller: "system", callerType: "service" });
    expect(b.journal.events[0]).toMatchObject({ caller: "jon", callerType: "user" });
  });

  it("observe.onTransition sees the state before and after with the caller and role", async () => {
    const seen: unknown[] = [];
    const Observed = defineActor("observed", {
      ...Hub.def,
      observe: {
        onTransition: (prev: unknown, next: unknown, event: unknown, ctx: unknown) =>
          void seen.push({ prev, next, event, ctx }),
      },
    });
    const sim = simulate();
    const o = await sim.spawn(Observed, "o", {});
    o.send("bob", { type: "WHO" });
    expect(seen).toEqual([
      {
        prev: { log: [] },
        next: { log: ["bob:user:user"] },
        event: { type: "WHO" },
        ctx: { caller: "bob", role: "user" },
      },
    ]);
  });
});

describe("simulate: lifecycle effects", () => {
  it("a connect that only executes, or a disconnect that only schedules, is still journaled", async () => {
    const sim = await hubs();
    const h1 = sim.actor(Hub, "h1");
    const conn = h1.connect("saver");
    expect(sim.pendingEffects().map((e) => e.service)).toEqual(["SAVE"]);
    conn.disconnect();
    expect(h1.timers.map((t) => t.name)).toEqual(["ping"]);
    expect(h1.journal.events.map((e) => e.causeType)).toEqual(["init", "lifecycle.connect", "lifecycle.disconnect"]);
  });

  it("a connect that changes nothing writes nothing", async () => {
    const sim = await hubs();
    sim.actor(Hub, "h1").connect("bob").disconnect();
    expect(sim.actor(Hub, "h1").journal.events).toHaveLength(1);
  });

  it("a settled effect that changes nothing writes nothing; reject accepts an Error-like object", async () => {
    const sim = await hubs();
    const h1 = sim.actor(Hub, "h1");
    h1.connect("saver");
    h1.connect("saver");
    const [first, second] = sim.pendingEffects();
    sim.resolve(first ?? "", null);
    expect(h1.journal.events).toHaveLength(3);
    sim.reject(second ?? "", { message: "disk full" });
    expect(h1.state.log).toEqual(["error:disk full"]);
  });

  it("names the effect id when a pending effect object is not found", async () => {
    const sim = await hubs();
    expect(() =>
      sim.resolve({ actor: { type: "hub", id: "h1" }, effectId: "9:9", service: "SAVE", input: {} }, 1),
    ).toThrow('No pending effect "9:9"');
  });
});

describe("simulate: timers across actors", () => {
  it("fires the earliest timer of any actor first; ties go to the actor spawned first", async () => {
    const sim = await hubs(["h1", "h2", "h3"]);
    sim.actor(Hub, "h3").send("bob", { type: "LATER", inMs: 10, tag: "h3-10" });
    sim.actor(Hub, "h2").send("bob", { type: "LATER", inMs: 20, tag: "h2-20" });
    sim.actor(Hub, "h1").send("bob", { type: "LATER", inMs: 20, tag: "h1-20" });
    const order: string[] = [];
    const logLength = (id: string) => sim.actor(Hub, id).state.log.length;
    const counts = { h1: logLength("h1"), h2: logLength("h2"), h3: logLength("h3") };
    sim.advance(30);
    for (const id of ["h1", "h2", "h3"] as const) {
      for (const line of sim.actor(Hub, id).state.log.slice(counts[id])) if (line.startsWith("ping")) order.push(line);
    }
    expect(order.sort((a, b) => Number(a.split("@")[1]) - Number(b.split("@")[1]))).toEqual([
      "ping:h3-10@10",
      "ping:h1-20@20",
      "ping:h2-20@20",
    ]);
    // h2 got a WHO forwarded by each ping, from the timer, as a service caller.
    expect(sim.actor(Hub, "h2").state.log.filter((l) => l.startsWith("timer:"))).toEqual([
      "timer:ping:service:svc",
      "timer:ping:service:svc",
      "timer:ping:service:svc",
    ]);
  });

  it("a timer scheduled and cancelled in one transition never exists", async () => {
    const sim = await hubs();
    sim.actor(Hub, "h1").send("bob", { type: "SCHEDULE_THEN_CANCEL" });
    expect(sim.actor(Hub, "h1").timers).toEqual([]);
  });

  it("orders one actor's timers by deadline, then by effect id", async () => {
    const sim = await hubs();
    const h1 = sim.actor(Hub, "h1");
    h1.send("bob", { type: "LATER", inMs: 50, tag: "a" });
    h1.send("bob", { type: "LATER", inMs: 10, tag: "b" });
    h1.send("bob", { type: "LATER", inMs: 10, tag: "c" });
    expect(h1.timers.map((t) => t.payload)).toEqual([{ tag: "b" }, { tag: "c" }, { tag: "a" }]);
  });

  it("stops a timer that reschedules itself forever", async () => {
    const sim = await hubs();
    sim.actor(Hub, "h1").send("bob", { type: "LOOP" });
    expect(() => sim.advance(1)).toThrow("simulate: more than 10000 timers fired in one advance (a timer loop?)");
  });
});

describe("simulate: forwards and links", () => {
  it("an undeclared link name is a contract name in kebab case", async () => {
    const sim = await hubs();
    sim.actor(Hub, "h1").send("bob", { type: "FORWARD", link: "SOME_HUB", to: "h2" });
    expect(sim.failedForwards()).toEqual([
      { from: { type: "hub", id: "h1" }, to: { type: "some-hub", id: "h2" }, message: { type: "WHO" } },
    ]);
  });

  it("a declared link forwards to its contract, as the original caller and caller type", async () => {
    const sim = await hubs();
    sim.actor(Hub, "h1").send("ops", { type: "FORWARD", link: "feed", to: "h2" }, { callerType: "service" });
    expect(sim.actor(Hub, "h2").state.log).toEqual(["ops:service:svc"]);
  });

  it("keeps links per name: the same id under two names, unlink by id or by name touches only its name", async () => {
    const sim = await hubs();
    const h1 = sim.actor(Hub, "h1");
    h1.send("bob", { type: "LINKS" });
    expect(h1.links).toEqual([
      { name: "feed", id: "x" },
      { name: "news", id: "x" },
      { name: "feed", id: "y" },
    ]);
    h1.send("bob", { type: "DROP_FEED_X" });
    expect(h1.links).toEqual([
      { name: "news", id: "x" },
      { name: "feed", id: "y" },
    ]);
    h1.send("bob", { type: "DROP_NEWS" });
    expect(h1.links).toEqual([{ name: "feed", id: "y" }]);
    expect(h1.state.log).toEqual(["unlink:feed:x", "unlink:news:x"]);
  });

  it("an actor without links ignores link() calls", async () => {
    const Bare = defineActor("bare", { ...Hub.def, links: undefined });
    const sim = simulate();
    const b = await sim.spawn(Bare, "b", {});
    b.send("bob", { type: "LINKS" });
    expect(b.links).toEqual([]);
  });

  it("an init link needs a role for the system caller, and a non-object view becomes just the role", async () => {
    const Source = defineActor("source", {
      input: z.object({}),
      init: () => ({}),
      roles: { system: (_s: unknown, caller: string) => caller === "system" },
      messages: {},
      views: { system: { fn: () => null } },
    });
    const Closed = defineActor("closed", { ...Source.def, roles: { nobody: () => false } });
    const Reader = (target: string) =>
      defineActor(`reader-${target}`, {
        input: z.object({}),
        init: async (_i: unknown, ctx: { link(n: string, id: string): Promise<unknown> }) => ({
          v: await ctx.link("src", "s1"),
        }),
        roles: { any: () => true },
        messages: {},
        views: {},
        links: { src: link({ name: target }, { onUpdate: (s: unknown) => s }) },
      });
    const sim = simulate({ contracts: [Source, Closed] });
    await sim.spawn(Source, "s1", {});
    await sim.spawn(Closed, "s1", {});
    expect((await sim.spawn(Reader("source"), "r", {})).state).toEqual({ v: { role: "system" } });
    await expect(sim.spawn(Reader("closed"), "r", {})).rejects.toThrow('Link "src": no role for the linking actor');
  });
});

describe("testActor rejections", () => {
  const t = testActor(Hub);
  const state = t.init({});

  /** The Error a rejected send() carries (vitest's rejects.toThrow(string) accepts `undefined`). */
  async function rejection(run: () => Promise<unknown>): Promise<string> {
    try {
      await run();
    } catch (error) {
      if (error instanceof Error) return error.message;
      return `non-error: ${String(error)}`;
    }
    return "(resolved)";
  }

  it("say what was rejected", async () => {
    const unknownMessage: { type: string; [key: string]: unknown } = { type: "NOPE" };
    const badPayload: { type: string; [key: string]: unknown } = { type: "LATER", inMs: "x", tag: 1 };
    expect(await rejection(() => t.send(state, "bob", unknownMessage))).toBe(
      'Message "NOPE" not found for role "user"',
    );
    expect(await rejection(() => t.send(state, "bob", badPayload))).toMatch(/^Validation failed for "LATER": .*inMs/s);
    expect(await rejection(() => t.send(state, "blocked", { type: "WHO" }))).toBe('Guard rejected "WHO"');
  });
});

const fired: string[] = [];
const Clock = defineActor("clock", {
  versions: [version(1, ClockState), version(4, ClockState)],
  input: z.object({}),
  init: () => ({ n: 0 }),
  roles: { any: () => true },
  messages: {
    AT: message(z.object({ at: z.number(), tag: z.string() }), (s: { n: number }, { at, tag }, ctx) => {
      ctx.schedule("tick", { at, key: tag, payload: { tag } });
      return s;
    }),
    COUNT: message(z.object({}), (s: { n: number }, _p, ctx) => {
      ctx.schedule("count", { in: 0, key: "count" });
      return s;
    }),
    ECHO: message(z.object({}), (s: { n: number }) => ({ n: s.n + 1 })),
  },
  timers: {
    tick: timer(z.object({ tag: z.string() }), (s: { n: number }, { tag }) => {
      fired.push(tag);
      return s;
    }),
    count: timer(z.unknown(), (s: { n: number }, _p, ctx) => {
      ctx.schedule("count", { in: 0, key: "count" });
      return { n: s.n + 1 };
    }),
  },
  lifecycle: {
    connect: (
      s: { n: number },
      _e: unknown,
      ctx: { execute(n: string, i: unknown): void; forward(l: string, t: string, m: { type: string }): void },
    ) => {
      ctx.execute("NOOP", {});
      ctx.forward("clock", "c2", { type: "ECHO" });
      return s;
    },
  },
  services: { NOOP: { fn: async () => null } },
  views: {},
  journal: { checkpointEvery: 2 },
  observe: {},
});

describe("simulate: ordering and bookkeeping", () => {
  it("fires timers across actors by deadline, ties to the actor spawned first, then seq and index", async () => {
    fired.length = 0;
    const sim = simulate({ now: 0 });
    const c1 = await sim.spawn(Clock, "c1", {});
    const c2 = await sim.spawn(Clock, "c2", {});
    c2.send("u", { type: "AT", at: 30, tag: "c2-30" });
    c1.send("u", { type: "AT", at: 10, tag: "c1-10" });
    c2.send("u", { type: "AT", at: 20, tag: "c2-20a" });
    c2.send("u", { type: "AT", at: 20, tag: "c2-20b" });
    c1.send("u", { type: "AT", at: 20, tag: "c1-20" });
    sim.advance(100);
    expect(fired).toEqual(["c1-10", "c1-20", "c2-20a", "c2-20b", "c2-30"]);
  });

  it("an observe block without onTransition is fine", async () => {
    const sim = simulate();
    const c = await sim.spawn(Clock, "c", {});
    expect(c.send("u", { type: "ECHO" })).toEqual({ ok: true });
  });

  it("a connect that executes and forwards is committed, its forward sent as the connecting caller", async () => {
    const sim = simulate();
    const c1 = await sim.spawn(Clock, "c1", {});
    const c2 = await sim.spawn(Clock, "c2", {});
    c1.connect("jon", { callerType: "service" });
    expect(c1.journal.events.map((e) => e.causeType)).toEqual(["init", "lifecycle.connect"]);
    expect(c2.journal.events.at(-1)).toMatchObject({ causeType: "message", caller: "jon", callerType: "service" });
  });

  it("checkpoints carry the code version", async () => {
    const sim = simulate();
    const c = await sim.spawn(Clock, "c", {});
    c.send("u", { type: "ECHO" });
    expect(c.journal.checkpoints.map((k) => k.version)).toEqual([4]);
  });

  it("stops exactly at 10000 timer firings in one advance", async () => {
    const sim = simulate();
    const c = await sim.spawn(Clock, "c", {});
    c.send("u", { type: "COUNT" });
    expect(() => sim.advance(1)).toThrow(/more than 10000/);
    expect(c.state.n).toBe(10_000);
  });
});
