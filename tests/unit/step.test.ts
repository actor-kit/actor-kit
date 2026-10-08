/**
 * The pure step core (ADR-015 D4/Q4): one transition, from a cause and the facts it reads, to the
 * next state, the effects it declared and its journal event. The Durable Object, replay and
 * simulate() all run transitions through it.
 */
import {
  admitMessage,
  createLiveFacts,
  liveStepFacts,
  liveUnlinkTargets,
  replayStepFacts,
  type StepFacts,
  step,
  stepInit,
} from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

type S = { log: string[] };

function facts(over: Partial<StepFacts> = {}): StepFacts & { unlinkCalls: string[] } {
  const live = createLiveFacts({ now: () => 7, id: () => "id-1", random: () => 0.25 });
  const unlinkCalls: string[] = [];
  return {
    ctx: live.ctx,
    unlinkTargets: (name) => {
      unlinkCalls.push(name);
      return [`${name}-a`, `${name}-b`];
    },
    recorded: () => live.facts(),
    unlinkCalls,
    ...over,
  };
}

const ctxShape = (ctx: unknown): string[] => Object.keys(ctx ?? {}).sort();

const def = {
  roles: {
    admin: (s: S) => s.log.includes("promoted"),
    user: () => true,
  },
  messages: {
    user: {
      ADD: {
        schema: z.object({ text: z.string() }),
        handler: (s: S, p: { text: string }, ctx: { caller: string; role: string; now(): number; id(): string }) => ({
          log: [...s.log, `add:${p.text}:${ctx.caller}:${ctx.role}:${ctx.now()}:${ctx.id()}`],
        }),
      },
      EFFECTS: {
        schema: z.object({}),
        handler: (
          s: S,
          _p: unknown,
          ctx: {
            execute(n: string, i: unknown): void;
            forward(l: string, t: string, m: { type: string }): void;
            link(n: string, id: string): void;
            unlink(n: string, id?: string): void;
          },
        ) => {
          ctx.execute("EMAIL", { to: "a" });
          ctx.link("room", "r9");
          ctx.forward("room", "r1", { type: "PING" });
          ctx.unlink("room", "r1");
          ctx.execute("SMS", { to: "b" });
          return { log: [...s.log, "effects"] };
        },
      },
      UNLINK_ALL: {
        schema: z.object({}),
        handler: (s: S, _p: unknown, ctx: { unlink(n: string, id?: string): void }) => {
          ctx.unlink("room");
          ctx.unlink("silent");
          ctx.unlink("undeclared");
          return { log: [...s.log, "unlink-all"] };
        },
      },
      ASYNC: {
        schema: z.object({}),
        handler: async (s: S) => s,
      },
      CTX: {
        schema: z.object({}),
        handler: (s: S, _p: unknown, ctx: unknown) => ({ log: [...s.log, ctxShape(ctx).join(",")] }),
      },
    },
  },
  lifecycle: {
    connect: (
      s: S,
      e: { caller: string; callerConnections?: number },
      ctx: { execute(n: string, i: unknown): void },
    ) => {
      ctx.execute("WELCOME", { to: e.caller });
      return { log: [...s.log, `connect:${e.caller}:${e.callerConnections}`] };
    },
    disconnect: (s: S, e: { caller: string }, ctx: unknown) => ({
      log: [...s.log, `disconnect:${e.caller}:${ctxShape(ctx).join(",")}`, "promoted"],
    }),
  },
  services: {
    FETCH: {
      onDone: (s: S, result: unknown, input: unknown, ctx: { now(): number }) => ({
        log: [...s.log, `done:${JSON.stringify(result)}:${JSON.stringify(input)}:${ctx.now()}`],
      }),
      onError: (s: S, error: { message: string }, input: unknown) => ({
        log: [...s.log, `error:${error.message}:${JSON.stringify(input)}`],
      }),
    },
    QUIET: {},
  },
  links: {
    room: {
      onUpdate: (s: S, view: unknown, id: string | undefined, ctx: { now(): number }) => ({
        log: [...s.log, `update:${id}:${JSON.stringify(view)}:${ctx.now()}`],
      }),
      onError: (s: S, error: { message: string; code: string }, id: string | undefined) => ({
        log: [...s.log, `linkError:${id}:${error.code}`],
      }),
      onUnlink: (s: S, id: string | undefined) => ({ log: [...s.log, `unlink:${id}`] }),
    },
    silent: { onUpdate: (s: S) => s },
  },
  migrate: (persisted: unknown, from: number) => ({ migrated: from, persisted }),
  restore: (raw: unknown) => ({ log: [`restored:${JSON.stringify(raw)}`] }),
};

