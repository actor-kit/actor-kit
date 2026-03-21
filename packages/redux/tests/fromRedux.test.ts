import { describe, expect, it } from "vitest";
import { fromRedux } from "../src/fromRedux";
import type { Caller, BaseEnv } from "@actor-kit/core";

// --- Redux-style reducer ---

type CounterState = {
  count: number;
  accessCounts: Record<string, number>;
};

type CounterAction =
  | { type: "INCREMENT" }
  | { type: "DECREMENT" }
  | { type: "RESET" };

function counterReducer(
  state: CounterState | undefined,
  action: CounterAction & { caller: Caller; env: BaseEnv }
): CounterState {
  if (!state) return { count: 0, accessCounts: {} };

  switch (action.type) {
    case "INCREMENT":
      return {
        ...state,
        count: state.count + 1,
        accessCounts: {
          ...state.accessCounts,
          [action.caller.id]: (state.accessCounts[action.caller.id] ?? 0) + 1,
        },
      };
    case "DECREMENT":
      return { ...state, count: state.count - 1 };
    case "RESET":
      if (action.caller.type !== "service") return state;
      return { ...state, count: 0 };
    default:
      return state;
  }
}

// --- Adapter ---

type CounterView = { count: number; myAccessCount: number };

const counterLogic = fromRedux(counterReducer, {
  create: (input: { initialCount?: number }) => ({
    count: input.initialCount ?? 0,
    accessCounts: {},
  }),
  getView: (state, caller): CounterView => ({
    count: state.count,
    myAccessCount: state.accessCounts[caller.id] ?? 0,
  }),
});

const clientCaller: Caller = { type: "client", id: "user-1" };
const mockEnv: BaseEnv = { ACTOR_KIT_SECRET: "test" };

// --- Tests ---

describe("fromRedux", () => {
  it("creates initial state", () => {
    const state = counterLogic.create({ initialCount: 5 });
    expect(state.count).toBe(5);
  });

  it("transitions with reducer", () => {
    let state = counterLogic.create({});
    state = counterLogic.transition(state, {
      type: "INCREMENT",
      caller: clientCaller,
      env: mockEnv,
    });
    expect(state.count).toBe(1);
  });

  it("chains transitions", () => {
    let state = counterLogic.create({});
    state = counterLogic.transition(state, { type: "INCREMENT", caller: clientCaller, env: mockEnv });
    state = counterLogic.transition(state, { type: "INCREMENT", caller: clientCaller, env: mockEnv });
    state = counterLogic.transition(state, { type: "DECREMENT", caller: clientCaller, env: mockEnv });

    expect(state.count).toBe(1);
  });

  it("caller-scoped views", () => {
    const user2: Caller = { type: "client", id: "user-2" };
    let state = counterLogic.create({});

    state = counterLogic.transition(state, { type: "INCREMENT", caller: clientCaller, env: mockEnv });
    state = counterLogic.transition(state, { type: "INCREMENT", caller: clientCaller, env: mockEnv });
    state = counterLogic.transition(state, { type: "INCREMENT", caller: user2, env: mockEnv });

    expect(counterLogic.getView(state, clientCaller).myAccessCount).toBe(2);
    expect(counterLogic.getView(state, user2).myAccessCount).toBe(1);
    expect(counterLogic.getView(state, clientCaller).count).toBe(3);
  });

  it("authorization via caller type", () => {
    let state = counterLogic.create({ initialCount: 10 });

    // Client can't reset
    state = counterLogic.transition(state, { type: "RESET", caller: clientCaller, env: mockEnv });
    expect(state.count).toBe(10);

    // Service can
    state = counterLogic.transition(state, {
      type: "RESET",
      caller: { type: "service", id: "admin" },
      env: mockEnv,
    });
    expect(state.count).toBe(0);
  });

  it("serialize/restore round-trip", () => {
    let state = counterLogic.create({});
    state = counterLogic.transition(state, { type: "INCREMENT", caller: clientCaller, env: mockEnv });

    const serialized = counterLogic.serialize(state);
    const restored = counterLogic.restore(serialized);
    expect(counterLogic.getView(restored, clientCaller).count).toBe(1);
  });
});
