/**
 * Tests for the XState adapter — fromXStateMachine.
 * Verifies that XState machines work through the ActorLogic interface.
 */
import { describe, expect, it } from "vitest";
import { assign, setup } from "xstate";
import { fromXStateMachine } from "../src/fromXStateMachine";
import type { Caller, BaseEnv } from "@actor-kit/core";

// --- Test machine ---

type CounterContext = {
  public: { count: number; lastUpdatedBy: string | null };
  private: Record<string, { accessCount: number }>;
};

type CounterEvent =
  | { type: "INCREMENT"; caller: Caller; env: BaseEnv }
  | { type: "SET"; value: number; caller: Caller; env: BaseEnv }
  | { type: "RESET"; caller: Caller; env: BaseEnv };

const counterMachine = setup({
  types: {
    context: {} as CounterContext,
    events: {} as CounterEvent,
    input: {} as { initialCount?: number },
  },
  actions: {
    increment: assign({
      public: ({ context, event }) => ({
        ...context.public,
        count: context.public.count + 1,
        lastUpdatedBy: event.caller.id,
      }),
      private: ({ context, event }) => ({
        ...context.private,
        [event.caller.id]: {
          accessCount:
            (context.private[event.caller.id]?.accessCount ?? 0) + 1,
        },
      }),
    }),
    setValue: assign({
      public: ({ context, event }) => {
        if (event.type !== "SET") return context.public;
        return {
          ...context.public,
          count: event.value,
          lastUpdatedBy: event.caller.id,
        };
      },
    }),
    resetCounter: assign({
      public: ({ context }) => ({
        ...context.public,
        count: 0,
        lastUpdatedBy: null,
      }),
    }),
  },
}).createMachine({
  id: "counter",
  type: "parallel",
  context: ({ input }) => ({
    public: {
      count: input.initialCount ?? 0,
      lastUpdatedBy: null,
    },
    private: {},
  }),
  states: {
    Operations: {
      on: {
        INCREMENT: { actions: ["increment"] },
        SET: { actions: ["setValue"] },
        RESET: { actions: ["resetCounter"] },
      },
    },
  },
});

// --- View ---

type CounterView = {
  count: number;
  lastUpdatedBy: string | null;
  myAccessCount: number;
};

// --- Adapter ---

const counterLogic = fromXStateMachine(counterMachine, {
  getView: (snapshot, caller): CounterView => ({
    count: snapshot.context.public.count,
    lastUpdatedBy: snapshot.context.public.lastUpdatedBy,
    myAccessCount: snapshot.context.private[caller.id]?.accessCount ?? 0,
  }),
});

const clientCaller: Caller = { type: "client", id: "user-1" };
const mockEnv: BaseEnv = { ACTOR_KIT_SECRET: "test" };
const mockCtx = { id: "test-actor", caller: clientCaller, env: mockEnv };

describe("fromXStateMachine", () => {
  it("creates initial state from input", () => {
    const state = counterLogic.create({ initialCount: 10 }, mockCtx);
    const view = counterLogic.getView(state, clientCaller);
    expect(view.count).toBe(10);
    expect(view.lastUpdatedBy).toBeNull();
  });

  it("creates default state with empty input", () => {
    const state = counterLogic.create({}, mockCtx);
    const view = counterLogic.getView(state, clientCaller);
    expect(view.count).toBe(0);
  });

  it("transitions state with events", () => {
    const initial = counterLogic.create({}, mockCtx);
    const next = counterLogic.transition(initial, {
      type: "INCREMENT",
      caller: clientCaller,
      env: mockEnv,
    });
    const view = counterLogic.getView(next, clientCaller);
    expect(view.count).toBe(1);
    expect(view.lastUpdatedBy).toBe("user-1");
  });

  it("chains multiple transitions", () => {
    let state = counterLogic.create({}, mockCtx);
    state = counterLogic.transition(state, { type: "INCREMENT", caller: clientCaller, env: mockEnv });
    state = counterLogic.transition(state, { type: "INCREMENT", caller: clientCaller, env: mockEnv });
    state = counterLogic.transition(state, { type: "INCREMENT", caller: clientCaller, env: mockEnv });

    const view = counterLogic.getView(state, clientCaller);
    expect(view.count).toBe(3);
    expect(view.myAccessCount).toBe(3);
  });

  it("provides caller-scoped views", () => {
    const user2: Caller = { type: "client", id: "user-2" };
    let state = counterLogic.create({}, mockCtx);

    state = counterLogic.transition(state, { type: "INCREMENT", caller: clientCaller, env: mockEnv });
    state = counterLogic.transition(state, { type: "INCREMENT", caller: clientCaller, env: mockEnv });
    state = counterLogic.transition(state, { type: "INCREMENT", caller: user2, env: mockEnv });

    const view1 = counterLogic.getView(state, clientCaller);
    const view2 = counterLogic.getView(state, user2);

    // Both see same count
    expect(view1.count).toBe(3);
    expect(view2.count).toBe(3);

    // Different access counts
    expect(view1.myAccessCount).toBe(2);
    expect(view2.myAccessCount).toBe(1);
  });

  it("serializes and restores state", () => {
    let state = counterLogic.create({}, mockCtx);
    state = counterLogic.transition(state, { type: "INCREMENT", caller: clientCaller, env: mockEnv });

    const serialized = counterLogic.serialize(state);
    const restored = counterLogic.restore(serialized);
    const view = counterLogic.getView(restored, clientCaller);

    expect(view.count).toBe(1);
  });

  it("satisfies the ActorLogic interface", () => {
    // Type check — if this compiles, the adapter satisfies the interface
    expect(counterLogic.create).toBeTypeOf("function");
    expect(counterLogic.transition).toBeTypeOf("function");
    expect(counterLogic.getView).toBeTypeOf("function");
    expect(counterLogic.serialize).toBeTypeOf("function");
    expect(counterLogic.restore).toBeTypeOf("function");
    expect(counterLogic.migrate).toBeTypeOf("function");
  });
});