const msg = (name: string, payload: unknown = {}) =>
  ({ type: "message", name, payload, caller: "alice", callerType: "user", role: "user" }) as const;

describe("step: message", () => {
  it("runs the handler with the deterministic ctx and journals the event", () => {
    const result = step(def, { log: [] }, msg("ADD", { text: "hi" }), facts(), {});
    expect(result.state).toEqual({ log: ["add:hi:alice:user:7:id-1"] });
    expect(result.event).toEqual({
      causeType: "message",
      name: "ADD",
      payload: { text: "hi" },
      caller: "alice",
      callerType: "user",
      role: "user",
      facts: { now: 7, ids: ["id-1"] },
    });
  });

  it("gives the handler caller, callerType, role, env, the effect verbs and now/id/random", () => {
    expect(step(def, { log: [] }, msg("CTX"), facts(), {}).state).toEqual({
      log: ["caller,callerType,cancel,env,execute,forward,id,link,now,random,role,schedule,unlink"],
    });
  });

  it("collects effects with one index across executions and forwards, links and unlinks apart", () => {
    const { effects } = step(def, { log: [] }, msg("EFFECTS"), facts(), {});
    expect(effects.toExecutionEntries(4).map((e) => [e.id, e.service])).toEqual([
      ["4:0", "EMAIL"],
      ["4:2", "SMS"],
    ]);
    expect(effects.toForwardEntries(4).map((e) => [e.id, e.targetId])).toEqual([["4:1", "r1"]]);
    expect(effects.getLinks()).toEqual([{ name: "room", id: "r9" }]);
    expect(effects.getUnlinks()).toEqual([{ name: "room", id: "r1" }]);
  });

  it("runs onUnlink for an unlink by id without asking for targets", () => {
    const f = facts();
    const { state, handlerState } = step(def, { log: [] }, msg("EFFECTS"), f, {});
    expect(state).toEqual({ log: ["effects", "unlink:r1"] });
    expect(handlerState).toEqual({ log: ["effects"] });
    expect(f.unlinkCalls).toEqual([]);
  });

  it("asks for the targets of unlink(name) only when the link has onUnlink, and runs it per target", () => {
    const f = facts();
    const { state } = step(def, { log: [] }, msg("UNLINK_ALL"), f, {});
    expect(state).toEqual({ log: ["unlink-all", "unlink:room-a", "unlink:room-b"] });
    expect(f.unlinkCalls).toEqual(["room"]);
  });

  it("throws when the message is not defined for the role", () => {
    expect(() => step(def, { log: [] }, { ...msg("GONE"), role: "user" }, facts(), {})).toThrow(/GONE/);
    expect(() => step(def, { log: [] }, { ...msg("ADD"), role: "nobody" }, facts(), {})).toThrow(/nobody/);
  });

  it("rejects a handler that returns a Promise", () => {
    expect(() => step(def, { log: [] }, msg("ASYNC"), facts(), {})).toThrow(/returned a Promise/);
  });
});

