import { testActor } from "@actor-kit/test";
import { message } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

type State = { n: number };

const inc = message(z.object({}), (s: State) => ({ n: s.n + 1 }));
const set = message(z.object({ n: z.number() }), (_s: State, { n }) => ({ n }));
const input = z.object({ n: z.number() });
const init = ({ n }: { n: number }): State => ({ n });
const anyone = () => true;
const views = { player: { fn: (s: State) => s }, admin: { fn: (s: State) => s } };

/** A contract as defineActor() returns it: a name plus the definition. */
function contract(messages: Record<string, unknown>, roles: Record<string, () => boolean> = { player: anyone }) {
  return { name: "c", def: { input, init, roles, messages, views } };
}

describe("testActor(contract): message layouts", () => {
  it("applies flat messages to every role", async () => {
    const t = testActor(contract({ INC: inc }, { admin: () => false, player: anyone }));
    expect((await t.send({ n: 1 }, "u", { type: "INC" })).state).toEqual({ n: 2 });
  });

  it("uses role-nested messages as they are", async () => {
    const t = testActor(contract({ player: { INC: inc } }));
    expect((await t.send({ n: 1 }, "u", { type: "INC" })).state).toEqual({ n: 2 });
  });

  it("is role-nested when only some entries are messages", async () => {
    const t = testActor(contract({ player: { INC: inc }, SET: set }));
    expect((await t.send({ n: 1 }, "u", { type: "INC" })).state).toEqual({ n: 2 });
  });

  it.each([
    ["handler", "a role record with a message named handler"],
    ["schema", "a role record with a message named schema"],
  ])("does not mistake %s for a message definition (%s)", async (name) => {
    const t = testActor(contract({ player: { [name]: inc } }));
    expect((await t.send({ n: 1 }, "u", { type: name })).state).toEqual({ n: 2 });
  });

  it.each([
    ["null", null],
    ["a string", "x"],
    ["a number", 1],
  ])("skips a role entry that is %s", async (_label, junk) => {
    const t = testActor(contract({ ghost: junk, player: { INC: inc } }));
    expect((await t.send({ n: 1 }, "u", { type: "INC" })).state).toEqual({ n: 2 });
  });

  it("finds no message when the contract has none", async () => {
    const t = testActor(contract({}));
    await expect(t.send({ n: 1 }, "u", { type: "INC" })).rejects.toThrow('Message "INC" not found for role "player"');
  });

  it("treats a raw def that happens to have a name as a raw def", async () => {
    const raw = { name: "raw", input, init, roles: { player: anyone }, messages: { player: { INC: inc } }, views };
    const t = testActor(raw);
    expect((await t.send({ n: 1 }, "u", { type: "INC" })).state).toEqual({ n: 2 });
  });
});

