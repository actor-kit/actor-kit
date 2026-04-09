import { message } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

type State = { count: number; items: string[] };
type Env = { ACTOR_KIT_SECRET: string };

describe("message() helper", () => {
  it("pairs a Zod schema with a handler", () => {
    const increment = message(z.object({ amount: z.number() }), (state: State, { amount }) => ({
      ...state,
      count: state.count + amount,
    }));

    expect(increment.schema).toBeDefined();
    expect(typeof increment.handler).toBe("function");
    expect(increment.guard).toBeUndefined();
  });

  it("handler receives parsed payload and ctx", () => {
    const increment = message(z.object({ amount: z.number() }), (state: State, { amount }, ctx) => {
      expect(ctx.caller).toBe("alice");
      expect(ctx.callerType).toBe("user");
      expect(ctx.role).toBe("owner");
      expect(typeof ctx.execute).toBe("function");
      return { ...state, count: state.count + amount };
    });

    const ctx = {
      caller: "alice",
      callerType: "user" as const,
      role: "owner",
      env: { ACTOR_KIT_SECRET: "test" },
      execute: () => {},
    };

    const result = increment.handler({ count: 0, items: [] }, { amount: 5 }, ctx);
    expect(result).toEqual({ count: 5, items: [] });
  });

  it("supports guard + handler object form", () => {
    const addItem = message(z.object({ text: z.string() }), {
      guard: (state: State) => state.items.length < 10,
      handler: (state: State, { text }) => ({
        ...state,
        items: [...state.items, text],
      }),
    });

    expect(typeof addItem.guard).toBe("function");
    expect(typeof addItem.handler).toBe("function");
  });

  it("guard receives state", () => {
    const addItem = message(z.object({ text: z.string() }), {
      guard: (state: State) => state.items.length < 2,
      handler: (state: State, { text }) => ({
        ...state,
        items: [...state.items, text],
      }),
    });

    expect(addItem.guard?.({ count: 0, items: [] })).toBe(true);
    expect(addItem.guard?.({ count: 0, items: ["a", "b"] })).toBe(false);
  });

  it("schema validates payload at runtime", () => {
    const increment = message(z.object({ amount: z.number().positive() }), (state: State, { amount }) => ({
      ...state,
      count: state.count + amount,
    }));

    const validResult = increment.schema.safeParse({ amount: 5 });
    expect(validResult.success).toBe(true);

    const invalidResult = increment.schema.safeParse({ amount: -1 });
    expect(invalidResult.success).toBe(false);

    const missingResult = increment.schema.safeParse({});
    expect(missingResult.success).toBe(false);

    const wrongTypeResult = increment.schema.safeParse({ amount: "five" });
    expect(wrongTypeResult.success).toBe(false);
  });

  it("rejects async handlers at type level", () => {
    // @ts-expect-error — async handlers return Promise<State>, not State
    const fetchData = message(z.object({}), async (state: State, _, { execute }) => {
      execute("EFFECTS", { type: "FETCH", url: "https://api.example.com/data" });
      return state;
    });

    // Runtime: the object is still created (JS doesn't care), but TS rejects it
    expect(typeof fetchData.handler).toBe("function");
  });

  it("no-payload messages use z.object({})", () => {
    const reset = message(z.object({}), (_state: State) => ({ count: 0, items: [] }));

    const validResult = reset.schema.safeParse({});
    expect(validResult.success).toBe(true);
  });
});