describe("step: lifecycle", () => {
  it("connect passes callerConnections, collects effects and keeps the caller's role", () => {
    const result = step(
      def,
      { log: [] },
      { type: "lifecycle.connect", caller: "bob", callerType: "user", callerConnections: 2, role: "user" },
      facts(),
      {},
    );
    expect(result.state).toEqual({ log: ["connect:bob:2"] });
    expect(result.effects.getExecutions()).toEqual([{ service: "WELCOME", input: { to: "bob" } }]);
    expect(result.event).toMatchObject({
      causeType: "lifecycle.connect",
      name: null,
      payload: {},
      caller: "bob",
      callerType: "user",
      role: "user",
    });
  });

  it("disconnect gets execute/forward but no link verbs, and is journaled under the role after it", () => {
    const result = step(
      def,
      { log: [] },
      { type: "lifecycle.disconnect", caller: "bob", callerType: "service", callerConnections: 0, role: null },
      facts(),
      {},
    );
    expect(result.state).toEqual({
      log: ["disconnect:bob:caller,callerType,cancel,env,execute,forward,id,now,random,schedule", "promoted"],
    });
    expect(result.event).toMatchObject({ causeType: "lifecycle.disconnect", role: "admin", callerType: "service" });
  });

  it("a missing lifecycle handler leaves the state alone", () => {
    const state = { log: [] };
    const result = step(
      {},
      state,
      { type: "lifecycle.connect", caller: "b", callerType: "user", role: "u" },
      facts(),
      {},
    );
    expect(result.state).toBe(state);
  });

  it("omits callerConnections from the handler's event when the cause has none (replay)", () => {
    const seen: unknown[] = [];
    step(
      {
        lifecycle: {
          connect: (s: S, e: unknown) => {
            seen.push(e);
            return s;
          },
        },
      },
      { log: [] },
      { type: "lifecycle.connect", caller: "b", callerType: "user", role: "u" },
      facts(),
      {},
    );
    expect(seen).toStrictEqual([{ caller: "b", callerType: "user" }]);
  });
});

describe("step: services and links", () => {
  it("onDone gets result, input and the deterministic ctx", () => {
    const result = step(
      def,
      { log: [] },
      { type: "service.onDone", service: "FETCH", input: { q: 1 }, result: [2] },
      facts(),
      {},
    );
    expect(result.state).toEqual({ log: ['done:[2]:{"q":1}:7'] });
    expect(result.event).toEqual({
      causeType: "service.onDone",
      name: "FETCH",
      payload: { input: { q: 1 }, result: [2] },
      caller: null,
      callerType: null,
      role: null,
      facts: { now: 7 },
    });
  });

  it("onError gets the error and input", () => {
    const result = step(
      def,
      { log: [] },
      { type: "service.onError", service: "FETCH", input: 1, error: { message: "boom" } },
      facts(),
      {},
    );
    expect(result.state).toEqual({ log: ["error:boom:1"] });
    expect(result.event).toMatchObject({
      causeType: "service.onError",
      name: "FETCH",
      payload: { input: 1, error: { message: "boom" } },
    });
  });

  it("a service without onDone/onError leaves the state alone", () => {
    const state = { log: [] };
    expect(step(def, state, { type: "service.onDone", service: "QUIET", input: 1, result: 2 }, facts(), {}).state).toBe(
      state,
    );
    expect(
      step(def, state, { type: "service.onError", service: "QUIET", input: 1, error: { message: "x" } }, facts(), {})
        .state,
    ).toBe(state);
    expect(
      step(def, state, { type: "service.onDone", service: "MISSING", input: 1, result: 2 }, facts(), {}).state,
    ).toBe(state);
  });

  it("link.onUpdate and link.onError", () => {
    const a = step(
      def,
      { log: [] },
      { type: "link.onUpdate", link: "room", sourceId: "r1", view: { role: "x" } },
      facts(),
      {},
    );
    expect(a.state).toEqual({ log: ['update:r1:{"role":"x"}:7'] });
    expect(a.event).toMatchObject({
      causeType: "link.onUpdate",
      name: "room",
      payload: { sourceId: "r1", view: { role: "x" } },
    });
    const b = step(
      def,
      a.state,
      { type: "link.onError", link: "room", targetId: "r2", error: { message: "m", code: "unreachable" } },
      facts(),
      {},
    );
    expect(b.state).toEqual({ log: ['update:r1:{"role":"x"}:7', "linkError:r2:unreachable"] });
    expect(b.event).toMatchObject({
      causeType: "link.onError",
      name: "room",
      payload: { targetId: "r2", error: { message: "m", code: "unreachable" } },
    });
  });

  it("a link without onError, or an undeclared link, leaves the state alone", () => {
    const state = { log: [] };
    expect(
      step(
        def,
        state,
        { type: "link.onError", link: "silent", targetId: "t", error: { message: "m", code: "c" } },
        facts(),
        {},
      ).state,
    ).toBe(state);
    expect(step(def, state, { type: "link.onUpdate", link: "nope", sourceId: "s", view: {} }, facts(), {}).state).toBe(
      state,
    );
  });
});

