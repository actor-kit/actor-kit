import { schema, uint32, view } from "@actor-kit/core";
import { testActor } from "@actor-kit/test";
import { message } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

type State = { count: number; maxCount: number };
const CountView = schema({ count: uint32 });

const increment = message(z.object({}), {
  guard: (state: State) => state.count < state.maxCount,
  handler: (state: State) => ({ ...state, count: state.count + 1 }),
});

const reset = message(z.object({}), (state: State) => ({ ...state, count: 0 }));

describe("testActor with guards", () => {
  const def = {
    input: z.object({ maxCount: z.number() }),
    init: (input: { maxCount: number }): State => ({ count: 0, maxCount: input.maxCount }),
    roles: { user: () => true },
    messages: { user: { INCREMENT: increment, RESET: reset } },
    views: {
      user: view.shared(CountView, (state: State) => ({ count: state.count })),
    },
  };

  it("allows message when guard passes", async () => {
    const t = testActor(def);
    let state = t.init({ maxCount: 3 });
    ({ state } = await t.send(state, "alice", { type: "INCREMENT" }));
    expect(state.count).toBe(1);
  });

  it("rejects message when guard fails", async () => {
    const t = testActor(def);
    let state = t.init({ maxCount: 2 });
    ({ state } = await t.send(state, "alice", { type: "INCREMENT" }));
    ({ state } = await t.send(state, "alice", { type: "INCREMENT" }));
    expect(state.count).toBe(2);

    await expect(t.send(state, "alice", { type: "INCREMENT" })).rejects.toThrow(/guard/i);
  });

  it("guard re-evaluates on each send", async () => {
    const t = testActor(def);
    let state = t.init({ maxCount: 2 });
    ({ state } = await t.send(state, "alice", { type: "INCREMENT" }));
    ({ state } = await t.send(state, "alice", { type: "INCREMENT" }));

    // At max — guard blocks
    await expect(t.send(state, "alice", { type: "INCREMENT" })).rejects.toThrow();

    // Reset and try again
    ({ state } = await t.send(state, "alice", { type: "RESET" }));
    expect(state.count).toBe(0);

    // Guard passes again
    ({ state } = await t.send(state, "alice", { type: "INCREMENT" }));
    expect(state.count).toBe(1);
  });
});
