/**
 * Message roles (Run Set Jimmy feedback): a message (top-level or in a state) may name the roles that
 * may send it. Any other role is refused with `wrong_role` before the payload is parsed or the guard
 * runs; a role the actor does not declare is a definition error.
 */
import { ActorKitError, docsUrl } from "@actor-kit/core";
import { simulate, testActor } from "@actor-kit/test";
import { checkMessageRoles, message, refuseAdmission, setup } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

type S = { draws: number; names: string[] };
const kit = setup({ states: { lobby: {}, playing: {} } });
const lobby = kit.in("lobby");
const playing = kit.in("playing");

const isHost = (_s: unknown, caller: string) => caller === "host";
const isSeated = (_s: unknown, caller: string) => caller.startsWith("p");

const Table = kit.actor("table", {
  input: z.object({}),
  init: (): S => ({ draws: 0, names: [] }),
  roles: { host: isHost, player: isSeated, guest: () => true },
  initial: "lobby",
  messages: {
    NAME: kit.message(z.object({ name: z.string() }), {
      roles: ["host", "player"],
      handler: (s: S, { name }) => ({ ...s, names: [...s.names, name] }),
    }),
    PING: kit.message(z.object({}), (s: S) => s),
  },
  states: {
    lobby: lobby.state({
      messages: {
        START: lobby.message(z.object({}), { roles: ["host"], handler: (s: S, _p, ctx) => ctx.goto("playing", s) }),
      },
    }),
    playing: playing.state({
      messages: {
        DRAW: playing.message(z.object({}), {
          roles: ["player"],
          guard: () => true,
          handler: (s: S) => ({ ...s, draws: s.draws + 1 }),
        }),
      },
    }),
  },
  views: {
    host: { fn: (s: { shared: S }) => s.shared },
    player: { fn: (s: { shared: S }) => s.shared },
    guest: { fn: () => ({}) },
  },
});

describe("roles on messages", () => {
  it("a state message refuses roles it does not name, with wrong_role naming the roles it takes", async () => {
    const t = await simulate({ contracts: [Table] }).spawn(Table, "t", {});
    expect(t.send("guest-1", { type: "START" })).toEqual({
      ok: false,
      code: "wrong_role",
      message: 'START is accepted from role host; the caller "guest-1" has role guest.',
      expected: ["host"],
      details: { role: "guest" },
      docs: docsUrl("wrong_role"),
    });
    expect(t.send("host", { type: "START" })).toEqual({ ok: true });
    expect(t.send("host", { type: "DRAW" })).toMatchObject({ code: "wrong_role", expected: ["player"] });
    expect(t.send("guest-1", { type: "DRAW" })).toMatchObject({ code: "wrong_role" });
    expect(t.send("p1", { type: "DRAW" })).toEqual({ ok: true });
    expect(t.state.shared.draws).toBe(1);
  });

  it("a top-level message with roles refuses the others; one without roles takes every role", async () => {
    const t = await simulate({ contracts: [Table] }).spawn(Table, "t", {});
    expect(t.send("guest-1", { type: "NAME", name: "x" })).toMatchObject({
      code: "wrong_role",
      message: 'NAME is accepted from role host or player; the caller "guest-1" has role guest.',
    });
    expect(t.send("p1", { type: "NAME", name: "ann" })).toEqual({ ok: true });
    expect(t.send("guest-1", { type: "PING" })).toEqual({ ok: true });
  });

  it("wrong_role comes before the payload and the guard", async () => {
    const t = await simulate({ contracts: [Table] }).spawn(Table, "t", {});
    // @ts-expect-error name must be a string: the role is refused before the payload is read
    expect(t.send("guest-1", { type: "NAME", name: 5 })).toMatchObject({ code: "wrong_role" });
  });

  it("testActor refuses the same way", async () => {
    const t = testActor(Table);
    const error = await t.send(t.init({}), "guest-1", { type: "START" }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "wrong_role" });
  });

  it("standalone message() takes roles too", () => {
    const m = message(z.object({}), { roles: ["host"], handler: (s: S) => s });
    expect(m.roles).toEqual(["host"]);
  });

  it("a role the actor does not declare is a definition error", async () => {
    const Bad = kit.actor("bad", {
      input: z.object({}),
      init: (): S => ({ draws: 0, names: [] }),
      roles: { host: isHost },
      initial: "lobby",
      states: {
        lobby: lobby.state({
          messages: { START: lobby.message(z.object({}), { roles: ["hots"], handler: (s: S) => s }) },
        }),
        playing: playing.state({}),
      },
      views: {},
    });
    let error: unknown;
    try {
      await simulate({ contracts: [Bad] }).spawn(Bad, "b", {});
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ActorKitError);
    expect(error).toMatchObject({
      code: "invalid_actor_definition",
      message:
        'Message "START" (state "lobby") names role "hots", which this actor does not declare. Its roles are: host.',
    });
  });
});

describe("roles on messages: edges", () => {
  const slot = (roles?: string[]) => ({
    schema: z.object({}),
    handler: (s: S) => s,
    ...(roles === undefined ? {} : { roles }),
  });

  it("checks top-level, role-nested and state messages; ignores what is not a message", () => {
    const roles = { host: () => true, player: () => true };
    const fails = (def: Parameters<typeof checkMessageRoles>[0]) => {
      try {
        checkMessageRoles(def);
        return "ok";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    expect(fails({ roles, messages: { A: slot(["guest"]) } })).toBe(
      'Message "A" names role "guest", which this actor does not declare. Its roles are: host, player.',
    );
    expect(fails({ roles, messages: { player: { B: slot(["tv"]) } } })).toMatch(/^Message "B" names role "tv"/);
    expect(fails({ roles, messages: { player: { B: slot(["host"]), junk: 1 }, odd: null }, states: { s: {} } })).toBe(
      "ok",
    );
    expect(fails({ roles, messages: undefined, states: { s: { messages: { C: slot(["x"]) } } } })).toMatch(
      /^Message "C" \(state "s"\) names role "x"/,
    );
    expect(fails({ messages: { D: slot() } })).toBe("ok");
  });

  it("the refusal without a known caller still reads as a sentence", () => {
    expect(refuseAdmission({}, null, "guest", "M", { ok: false, error: "wrong_role", roles: ["host"] }).message).toBe(
      "M is accepted from role host; the caller has role guest.",
    );
  });

  it("message() keeps only the options given", () => {
    const handler = (s: S) => s;
    const schema = z.object({});
    expect(message(schema, { handler })).toStrictEqual({ schema, handler });
    const guard = () => true;
    expect(message(schema, { handler, guard, roles: ["host"] })).toStrictEqual({
      schema,
      handler,
      guard,
      roles: ["host"],
    });
  });

  it("an actor whose messages are all in states refuses an unknown message as unknown_message", async () => {
    const Only = kit.actor("only", {
      input: z.object({}),
      init: (): S => ({ draws: 0, names: [] }),
      roles: { any: () => true },
      initial: "lobby",
      states: { lobby: lobby.state({}), playing: playing.state({}) },
      views: {},
    });
    const o = await simulate({ contracts: [Only] }).spawn(Only, "o", {});
    expect(Reflect.apply(o.send, o, ["u", { type: "NOPE" }])).toMatchObject({ code: "unknown_message" });
  });
});
