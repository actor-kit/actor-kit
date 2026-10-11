/** testActor() captures ctx.schedule and ctx.cancel calls instead of running timers (ADR-015 D2). */
import { testActor } from "@actor-kit/test";
import { message, timer } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

type State = { n: number };
type TimerCtx = {
  schedule(name: string, options: { in?: string; key?: string; payload?: unknown }): void;
  cancel(key: string): void;
};

const contract = {
  name: "clock",
  def: {
    input: z.object({}),
    init: (): State => ({ n: 0 }),
    roles: { any: () => true },
    messages: {
      PLAN: message(z.object({}), (s: State, _p, ctx: TimerCtx) => {
        ctx.schedule("tick", { in: "5s", key: "t1", payload: { n: 1 } });
        ctx.cancel("old");
        ctx.schedule("tock", { in: "1m" });
        return { n: s.n + 1 };
      }),
      NOTHING: message(z.object({}), (s: State) => s),
    },
    // testActor runs the runtime's step core (ADR-018 D), which refuses undeclared timers.
    timers: {
      tick: timer(z.object({ n: z.number() }), (s: State) => s),
      tock: timer(z.undefined(), (s: State) => s),
    },
    views: { any: { fn: (s: State) => s } },
  },
};

describe("testActor: timers", () => {
  it("returns the schedules and cancels a message declared, in order", async () => {
    const result = await testActor(contract).send({ n: 0 }, "u", { type: "PLAN" });
    expect(result.schedules).toEqual([
      { timer: "tick", options: { in: "5s", key: "t1", payload: { n: 1 } } },
      { timer: "tock", options: { in: "1m" } },
    ]);
    expect(result.cancels).toEqual(["old"]);
  });

  it("returns empty lists when a message declares none", async () => {
    const result = await testActor(contract).send({ n: 0 }, "u", { type: "NOTHING" });
    expect(result.schedules).toEqual([]);
    expect(result.cancels).toEqual([]);
  });
});
