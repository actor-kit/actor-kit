/**
 * Edges of the outbound stream and of effect traces (ADR-017 §3, §4).
 */
import { simulate } from "@actor-kit/test";
import { defineActor, link, message, PUBLISH_SERVICE, sendToQueue } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

describe("sendToQueue", () => {
  it("sends the body once, on the binding", async () => {
    const sent: Array<{ self: unknown; args: unknown[] }> = [];
    const binding = {
      send(this: unknown, ...args: unknown[]) {
        sent.push({ self: this, args });
        return Promise.resolve();
      },
    };
    expect(await sendToQueue({ Q: binding }, "Q", { a: 1 })).toBeNull();
    expect(sent).toEqual([{ self: binding, args: [{ a: 1 }] }]);
  });

  it.each([
    ["no env", undefined],
    ["a null env", null],
    ["a non-object env", "env"],
    ["no binding", {}],
    ["a null binding", { Q: null }],
    ["a binding that is not an object", { Q: "queue" }],
    ["a binding without send", { Q: {} }],
    ["a send that is not a function", { Q: { send: 1 } }],
  ])("refuses %s", async (_name, env) => {
    const error = await sendToQueue(env, "Q", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('Queue binding "Q" is not bound');
  });

  it("the reserved service name", () => {
    expect(PUBLISH_SERVICE).toBe("__publish");
  });
});

type Room = { n: number };
const Room = defineActor("room", {
  input: z.object({}),
  init: (): Room => ({ n: 0 }),
  roles: { any: () => true },
  messages: {
    PING: message(z.object({}), (s: Room, _p, ctx) => {
      ctx.execute("LOG", {});
      return { n: s.n + 1 };
    }),
  },
  services: { LOG: { fn: async () => null, onDone: (s: Room) => ({ n: s.n + 10 }) } },
  views: {},
});
const Desk = defineActor("desk", {
  input: z.object({}),
  init: () => ({}),
  roles: { any: () => true },
  messages: {
    POKE: message(z.object({}), (s: Record<string, never>, _p, ctx) => {
      ctx.forward("room", "r1", { type: "PING" });
      return s;
    }),
  },
  links: { room: link(Room, { onUpdate: (s: Record<string, never>) => s }) },
  views: {},
});

describe("effect traces follow the declaring event's flow", () => {
  it("a service declared by a forwarded message continues the forwarder's flow", async () => {
    const sim = simulate({ contracts: [Room, Desk] });
    const room = await sim.spawn(Room, "r1", {});
    room.send("u", { type: "PING" }); // room seq 2: its own flow, effect 2:0
    const desk = await sim.spawn(Desk, "d1", {});
    desk.send("u", { type: "POKE" }); // room seq 3, flow desk/d1/2, effect 3:0
    sim.resolve({ actor: { type: "room", id: "r1" }, effectId: "3:0", service: "LOG", input: {} }, null);
    sim.resolve({ actor: { type: "room", id: "r1" }, effectId: "2:0", service: "LOG", input: {} }, null);
    const results = room.journal.events.filter((e) => e.causeType === "service.onDone");
    expect(results.map((e) => [e.correlationId, e.causationId])).toEqual([
      ["desk/d1/2", "room/r1/3:0"],
      ["room/r1/2", "room/r1/2:0"],
    ]);
  });
});
