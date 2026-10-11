/**
 * ctx.reenter (Run Set Jimmy feedback): leaving and entering the current state again on purpose. Exit
 * cancels its scoped timers and drops its local, then enter runs again with the given input; this is
 * also what goto(currentPhase) does, and reenter says so explicitly.
 */
import { simulate, testActor } from "@actor-kit/test";
import { setup } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

type S = { enters: number };
const kit = setup({
  states: { idle: {}, buying: { local: z.object({ window: z.number() }), input: z.object({ window: z.number() }) } },
});
const idle = kit.in("idle");
const buying = kit.in("buying");

const Table = kit.actor("table", {
  input: z.object({}),
  init: (): S => ({ enters: 0 }),
  roles: { any: () => true },
  initial: "idle",
  states: {
    idle: idle.state({
      messages: { OPEN: idle.message(z.object({}), (s: S, _p, ctx) => ctx.goto("buying", s, { window: 1 })) },
    }),
    buying: buying.state({
      enter: (_s: S, { window }, ctx) => {
        ctx.schedule("close", { in: "10s", scope: "state" });
        return { window };
      },
      messages: {
        REARM: buying.message(z.object({}), (s: S, _p, ctx) =>
          ctx.reenter({ enters: s.enters + 1 }, { window: ctx.local.window + 1 }),
        ),
        AGAIN: buying.message(z.object({}), (s: S, _p, ctx) => ctx.goto("buying", s, { window: 99 })),
        STAY: buying.message(z.object({}), (s: S, _p, ctx) => {
          // @ts-expect-error reenter needs the state's enter input
          if (s.enters < 0) ctx.reenter(s);
          return ctx.stay(s);
        }),
      },
      timers: { close: buying.timer(z.undefined(), (s: S, _p, ctx) => ctx.goto("idle", s)) },
    }),
  },
  views: {},
});

describe("ctx.reenter", () => {
  it("re-runs enter with the new input and re-arms the scoped timer from now", async () => {
    const sim = simulate({ contracts: [Table] });
    const t = await sim.spawn(Table, "t", {});
    t.send("u", { type: "OPEN" });
    sim.advance("6s");
    t.send("u", { type: "REARM" });
    expect(t.state).toMatchObject({ phase: "buying", local: { window: 2 }, shared: { enters: 1 } });
    expect(t.timers.map((x) => [x.name, x.fireAt])).toEqual([["close", 16_000]]);
    sim.advance("9s");
    expect(t.state.phase).toBe("buying");
    sim.advance("1s");
    expect(t.state.phase).toBe("idle");
  });

  it("goto(currentPhase) is the same re-entry", async () => {
    const t = testActor(Table);
    const opened = (await t.send(t.init({}), "u", { type: "OPEN" })).state;
    const again = await t.send(opened, "u", { type: "AGAIN" });
    expect(again.state).toMatchObject({ phase: "buying", local: { window: 99 } });
    expect(again.cancels).toEqual(["buying:close"]);
    expect(again.schedules).toEqual([{ timer: "close", options: { in: "10s", scope: "state", key: "buying:close" } }]);
  });

  it("stay keeps the local and the timers", async () => {
    const t = testActor(Table);
    const opened = (await t.send(t.init({}), "u", { type: "OPEN" })).state;
    const stayed = await t.send(opened, "u", { type: "STAY" });
    expect(stayed.state).toEqual(opened);
    expect(stayed.cancels).toEqual([]);
  });
});
