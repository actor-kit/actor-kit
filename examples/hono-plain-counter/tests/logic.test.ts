/**
 * Unit tests for the counter logic — no Workers runtime needed.
 *
 * Uses the transition() helper from @actor-kit/test to test
 * the actor logic as a pure function.
 */
import { describe, expect, it } from "vitest";
import { transition } from "../../../packages/test/src/transition";
import { defineLogic, type BaseEnv, type Caller } from "../../../packages/core/src/index";

// Replicate the counter logic inline for a self-contained test.
// In a real app, you'd import from your counter module.
const counterLogic = defineLogic<
  { count: number; lastUpdatedBy: string | null; accessCounts: Record<string, number> },
  { type: "INCREMENT" } | { type: "DECREMENT" } | { type: "RESET" },
  { count: number; lastUpdatedBy: string | null; myAccessCount: number },
  BaseEnv,
  Record<string, unknown>
>({
  create: () => ({ count: 0, lastUpdatedBy: null, accessCounts: {} }),

  transition: (state, event) => {
    const { caller } = event;
    switch (event.type) {
      case "INCREMENT":
        return {
          ...state,
          count: state.count + 1,
          lastUpdatedBy: caller.id,
          accessCounts: {
            ...state.accessCounts,
            [caller.id]: (state.accessCounts[caller.id] ?? 0) + 1,
          },
        };
      case "DECREMENT":
        return { ...state, count: state.count - 1, lastUpdatedBy: caller.id };
      case "RESET":
        if (caller.type !== "service") return state;
        return { ...state, count: 0, lastUpdatedBy: null };
      default:
        return state;
    }
  },

  getView: (state, caller) => ({
    count: state.count,
    lastUpdatedBy: state.lastUpdatedBy,
    myAccessCount: state.accessCounts[caller.id] ?? 0,
  }),
});

const client: Caller = { type: "client", id: "user-1" };
const service: Caller = { type: "service", id: "admin" };

describe("counter logic: transitions", () => {
  it("starts at zero", () => {
    const result = transition(counterLogic, {
      event: { type: "INCREMENT" },
      caller: client,
    });
    expect(result.view.count).toBe(1);
  });

  it("increments and tracks caller", () => {
    const result = transition(counterLogic, {
      event: { type: "INCREMENT" },
      caller: client,
    });
    expect(result.view.lastUpdatedBy).toBe("user-1");
    expect(result.view.myAccessCount).toBe(1);
  });

  it("decrements", () => {
    const first = transition(counterLogic, {
      event: { type: "INCREMENT" },
      caller: client,
    });
    const second = transition(counterLogic, {
      state: first.state,
      event: { type: "DECREMENT" },
      caller: client,
    });
    expect(second.view.count).toBe(0);
  });

  it("chains multiple transitions", () => {
    let state = transition(counterLogic, {
      event: { type: "INCREMENT" },
      caller: client,
    }).state;
    state = transition(counterLogic, {
      state,
      event: { type: "INCREMENT" },
      caller: client,
    }).state;
    state = transition(counterLogic, {
      state,
      event: { type: "INCREMENT" },
      caller: client,
    }).state;

    const result = transition(counterLogic, {
      state,
      event: { type: "DECREMENT" },
      caller: client,
    });
    expect(result.view.count).toBe(2);
    expect(result.view.myAccessCount).toBe(3); // 3 increments tracked
  });
});

describe("counter logic: authorization", () => {
  it("client cannot reset", () => {
    const after = transition(counterLogic, {
      event: { type: "INCREMENT" },
      caller: client,
    });
    const resetAttempt = transition(counterLogic, {
      state: after.state,
      event: { type: "RESET" },
      caller: client,
    });
    expect(resetAttempt.view.count).toBe(1); // unchanged
  });

  it("service can reset", () => {
    const after = transition(counterLogic, {
      event: { type: "INCREMENT" },
      caller: client,
    });
    const reset = transition(counterLogic, {
      state: after.state,
      event: { type: "RESET" },
      caller: service,
    });
    expect(reset.view.count).toBe(0);
  });
});

describe("counter logic: caller-scoped views", () => {
  it("each caller sees their own access count", () => {
    const user2: Caller = { type: "client", id: "user-2" };

    let state = transition(counterLogic, {
      event: { type: "INCREMENT" },
      caller: client,
    }).state;
    state = transition(counterLogic, {
      state,
      event: { type: "INCREMENT" },
      caller: client,
    }).state;
    state = transition(counterLogic, {
      state,
      event: { type: "INCREMENT" },
      caller: user2,
    }).state;

    const view1 = counterLogic.getView(state, client);
    const view2 = counterLogic.getView(state, user2);

    expect(view1.count).toBe(3); // shared
    expect(view2.count).toBe(3); // shared
    expect(view1.myAccessCount).toBe(2); // user-1's count
    expect(view2.myAccessCount).toBe(1); // user-2's count
  });
});
