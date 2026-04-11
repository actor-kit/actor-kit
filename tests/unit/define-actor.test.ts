import { schema, string, uint32, view } from "@actor-kit/core";
import type { ActorContract } from "@actor-kit/worker/testing";
import { defineActor, message } from "@actor-kit/worker/testing";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

// --- Test fixtures ---

type CounterState = { count: number; lastCaller: string | null };

const CounterView = schema({ count: uint32, lastCaller: string });

const increment = message(
  z.object({ amount: z.number().int().positive() }),
  (state: CounterState, { amount }, { caller }) => ({
    count: state.count + amount,
    lastCaller: caller,
  }),
);

const decrement = message(
  z.object({ amount: z.number().int().positive() }),
  (state: CounterState, { amount }, { caller }) => ({
    count: state.count - amount,
    lastCaller: caller,
  }),
);

const Counter = defineActor("counter", {
  input: z.object({}),
  init: (): CounterState => ({ count: 0, lastCaller: null }),
  roles: {
    admin: (_state: CounterState, _caller: string, { callerType }: { callerType: "user" | "service" }) =>
      callerType === "service",
    user: () => true,
  },
  messages: {
    admin: { INCREMENT: increment, DECREMENT: decrement },
    user: { INCREMENT: increment },
  },
  views: {
    admin: view.shared(CounterView, (state: CounterState) => ({
      count: state.count,
      lastCaller: state.lastCaller ?? "",
    })),
    user: view.shared(CounterView, (state: CounterState) => ({
      count: state.count,
      lastCaller: state.lastCaller ?? "",
    })),
  },
});

// --- Type inference tests ---

describe("defineActor() typed contract", () => {
  it("preserves actor name as string literal type", () => {
    expectTypeOf(Counter.name).toEqualTypeOf<"counter">();
  });

  it("preserves state type from init() return type", () => {
    type State = ReturnType<typeof Counter.def.init>;
    expectTypeOf<State>().toEqualTypeOf<CounterState>();
  });

  it("preserves role names as string literal union", () => {
    type Roles = keyof typeof Counter.def.roles;
    expectTypeOf<Roles>().toEqualTypeOf<"admin" | "user">();
  });

  it("preserves message names per role", () => {
    type AdminMessages = keyof typeof Counter.def.messages.admin;
    type UserMessages = keyof typeof Counter.def.messages.user;
    expectTypeOf<AdminMessages>().toEqualTypeOf<"INCREMENT" | "DECREMENT">();
    expectTypeOf<UserMessages>().toEqualTypeOf<"INCREMENT">();
  });

  it("preserves view names as string literal union", () => {
    type ViewNames = keyof typeof Counter.def.views;
    expectTypeOf<ViewNames>().toEqualTypeOf<"admin" | "user">();
  });

  it("is assignable to ActorContract", () => {
    expectTypeOf(Counter).toMatchTypeOf<ActorContract>();
  });

  // --- Runtime tests ---

  it("contract.name equals the provided name", () => {
    expect(Counter.name).toBe("counter");
  });

  it("contract.def contains the definition with all fields", () => {
    expect(Counter.def.init).toBeTypeOf("function");
    expect(Counter.def.roles).toBeDefined();
    expect(Counter.def.messages).toBeDefined();
    expect(Counter.def.views).toBeDefined();
  });

  it("contract.def.init produces the initial state", () => {
    const state = Counter.def.init({});
    expect(state).toEqual({ count: 0, lastCaller: null });
  });
});
