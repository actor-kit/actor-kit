/**
 * Tests for the pure transition() API.
 *
 * These test state transitions as pure functions — no DO, no WebSocket,
 * no storage infrastructure required.
 */
import { describe, expect, it } from "vitest";
import { transition } from "@actor-kit/test";

// ---------------------------------------------------------------------------
// Test logic: a simple counter with caller-scoped access counts
// ---------------------------------------------------------------------------

type CounterState = {
  count: number;
  lastUpdatedBy: string | null;
  accessCounts: Record<string, number>;
};

type CounterClientEvent =
  | { type: "INCREMENT" }
  | { type: "SET"; value: number };

type CounterServiceEvent = { type: "RESET" };

type CounterEvent = CounterClientEvent | CounterServiceEvent;

type CounterView = {
  count: number;
  lastUpdatedBy: string | null;
  accessCount: number;
};

type CounterInput = { initialCount?: number };

type Caller = { type: "client" | "service"; id: string };

/**
 * Define the logic inline to avoid importing @actor-kit/core at runtime
 * (which pulls in cloudflare:workers). The object satisfies ActorLogic.
 */
const counterLogic = {
  create: (input: CounterInput) => ({
    count: input?.initialCount ?? 0,
    lastUpdatedBy: null,
    accessCounts: {} as Record<string, number>,
  }),
  transition: (
    state: CounterState,
    event: CounterEvent & { caller: Caller; env: Record<string, unknown> }
  ): CounterState => {
    switch (event.type) {
      case "INCREMENT":
        return {
          ...state,
          count: state.count + 1,
          lastUpdatedBy: event.caller.id,
          accessCounts: {
            ...state.accessCounts,
            [event.caller.id]:
              (state.accessCounts[event.caller.id] ?? 0) + 1,
          },
        };
      case "SET":
        return {
          ...state,
          count: event.value,
          lastUpdatedBy: event.caller.id,
        };
      case "RESET":
        return {
          ...state,
          count: 0,
          lastUpdatedBy: null,
        };
      default:
        return state;
    }
  },
  getView: (state: CounterState, caller: Caller): CounterView => ({
    count: state.count,
    lastUpdatedBy: state.lastUpdatedBy,
    accessCount: state.accessCounts[caller.id] ?? 0,
  }),
  serialize: (state: CounterState) => JSON.parse(JSON.stringify(state)),
  restore: (serialized: unknown) => serialized as CounterState,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("transition()", () => {
  it("applies a client event and returns the next state", () => {
    const result = transition(counterLogic, {
      event: { type: "INCREMENT" },
      caller: { type: "client", id: "user-1" },
    });

    expect(result.view.count).toBe(1);
    expect(result.view.lastUpdatedBy).toBe("user-1");
  });

  it("provides a caller-scoped view", () => {
    const result = transition(counterLogic, {
      event: { type: "INCREMENT" },
      caller: { type: "client", id: "user-1" },
    });

    expect(result.view.count).toBe(1);
    expect(result.view.accessCount).toBe(1);
  });

  it("returns only the caller's data in the view, not other callers", () => {
    // First: user-1 increments
    const after1 = transition(counterLogic, {
      event: { type: "INCREMENT" },
      caller: { type: "client", id: "user-1" },
    });

    // Second: user-2 increments, starting from after1's state
    const after2 = transition(counterLogic, {
      state: after1.state,
      event: { type: "INCREMENT" },
      caller: { type: "client", id: "user-2" },
    });

    // user-2's view should show user-2's access count
    expect(after2.view.accessCount).toBe(1);
    // Full state should show both callers
    expect(after2.state.accessCounts["user-1"]).toBe(1);
    expect(after2.state.accessCounts["user-2"]).toBe(1);
    expect(after2.state.count).toBe(2);
  });

  it("accepts a service event", () => {
    // Start with count=5
    const initial = transition(counterLogic, {
      event: { type: "SET", value: 5 },
      caller: { type: "client", id: "user-1" },
    });

    // Reset via service event
    const result = transition(counterLogic, {
      state: initial.state,
      event: { type: "RESET" },
      caller: { type: "service", id: "admin" },
    });

    expect(result.state.count).toBe(0);
    expect(result.state.lastUpdatedBy).toBeNull();
  });

  it("starts from default state when no state is provided", () => {
    const result = transition(counterLogic, {
      event: { type: "INCREMENT" },
      caller: { type: "client", id: "user-1" },
    });

    // Started from 0, incremented to 1
    expect(result.view.count).toBe(1);
  });

  it("starts from a provided state", () => {
    // Build a state with count=10
    const base = transition(counterLogic, {
      event: { type: "SET", value: 10 },
      caller: { type: "client", id: "user-1" },
    });

    // Increment from that state
    const result = transition(counterLogic, {
      state: base.state,
      event: { type: "INCREMENT" },
      caller: { type: "client", id: "user-1" },
    });

    expect(result.view.count).toBe(11);
  });

  it("provides mock env with ACTOR_KIT_SECRET", () => {
    // The logic receives env via event augmentation.
    // transition() should provide a mock env that satisfies BaseEnv.
    // If the logic didn't throw, it means env was provided correctly.
    const result = transition(counterLogic, {
      event: { type: "INCREMENT" },
      caller: { type: "client", id: "user-1" },
    });

    expect(result.view.count).toBe(1);
  });

  it("accepts custom input props", () => {
    const result = transition(counterLogic, {
      event: { type: "INCREMENT" },
      caller: { type: "client", id: "user-1" },
      input: { initialCount: 100 },
    });

    expect(result.view.count).toBe(101);
  });

  it("returns the view for the caller", () => {
    const result = transition(counterLogic, {
      event: { type: "INCREMENT" },
      caller: { type: "client", id: "user-1" },
    });

    expect(result.view.count).toBe(1);
    expect(result.view.accessCount).toBe(1);
    expect(result.view.lastUpdatedBy).toBe("user-1");
  });

  it("returns the full state for chaining", () => {
    const first = transition(counterLogic, {
      event: { type: "INCREMENT" },
      caller: { type: "client", id: "user-1" },
    });

    const second = transition(counterLogic, {
      state: first.state,
      event: { type: "INCREMENT" },
      caller: { type: "client", id: "user-1" },
    });

    expect(second.view.count).toBe(2);
    expect(second.state.accessCounts["user-1"]).toBe(2);
  });

  it("provides zero access count for callers with no prior events", () => {
    const result = transition(counterLogic, {
      event: { type: "SET", value: 42 },
      caller: { type: "client", id: "user-1" },
    });

    // SET action doesn't increment access count, so user-1 has 0
    expect(result.view.accessCount).toBe(0);
  });

  it("provides mock env with ACTOR_KIT_SECRET to the logic", () => {
    // Build a logic that reads env.ACTOR_KIT_SECRET in transition
    const envReadingLogic = {
      create: () => ({ secret: "" }),
      transition: (
        state: { secret: string },
        event: { type: "READ_SECRET" } & {
          caller: Caller;
          env: { ACTOR_KIT_SECRET: string; [key: string]: unknown };
        }
      ) => {
        if (event.type === "READ_SECRET") {
          return { secret: event.env.ACTOR_KIT_SECRET };
        }
        return state;
      },
      getView: (state: { secret: string }) => ({ secret: state.secret }),
      serialize: (state: { secret: string }) =>
        JSON.parse(JSON.stringify(state)),
      restore: (serialized: unknown) => serialized as { secret: string },
    };

    const result = transition(envReadingLogic, {
      event: { type: "READ_SECRET" as const },
      caller: { type: "client", id: "user-1" },
    });

    // The mock env provides "test-secret" as ACTOR_KIT_SECRET
    expect(result.view.secret).toBe("test-secret");
  });

  it("provides undefined for unknown env properties", () => {
    // Build a logic that reads an undefined env property
    const envReadingLogic = {
      create: () => ({ envValue: "initial" as unknown }),
      transition: (
        state: { envValue: unknown },
        event: { type: "READ_UNKNOWN" } & {
          caller: Caller;
          env: { ACTOR_KIT_SECRET: string; [key: string]: unknown };
        }
      ) => {
        if (event.type === "READ_UNKNOWN") {
          return {
            envValue: (event.env as Record<string, unknown>).NONEXISTENT,
          };
        }
        return state;
      },
      getView: (state: { envValue: unknown }) => ({
        envValue: state.envValue,
      }),
      serialize: (state: { envValue: unknown }) =>
        JSON.parse(JSON.stringify(state)),
      restore: (serialized: unknown) => serialized as { envValue: unknown },
    };

    const result = transition(envReadingLogic, {
      event: { type: "READ_UNKNOWN" as const },
      caller: { type: "client", id: "user-1" },
    });

    expect(result.view.envValue).toBeUndefined();
  });
});