describe("step: migrate", () => {
  it("restore(migrate(persisted, fromVersion)) and journals both versions", () => {
    const result = step(
      def,
      { log: [] },
      { type: "migrate", fromVersion: 1, toVersion: 3, persisted: { old: true } },
      facts(),
      {},
    );
    expect(result.state).toEqual({ log: ['restored:{"migrated":1,"persisted":{"old":true}}'] });
    expect(result.event).toMatchObject({ causeType: "migrate", payload: { fromVersion: 1, toVersion: 3 } });
  });

  it("without migrate/restore the persisted state passes through", () => {
    expect(
      step({}, undefined, { type: "migrate", fromVersion: 1, toVersion: 2, persisted: { a: 1 } }, facts(), {}).state,
    ).toEqual({ a: 1 });
  });
});

describe("stepInit", () => {
  it("awaits init with input, env, link and the deterministic ctx", async () => {
    const result = await stepInit(
      {
        init: async (
          input: unknown,
          ctx: { now(): number; link(n: string, id: string): Promise<unknown>; env: unknown },
        ) => ({ input, at: ctx.now(), view: await ctx.link("room", "r1"), env: ctx.env }),
      },
      { input: { a: 1 }, caller: "svc", callerType: "service" },
      facts(),
      { env: { E: 1 }, link: async (name, id) => ({ name, id }) },
    );
    expect(result.state).toEqual({ input: { a: 1 }, at: 7, view: { name: "room", id: "r1" }, env: { E: 1 } });
    expect(result.event).toEqual({
      causeType: "init",
      name: null,
      payload: { a: 1 },
      caller: "svc",
      callerType: "service",
      role: null,
      facts: { now: 7 },
    });
  });

  it("throws when the def has no init", async () => {
    await expect(
      stepInit({}, { input: {}, caller: null, callerType: null }, facts(), { env: {}, link: async () => null }),
    ).rejects.toThrow("This actor has no init");
  });
});

describe("admitMessage", () => {
  const roleMessages = {
    user: {
      ADD: {
        schema: z.object({ text: z.string().min(1) }),
        guard: (_s: S, p: { text: string }, ctx: { role: string; caller: string }) =>
          p.text !== "no" && ctx.caller !== "mallory",
        handler: (s: S) => s,
      },
    },
  };
  const guardCtx = { caller: "alice", callerType: "user" as const, env: {} };

  it("admits a valid message with its parsed payload (type stripped)", () => {
    expect(admitMessage(roleMessages, "user", { log: [] }, { type: "ADD", text: "hi" }, guardCtx)).toEqual({
      ok: true,
      payload: { text: "hi" },
      message: roleMessages.user.ADD,
    });
  });

  it("refuses an unknown message or role", () => {
    expect(admitMessage(roleMessages, "user", { log: [] }, { type: "NOPE" }, guardCtx)).toEqual({
      ok: false,
      error: "message_not_found",
    });
    expect(admitMessage(roleMessages, "admin", { log: [] }, { type: "ADD", text: "x" }, guardCtx)).toEqual({
      ok: false,
      error: "message_not_found",
    });
  });

  it("refuses an invalid payload with the Zod detail", () => {
    const result = admitMessage(roleMessages, "user", { log: [] }, { type: "ADD", text: "" }, guardCtx);
    expect(result).toMatchObject({ ok: false, error: "validation_failed", detail: expect.stringContaining("text") });
  });

  it("refuses when the guard says no, with role and caller in the guard ctx", () => {
    expect(admitMessage(roleMessages, "user", { log: [] }, { type: "ADD", text: "no" }, guardCtx)).toEqual({
      ok: false,
      error: "guard_failed",
    });
    expect(
      admitMessage(roleMessages, "user", { log: [] }, { type: "ADD", text: "hi" }, { ...guardCtx, caller: "mallory" }),
    ).toEqual({
      ok: false,
      error: "guard_failed",
    });
  });
});

