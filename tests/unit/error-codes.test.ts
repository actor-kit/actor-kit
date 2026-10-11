/**
 * ADR-018 C: each library error has a stable code. One row per throw site: the call that fails and the
 * code it must carry (the message is pinned by the module's own tests).
 */
import { buildUrl } from "@actor-kit/client";
import { ActorKitError, parseFrame } from "@actor-kit/core";
import { replayJournal, simulate, testActor } from "@actor-kit/test";
import {
  applyJournalEvent,
  checksumState,
  compileVersions,
  createRef,
  defineActor,
  foldJournal,
  JournalDivergenceError,
  JournalEmittedDivergenceError,
  type JournalEvent,
  JournalNondeterminismError,
  JournalVersionError,
  link,
  message,
  parseDuration,
  parseTimelineOptions,
  phasedState,
  resolveJournalConfig,
  resolveNamespace,
  resolvePublish,
  resolveRetryPolicy,
  resolveTimeoutMs,
  routeMessage,
  sendToQueue,
  step,
  stepInit,
  toRuntimeDef,
  version,
  withDeterminismGuard,
} from "@actor-kit/worker/testing";
import { getCallerFromToken } from "@actor-kit/worker/token";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseInspectOptions, parseViewOptions } from "../../packages/worker/src/runtime/studio-protocol";
import { compileRedaction } from "../../packages/worker/src/runtime/studio-redact";

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof ActorKitError ? error.code : `not an ActorKitError: ${String(error)}`;
  }
  return "(no error)";
}

async function asyncCodeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof ActorKitError ? error.code : `not an ActorKitError: ${String(error)}`;
  }
  return "(no error)";
}

function ev(partial: Partial<JournalEvent> & Pick<JournalEvent, "causeType">): JournalEvent {
  return {
    seq: 1,
    name: null,
    payload: {},
    caller: null,
    callerType: null,
    role: null,
    facts: {},
    codeVersion: 1,
    stateChecksum: "",
    createdAt: 0,
    ...partial,
  };
}

const noFacts = {
  ctx: { now: () => 0, id: () => "id", random: () => 0 },
  unlinkTargets: () => [],
  recorded: () => ({}),
};
const message0 = (name: string) =>
  ({ type: "message", name, payload: {}, caller: "u", callerType: "user", role: "r" }) as const;

describe("error codes: core and client-facing", () => {
  it.each([
    ["a short frame", () => parseFrame(new Uint8Array(2))],
    ["an unknown frame type", () => parseFrame(new Uint8Array([1, 99, 0, 0, 0, 0, 0, 0, 0, 0]))],
    ["an unknown control type", () => parseFrame(new Uint8Array([1, 4, 0, 0, 0, 0, 99]))],
  ])("%s is invalid_frame", (_label, run) => {
    expect(codeOf(run)).toBe("invalid_frame");
  });

  it("a client with no host outside a browser is missing_host", () => {
    expect(codeOf(() => buildUrl("/x"))).toBe("missing_host");
  });
});

