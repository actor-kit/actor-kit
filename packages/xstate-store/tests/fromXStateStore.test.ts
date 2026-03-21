import { describe, expect, it } from "vitest";
import { fromXStateStore } from "../src/fromXStateStore";
import type { Caller, BaseEnv } from "@actor-kit/core";

type CounterView = {
  count: number;
  myAccessCount: number;
};

const clientCaller: Caller = { type: "client", id: "user-1" };
const mockEnv: BaseEnv = { ACTOR_KIT_SECRET: "test" };
const mockCtx = { id: "test-actor", caller: clientCaller, env: mockEnv };

const counterLogic = fromXStateStore({
  context: { count: 0, accessCounts: {} as Record<string, number> },
  on: {
    inc: (ctx, event: { caller: Caller }) => ({
      ...ctx,
      count: ctx.count + 1,
      accessCounts: {
        ...ctx.accessCounts,
        [event.caller.id]: (ctx.accessCounts[event.caller.id] ?? 0) + 1,
      },
    }),
    reset: (ctx, event: { caller: Caller }) => {
      if (event.caller.type !== "service") return ctx;
      return { ...ctx, count: 0 };
    },
  },
}, {
  getView: (state, caller): CounterView => ({
    count: state.count,
    myAccessCount: state.accessCounts[caller.id] ?? 0,
  }),
});

describe("fromXStateStore", () => {
  it("creates initial state", () => {
    const state = counterLogic.create({}, mockCtx);
    expect(state.count).toBe(0);
  });

  it("creates state from context factory", () => {
    const logic = fromXStateStore({
      context: (input: Record<string, unknown>) => ({
        count: (input.initialCount as number) ?? 0,
      }),
      on: {
        inc: (ctx) => ({ ...ctx, count: ctx.count + 1 }),
      },
    }, {
      getView: (state) => ({ count: state.count }),
    });

    const state = logic.create({ initialCount: 42 }, mockCtx);
    expect(state.count).toBe(42);
  });

  it("transitions with caller on event", () => {
    let state = counterLogic.create({}, mockCtx);
    state = counterLogic.transition(state, {
      type: "inc",
      caller: clientCaller,
      env: mockEnv,
    });

    const view = counterLogic.getView(state, clientCaller);
    expect(view.count).toBe(1);
    expect(view.myAccessCount).toBe(1);
  });

  it("chains transitions", () => {
    let state = counterLogic.create({}, mockCtx);
    state = counterLogic.transition(state, { type: "inc", caller: clientCaller, env: mockEnv });
    state = counterLogic.transition(state, { type: "inc", caller: clientCaller, env: mockEnv });
    state = counterLogic.transition(state, { type: "inc", caller: clientCaller, env: mockEnv });

    const view = counterLogic.getView(state, clientCaller);
    expect(view.count).toBe(3);
    expect(view.myAccessCount).toBe(3);
  });

  it("caller-scoped views work", () => {
    const user2: Caller = { type: "client", id: "user-2" };
    let state = counterLogic.create({}, mockCtx);

    state = counterLogic.transition(state, { type: "inc", caller: clientCaller, env: mockEnv });
    state = counterLogic.transition(state, { type: "inc", caller: user2, env: mockEnv });

    expect(counterLogic.getView(state, clientCaller).myAccessCount).toBe(1);
    expect(counterLogic.getView(state, user2).myAccessCount).toBe(1);
    expect(counterLogic.getView(state, clientCaller).count).toBe(2);
  });

  it("authorization via caller type", () => {
    let state = counterLogic.create({}, mockCtx);
    state = counterLogic.transition(state, { type: "inc", caller: clientCaller, env: mockEnv });

    // Client can't reset
    state = counterLogic.transition(state, { type: "reset", caller: clientCaller, env: mockEnv });
    expect(state.count).toBe(1);

    // Service can reset
    state = counterLogic.transition(state, {
      type: "reset",
      caller: { type: "service", id: "admin" },
      env: mockEnv,
    });
    expect(state.count).toBe(0);
  });

  it("ignores unknown event types", () => {
    let state = counterLogic.create({}, mockCtx);
    state = counterLogic.transition(state, { type: "unknown", caller: clientCaller, env: mockEnv });
    expect(state.count).toBe(0);
  });

  it("serialize and restore round-trip", () => {
    let state = counterLogic.create({}, mockCtx);
    state = counterLogic.transition(state, { type: "inc", caller: clientCaller, env: mockEnv });

    const serialized = counterLogic.serialize(state);
    const restored = counterLogic.restore(serialized);
    expect(counterLogic.getView(restored, clientCaller).count).toBe(1);
  });
});