describe("liveUnlinkTargets", () => {
  const read = (name: string) => (name === "room" ? ["r1", "r2"] : []);

  it("are the stored targets plus this transition's links, in order, without duplicates", () => {
    expect(liveUnlinkTargets(read, "room", { linked: ["r3", "r1"], earlier: [] })).toEqual(["r1", "r2", "r3"]);
  });

  it("leave out targets an earlier unlink by id removed", () => {
    expect(
      liveUnlinkTargets(read, "room", {
        linked: ["r3"],
        earlier: [
          { name: "room", id: "r2" },
          { name: "other", id: "r1" },
        ],
      }),
    ).toEqual(["r1", "r3"]);
  });

  it("are empty after an earlier unlink(name) in the same transition", () => {
    expect(liveUnlinkTargets(read, "room", { linked: ["r3"], earlier: [{ name: "room", id: undefined }] })).toEqual([]);
    expect(liveUnlinkTargets(read, "room", { linked: [], earlier: [{ name: "other", id: undefined }] })).toEqual([
      "r1",
      "r2",
    ]);
  });
});

describe("step: edges", () => {
  it("tells unlinkTargets what this transition linked under the name and which unlinks ran before", () => {
    const calls: unknown[] = [];
    const spy: StepFacts = {
      ...facts(),
      unlinkTargets: (name, pending) => {
        calls.push({ name, pending });
        return [];
      },
    };
    const twice = {
      links: { room: { onUpdate: (s: S) => s, onUnlink: (s: S) => s }, team: { onUpdate: (s: S) => s } },
      messages: {
        user: {
          GO: {
            handler: (
              s: S,
              _p: unknown,
              ctx: { link(n: string, id: string): void; unlink(n: string, id?: string): void },
            ) => {
              ctx.link("room", "r1");
              ctx.link("team", "t1");
              ctx.link("room", "r2");
              ctx.unlink("team", "t1");
              ctx.unlink("room");
              return s;
            },
          },
        },
      },
    };
    step(twice, { log: [] }, msg("GO"), spy, {});
    expect(calls).toEqual([{ name: "room", pending: { linked: ["r1", "r2"], earlier: [{ name: "team", id: "t1" }] } }]);
  });

  it("an actor without links ignores unlink calls", () => {
    const state = { log: [] };
    const bare = {
      messages: {
        user: {
          GO: {
            handler: (s: S, _p: unknown, ctx: { unlink(n: string): void }) => {
              ctx.unlink("room");
              return s;
            },
          },
        },
      },
    };
    expect(step(bare, state, msg("GO"), facts(), {}).state).toBe(state);
  });

  it("an actor without messages says which message is missing", () => {
    expect(() => step({}, { log: [] }, msg("ADD"), facts(), {})).toThrow(
      'Message "ADD" is not defined for role "user"',
    );
  });

  it("says which lifecycle handler returned a Promise", () => {
    const asyncConnect = { lifecycle: { disconnect: async (s: S) => s } };
    expect(() =>
      step(
        asyncConnect,
        { log: [] },
        { type: "lifecycle.disconnect", caller: "a", callerType: "user", role: null },
        facts(),
        {},
      ),
    ).toThrow("lifecycle.disconnect returned a Promise. Handlers must be synchronous.");
  });

  it("connect is journaled under the role the caller connected with, even if the handler changes it", () => {
    const result = step(
      { ...def, lifecycle: { connect: (s: S) => ({ log: [...s.log, "promoted"] }) } },
      { log: [] },
      { type: "lifecycle.connect", caller: "a", callerType: "user", role: "user" },
      facts(),
      {},
    );
    expect(result.event.role).toBe("user");
  });

  it("disconnect resolves the role with the caller's type", () => {
    const byType = {
      roles: {
        svc: (_s: S, _c: string, claims: { callerType: string }) => claims.callerType === "service",
        user: () => true,
      },
      lifecycle: { disconnect: (s: S) => s },
    };
    const as = (callerType: "user" | "service") =>
      step(byType, { log: [] }, { type: "lifecycle.disconnect", caller: "a", callerType, role: null }, facts(), {})
        .event.role;
    expect(as("service")).toBe("svc");
    expect(as("user")).toBe("user");
  });

  it("disconnect without roles is journaled with no role", () => {
    const result = step(
      { lifecycle: { disconnect: (s: S) => s } },
      { log: [] },
      { type: "lifecycle.disconnect", caller: "a", callerType: "user", role: null },
      facts(),
      {},
    );
    expect(result.event.role).toBeNull();
  });

  it.each([
    { type: "service.onDone", service: "S", input: 1, result: 2 },
    { type: "service.onError", service: "S", input: 1, error: { message: "x" } },
    { type: "link.onUpdate", link: "L", sourceId: "s", view: {} },
    { type: "link.onError", link: "L", targetId: "t", error: { message: "m", code: "c" } },
  ] as const)("a def without services or links leaves the state alone ($type)", (cause) => {
    const state = { log: [] };
    expect(step({}, state, cause, facts(), {}).state).toBe(state);
    expect(
      step({ services: { S: {} }, links: { L: { onUpdate: (s: S) => s } } }, state, cause, facts(), {}).state,
    ).toBe(state);
  });
});