describe("error codes: options and definitions", () => {
  it.each([
    ["invalid_timeout", () => resolveTimeoutMs(-1, "service")],
    ["invalid_duration", () => parseDuration("soon")],
    ["invalid_journal_option", () => resolveJournalConfig({ keep: 0 })],
    ["invalid_redact_pattern", () => compileRedaction([""])],
    ["invalid_redact_pattern", () => compileRedaction(["a..b"])],
    ["invalid_redact_pattern", () => compileRedaction(["a*"])],
    ["studio_unavailable", () => parseInspectOptions({ viewer: 5 })],
    ["studio_unavailable", () => parseTimelineOptions({ limit: -1 })],
    ["studio_unavailable", () => parseViewOptions({})],
    ["invalid_publish", () => resolvePublish({ queue: "", events: [] }, {}, {})],
    ["invalid_publish", () => resolvePublish({ queue: "Q", events: [] }, {}, { __publish: {} })],
    ["invalid_publish", () => resolvePublish({ queue: "Q", events: ["Nope"] }, {}, {})],
    ["invalid_retry", () => resolveRetryPolicy({ attempts: 0 })],
    ["invalid_versions", () => compileVersions([])],
    ["invalid_versions", () => compileVersions([version(2, z.object({})), version(1, z.object({}))])],
    ["invalid_versions", () => toRuntimeDef({ version: 1 })],
    [
      "invalid_versions",
      () =>
        toRuntimeDef({
          journal: false,
          versions: [version(1, z.object({})), version(2, z.object({}), { rebuild: "replay" })],
        }),
    ],
    ["actor_not_found", () => resolveNamespace("ghost", {}, {})],
    ["invalid_phased_state", () => phasedState({})],
  ])("%s", (code, run) => {
    expect(codeOf(run)).toBe(code);
  });

  it("createRef's argument errors", () => {
    const contract = defineActor("zone", {
      input: z.object({}),
      init: () => ({}),
      roles: {},
      messages: {},
      views: {},
    });
    const env = {};
    expect(codeOf(() => Reflect.apply(createRef, undefined, [contract, {}, env, 5]))).toBe("invalid_ref");
    expect(codeOf(() => Reflect.apply(createRef, undefined, [contract, 5, "z"]))).toBe("invalid_ref");
    expect(codeOf(() => createRef(contract, env, "z"))).toBe("actor_not_found");
  });

  it("token errors are invalid_token", async () => {
    const secret = "s".repeat(32);
    const key = new TextEncoder().encode(secret);
    const sign = (claims: Record<string, unknown>, sub?: string) => {
      const jwt = new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setJti("c1").setAudience("counter");
      return (sub === undefined ? jwt : jwt.setSubject(sub)).sign(key);
    };
    expect(
      await asyncCodeOf(async () => getCallerFromToken(await sign({ act: "user" }, "u"), "counter", "c2", secret)),
    ).toBe("invalid_token");
    expect(
      await asyncCodeOf(async () => getCallerFromToken(await sign({ act: "user" }), "counter", "c1", secret)),
    ).toBe("invalid_token");
    expect(
      await asyncCodeOf(async () => getCallerFromToken(await sign({ act: "admin" }, "u"), "counter", "c1", secret)),
    ).toBe("invalid_token");
  });
});