describe("testActor: routing errors", () => {
  it("reports a validation failure with Zod's detail", async () => {
    const t = testActor(contract({ SET: set }));
    const error = await t.send({ n: 1 }, "u", { type: "SET", n: "x" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/^Error: Validation failed for "SET": .*expected number/s);
  });

  it("reports a guard rejection", async () => {
    const guarded = message(z.object({}), { guard: () => false, handler: (s: State) => s });
    const t = testActor(contract({ G: guarded }));
    await expect(t.send({ n: 1 }, "u", { type: "G" })).rejects.toThrow('Guard rejected "G"');
  });

  it("reports an unmatched caller", async () => {
    const t = testActor(contract({ INC: inc }, { player: () => false }));
    await expect(t.send({ n: 1 }, "nobody", { type: "INC" })).rejects.toThrow('No role matched for caller "nobody"');
  });
});

describe("testActor: caller type", () => {
  const roles = {
    admin: (_s: State, _c: string, claims: { callerType: "user" | "service" }) => claims.callerType === "service",
    player: (_s: State, _c: string, claims: { callerType: "user" | "service" }) => claims.callerType === "user",
  };
  const def = { name: "c", def: { input, init, roles, messages: { INC: inc }, views } };

  it("role() defaults to a user and honours a service caller", () => {
    const t = testActor(def);
    expect(t.role({ n: 0 }, "u")).toBe("player");
    expect(t.role({ n: 0 }, "u", { callerType: "service" })).toBe("admin");
  });

  it("send() resolves the role from the caller type", async () => {
    const t = testActor(def);
    const asUser = await t.send({ n: 0 }, "u", { type: "INC" });
    const asService = await t.send({ n: 0 }, "s", { type: "INC" }, { callerType: "service" });
    expect(asUser.timeline[0]?.cause).toMatchObject({ role: "player", callerType: "user" });
    expect(asService.timeline[0]?.cause).toMatchObject({ role: "admin", callerType: "service" });
  });

  it("view() resolves the role from the caller type", () => {
    const t = testActor(def);
    expect(t.view({ n: 3 }, "u").role).toBe("player");
    expect(t.view({ n: 3 }, "s", { callerType: "service" })).toEqual({ role: "admin", data: { n: 3 } });
  });

  it("view() throws for a role without a view", () => {
    const t = testActor({ name: "c", def: { input, init, roles: { lurker: anyone }, messages: { INC: inc }, views } });
    expect(() => t.view({ n: 0 }, "u")).toThrow('No view defined for role "lurker"');
  });
});

describe("testActor: init context", () => {
  it("gives init deterministic helpers, an empty env and a link() that refuses", async () => {
    let seen: { env: unknown; now: unknown; link: Promise<unknown> } | undefined;
    const t = testActor({
      name: "c",
      def: {
        input,
        init: (
          i: { n: number },
          ctx: { env: unknown; now: () => number; link: (a: string, b: string) => Promise<unknown> },
        ) => {
          seen = { env: ctx.env, now: ctx.now(), link: ctx.link("peer", "id") };
          return { n: i.n };
        },
        roles: { player: anyone },
        messages: { INC: inc },
        views,
      },
    });
    expect(t.init({ n: 4 })).toEqual({ n: 4 });
    expect(seen?.env).toEqual({});
    expect(typeof seen?.now).toBe("number");
    await expect(seen?.link).rejects.toThrow("link() not available in test harness init — use send() for link testing");
  });
});

describe("testActor: observe", () => {
  it("calls observe.onTransition with both states, the message and the caller's role", async () => {
    const calls: unknown[] = [];
    const t = testActor({
      name: "c",
      def: {
        input,
        init,
        roles: { player: anyone },
        messages: { INC: inc },
        views,
        observe: {
          onTransition: (
            prev: unknown,
            next: unknown,
            event: { type: string },
            ctx: { caller: string; role: string },
          ) => {
            calls.push([prev, next, event, ctx]);
          },
        },
      },
    });
    await t.send({ n: 1 }, "u", { type: "INC" });
    expect(calls).toEqual([[{ n: 1 }, { n: 2 }, { type: "INC" }, { caller: "u", role: "player" }]]);
  });

  it("works without observe hooks", async () => {
    const t = testActor({
      name: "c",
      def: { input, init, roles: { player: anyone }, messages: { INC: inc }, views, observe: {} },
    });
    expect((await t.send({ n: 1 }, "u", { type: "INC" })).state).toEqual({ n: 2 });
  });
});

describe("testActor: effects", () => {
  it("captures each effect kind separately, in order", async () => {
    const effects = message(z.object({}), (s: State, _p, ctx) => {
      ctx.execute("mail", { to: "a" });
      ctx.link("room", "r1");
      ctx.unlink("room", "r0");
      ctx.unlink("all");
      ctx.forward("room", "r1", { type: "PING" });
      return s;
    });
    const t = testActor(contract({ FX: effects }));
    const result = await t.send({ n: 0 }, "u", { type: "FX" });
    expect(result.executions).toEqual([{ service: "mail", input: { to: "a" } }]);
    expect(result.links).toEqual([{ name: "room", id: "r1" }]);
    expect(result.unlinks).toEqual([
      { name: "room", id: "r0" },
      { name: "all", id: undefined },
    ]);
    expect(result.forwards).toEqual([{ linkName: "room", targetId: "r1", message: { type: "PING" } }]);
  });
});