describe("live and replay step facts", () => {
  it("live: reads stored targets, merges this transition's links, records what it returned", () => {
    const live = createLiveFacts({ now: () => 5, id: () => "i", random: () => 0 });
    const f = liveStepFacts(live, (name) => (name === "room" ? ["r1"] : []));
    expect(f.unlinkTargets("room", { linked: ["r2"], earlier: [] })).toEqual(["r1", "r2"]);
    expect(f.ctx.now()).toBe(5);
    expect(f.recorded()).toEqual({ now: 5, unlinked: [{ name: "room", ids: ["r1", "r2"] }] });
  });

  it("replay: hands back recorded targets and link views, and the recorded facts", () => {
    const recorded = {
      now: 9,
      unlinked: [{ name: "room", ids: ["x"] }],
      linkViews: [{ name: "room", id: "r1", view: { v: 1 } }],
    };
    const f = replayStepFacts(recorded);
    expect(f.unlinkTargets("room", { linked: ["ignored"], earlier: [] })).toEqual(["x"]);
    expect(f.takeLinkView("room", "r1")).toEqual({ v: 1 });
    expect(f.ctx.now()).toBe(9);
    expect(f.recorded()).toBe(recorded);
  });
});

describe("step: services and links that are missing by name", () => {
  it.each([
    { type: "service.onError", service: "OTHER", input: 1, error: { message: "x" } },
    { type: "link.onError", link: "OTHER", targetId: "t", error: { message: "m", code: "c" } },
  ] as const)("leaves the state alone when $type names an undeclared one", (cause) => {
    const state = { log: [] };
    const declared = { services: { S: {} }, links: { L: { onUpdate: (s: S) => s } } };
    expect(step(declared, state, cause, facts(), {}).state).toBe(state);
  });
});

describe("step: lifecycle payload", () => {
  it("journals callerConnections when the cause has it, nothing otherwise", () => {
    const cause = { type: "lifecycle.connect", caller: "b", callerType: "user", role: "user" } as const;
    expect(step(def, { log: [] }, { ...cause, callerConnections: 3 }, facts(), {}).event.payload).toEqual({
      callerConnections: 3,
    });
    expect(step(def, { log: [] }, cause, facts(), {}).event.payload).toEqual({});
  });
});