describe("error codes: the step core", () => {
  const states = { a: { messages: {} }, b: { local: z.object({ n: z.number() }), messages: {} } };

  it.each([
    ["async_handler", { messages: { r: { M: { handler: async () => ({}) } } } }, message0("M")],
    ["unknown_message", {}, message0("M")],
    [
      "invalid_schedule",
      {
        messages: {
          r: {
            M: {
              handler: (s: unknown, _p: unknown, ctx: { schedule(n: string, o: object): void }) => {
                ctx.schedule("t", {});
                return s;
              },
            },
          },
        },
        timers: { t: { schema: z.unknown(), handler: (s: unknown) => s } },
      },
      message0("M"),
    ],
    [
      "invalid_schedule",
      {
        messages: {
          r: {
            M: {
              handler: (s: unknown, _p: unknown, ctx: { schedule(n: string, o: object): void }) => {
                ctx.schedule("t", { at: Number.NaN });
                return s;
              },
            },
          },
        },
        timers: { t: { schema: z.unknown(), handler: (s: unknown) => s } },
      },
      message0("M"),
    ],
    [
      "undeclared_timer",
      {
        messages: {
          r: {
            M: {
              handler: (s: unknown, _p: unknown, ctx: { schedule(n: string, o: object): void }) => {
                ctx.schedule("t", { in: 1 });
                return s;
              },
            },
          },
        },
      },
      message0("M"),
    ],
    [
      "invalid_timer_payload",
      {
        messages: {
          r: {
            M: {
              handler: (s: unknown, _p: unknown, ctx: { schedule(n: string, o: object): void }) => {
                ctx.schedule("t", { in: 1, payload: 1 });
                return s;
              },
            },
          },
        },
        timers: { t: { schema: z.string(), handler: (s: unknown) => s } },
      },
      message0("M"),
    ],
    [
      "undeclared_event",
      {
        messages: {
          r: {
            M: {
              handler: (s: unknown, _p: unknown, ctx: { emit(n: string, p: unknown): void }) => {
                ctx.emit("E", {});
                return s;
              },
            },
          },
        },
      },
      message0("M"),
    ],
    [
      "invalid_event_payload",
      {
        events: { E: z.string() },
        messages: {
          r: {
            M: {
              handler: (s: unknown, _p: unknown, ctx: { emit(n: string, p: unknown): void }) => {
                ctx.emit("E", 1);
                return s;
              },
            },
          },
        },
      },
      message0("M"),
    ],
  ] as const)("%s", (code, def, cause) => {
    expect(codeOf(() => step(def, {}, cause, noFacts, {}))).toBe(code);
  });

  it("states: undeclared_state, invalid_local", () => {
    const shared = { shared: {}, phase: "a", local: null, stateTimers: [] };
    const goto = {
      a: {
        messages: {
          M: {
            schema: z.unknown(),
            handler: (s: unknown, _p: unknown, ctx: { goto(p: string, s: unknown): unknown }) => ctx.goto("zzz", s),
          },
        },
      },
    };
    expect(codeOf(() => step({ states: goto }, shared, message0("M"), noFacts, {}))).toBe("undeclared_state");
    const stay = {
      a: {
        local: z.object({ n: z.number() }),
        messages: {
          M: {
            schema: z.unknown(),
            handler: (s: unknown, _p: unknown, ctx: { stay(s: unknown, l: unknown): unknown }) =>
              ctx.stay(s, { n: "x" }),
          },
        },
      },
    };
    expect(codeOf(() => step({ states: stay }, shared, message0("M"), noFacts, {}))).toBe("invalid_local");
  });

  it("init: missing_initial, initial_state_local, invalid_actor_definition", async () => {
    const cause = { input: {}, caller: null, callerType: null };
    const io = { env: {}, link: async () => ({}) };
    expect(await asyncCodeOf(() => stepInit({ init: () => ({}), states }, cause, noFacts, io))).toBe("missing_initial");
    expect(await asyncCodeOf(() => stepInit({ init: () => ({}), states, initial: "b" }, cause, noFacts, io))).toBe(
      "initial_state_local",
    );
    expect(await asyncCodeOf(() => stepInit({}, cause, noFacts, io))).toBe("invalid_actor_definition");
  });

  it("the determinism guard throws nondeterminism", () => {
    expect(codeOf(() => withDeterminismGuard(() => Date.now()))).toBe("nondeterminism");
  });
});

describe("error codes: journal replay", () => {
  const add = { handler: (s: unknown) => s };
  it.each([
    [{ messages: { user: { ADD: add } } }, ev({ causeType: "message", name: "ADD", role: "user", caller: null })],
    [
      { messages: { user: { ADD: add } } },
      ev({ causeType: "message", name: null, role: "user", caller: "a", callerType: "user" }),
    ],
    [
      { messages: { user: { ADD: add } } },
      ev({ causeType: "message", name: "ADD", role: null, caller: "a", callerType: "user" }),
    ],
    [{}, ev({ causeType: "message", name: "ADD", role: "user", caller: "a", callerType: "user" })],
    [{}, ev({ causeType: "restore" })],
  ])("an event it cannot replay is journal_invalid (%#)", async (def, event) => {
    expect(await asyncCodeOf(() => applyJournalEvent(def, {}, event))).toBe("journal_invalid");
  });

  it("a gap in the sequence is journal_invalid", async () => {
    const def = { init: () => ({}) };
    const stateChecksum = checksumState(def, {});
    const events = [ev({ causeType: "init", stateChecksum }), ev({ causeType: "init", seq: 3, stateChecksum })];
    expect(await asyncCodeOf(() => foldJournal(def, { events, checkpoints: [] }))).toBe("journal_invalid");
  });
});

describe("error codes: test harness", () => {
  type S = { n: number };
  const Counter = defineActor("counter", {
    input: z.object({ n: z.number() }),
    init: ({ n }): S => ({ n }),
    roles: { owner: (_s: S, caller: string) => caller === "owner", lurker: () => true },
    messages: { INC: message(z.object({}), (s: S) => ({ n: s.n + 1 })) },
    views: { owner: { fn: (s: S) => s } },
  });

  it("testActor: invalid_input, no_view", () => {
    const t = testActor(Counter);
    expect(codeOf(() => Reflect.apply(t.init, t, [{ n: "x" }]))).toBe("invalid_input");
    expect(codeOf(() => t.view({ n: 0 }, "lurker"))).toBe("no_view");
  });

  it("simulate: spawn, lookups, connections, effects, rejections", async () => {
    const sim = simulate({ contracts: [Counter] });
    expect(await asyncCodeOf(() => Reflect.apply(sim.spawn, sim, [Counter, "c", { n: "x" }]))).toBe("invalid_input");
    const c = await sim.spawn(Counter, "c", { n: 0 });
    expect(await asyncCodeOf(() => sim.spawn(Counter, "c", { n: 0 }))).toBe("already_spawned");
    expect(codeOf(() => sim.actor(Counter, "nope"))).toBe("not_spawned");
    expect(codeOf(() => c.view("lurker"))).toBe("no_view");
    const conn = c.connect("owner");
    conn.disconnect();
    expect(codeOf(() => conn.disconnect())).toBe("connection_closed");
    expect(codeOf(() => sim.resolve("9:9", {}))).toBe("unknown_effect");
  });

  it("simulate: a contract that is not an actor is invalid_actor_definition", async () => {
    expect(await asyncCodeOf(() => simulate().spawn({ name: "x", def: {} }, "x", {}))).toBe("invalid_actor_definition");
  });
});

describe("error codes: more sites", () => {
  it("journal error classes carry their codes", () => {
    expect(new JournalNondeterminismError("x").code).toBe("journal_nondeterminism");
    expect(new JournalDivergenceError(1, "message", "M", "a", "b").code).toBe("journal_divergence");
    expect(new JournalEmittedDivergenceError(1, "message", 0, undefined, undefined).code).toBe(
      "journal_emitted_divergence",
    );
    expect(new JournalVersionError(1, 1, 2).code).toBe("journal_version");
  });

  it("versions: a state that does not match, no path, a rebuild step, the first step stepping", () => {
    const chain = compileVersions([
      version(1, z.object({ a: z.number() })),
      version(2, z.object({ a: z.number() }), { rebuild: "replay" }),
    ]);
    expect(codeOf(() => chain.migrate({ a: "x" }, 1))).toBe("invalid_versions");
    expect(codeOf(() => chain.migrate({ a: 1 }, 7))).toBe("no_version_path");
    expect(codeOf(() => chain.migrate({ a: 1 }, 1))).toBe("no_version_path");
    expect(codeOf(() => compileVersions([version(1, z.object({}), { state: (s: Record<string, never>) => s })]))).toBe(
      "invalid_versions",
    );
  });

  it("routeMessage refuses an async handler with async_handler", () => {
    const messages = { r: { M: { schema: z.object({}), handler: async () => ({}) } } };
    expect(
      codeOf(() =>
        routeMessage(
          messages,
          "r",
          {},
          { type: "M" },
          { now: () => 0, id: () => "", random: () => 0, caller: "u", callerType: "user", env: {} },
        ),
      ),
    ).toBe("async_handler");
  });

  it("an unbound publish queue is queue_not_bound", async () => {
    expect(await asyncCodeOf(() => sendToQueue({}, "Q", { body: 1 }))).toBe("queue_not_bound");
  });

  it("simulate: rejections that do not parse are invalid_rejection", async () => {
    const Shop = defineActor("shop", {
      input: z.object({}),
      init: () => ({}),
      roles: { any: () => true },
      messages: {
        BUY: message(z.object({}), (s: object, _p, ctx) => {
          ctx.execute("charge", {});
          return s;
        }),
      },
      services: {
        charge: { fn: async () => ({}) },
        pay: {
          errors: z.discriminatedUnion("_tag", [z.object({ _tag: z.literal("Declined"), reason: z.string() })]),
          fn: async () => ({}),
        },
      },
      views: {},
    });
    const sim = simulate({ contracts: [Shop] });
    const shop = await sim.spawn(Shop, "s", {});
    shop.send("u", { type: "BUY" });
    const [effect] = sim.pendingEffects();
    if (effect === undefined) throw new Error("no effect");
    expect(codeOf(() => sim.reject(effect, { _tag: "Timeout", ms: "x" }))).toBe("invalid_rejection");
    expect(codeOf(() => sim.reject(effect, { _tag: "Declined" }))).toBe("invalid_rejection");
    expect(codeOf(() => sim.reject({ ...effect, service: "pay" }, { _tag: "Declined" }))).toBe("invalid_rejection");
  });

  it("simulate: no role for a view or a connection", async () => {
    const Closed = defineActor("closed", {
      input: z.object({}),
      init: () => ({}),
      roles: { owner: (_s: object, caller: string) => caller === "owner" },
      messages: {},
      views: { owner: { fn: () => ({}) } },
    });
    const c = await simulate({ contracts: [Closed] }).spawn(Closed, "c", {});
    expect(codeOf(() => c.view("x"))).toBe("no_role");
    expect(codeOf(() => c.connect("x"))).toBe("no_role");
  });

  it("simulate: init links that cannot be made", async () => {
    const Target = defineActor("target", {
      input: z.object({}),
      init: () => ({}),
      roles: { owner: (_s: object, caller: string) => caller === "owner", system: () => true },
      messages: {},
      views: { owner: { fn: () => ({}) }, system: { fn: () => "not an object" } },
    });
    const Closed = defineActor("target", {
      input: z.object({}),
      init: () => ({}),
      roles: { owner: (_s: object, caller: string) => caller === "owner" },
      messages: {},
      views: { owner: { fn: () => ({}) } },
    });
    const reader = (name: string) =>
      defineActor("reader", {
        input: z.object({}),
        init: async (_i: object, ctx: { link(name: string, id: string): Promise<unknown> }) => {
          await ctx.link(name, "t");
          return {};
        },
        roles: { any: () => true },
        links: { src: link(Target, { onUpdate: (s: object) => s }) },
        messages: {},
        views: {},
      });
    const sim = simulate({ contracts: [Target] });
    await sim.spawn(Target, "t", {});
    expect(await asyncCodeOf(() => sim.spawn(reader("nope"), "r1", {}))).toBe("undeclared_link");
    expect(await asyncCodeOf(() => sim.spawn(reader("src"), "r2", {}))).toBe("link_unavailable");
    const closed = simulate({ contracts: [Closed] });
    await closed.spawn(Closed, "t", {});
    expect(await asyncCodeOf(() => closed.spawn(reader("src"), "r3", {}))).toBe("link_unavailable");
  });

  it("sim-def and replayJournal: definitions that are not actors", async () => {
    const bad = { name: "x", def: { input: z.object({}), init: () => ({}), roles: {}, views: {}, messages: { M: 1 } } };
    expect(await asyncCodeOf(() => simulate().spawn(bad, "x", {}))).toBe("invalid_actor_definition");
    expect(await asyncCodeOf(() => replayJournal({ name: "x", def: {} }, { events: [], checkpoints: [] }))).toBe(
      "invalid_actor_definition",
    );
    const Envy = defineActor("envy", {
      input: z.object({}),
      env: z.object({ K: z.string() }),
      init: () => ({}),
      roles: { any: () => true },
      messages: {},
      views: {},
    });
    expect(await asyncCodeOf(() => simulate({ contracts: [Envy] }).spawn(Envy, "e", {}))).toBe("invalid_env");
  });
});
