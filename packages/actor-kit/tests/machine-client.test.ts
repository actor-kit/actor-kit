/**
 * Tests for createActorKitMachineClient — a mock client that runs the real machine.
 *
 * Unlike createActorKitMockClient (snapshot-only), this client starts an XState
 * actor so guards, actions, and invoked actors actually execute.
 */
import { describe, expect, it, vi } from "vitest";
import { assign, setup } from "xstate";
import { createActorKitMachineClient } from "../src/createActorKitMachineClient";
import type {
  ActorKitSystemEvent,
  BaseActorKitEvent,
  WithActorKitEvent,
  WithActorKitInput,
} from "../src/types";

// ---------------------------------------------------------------------------
// Test machine: counter with a guard
// ---------------------------------------------------------------------------

interface TestEnv {
  ACTOR_KIT_SECRET: string;
  [key: string]: unknown;
}

type CounterClientEvent =
  | { type: "INCREMENT" }
  | { type: "SET"; value: number }
  | { type: "ADMIN_RESET" };

type CounterServiceEvent = { type: "NOOP" };

type CounterEvent = (
  | WithActorKitEvent<CounterClientEvent, "client">
  | WithActorKitEvent<CounterServiceEvent, "service">
  | ActorKitSystemEvent
) &
  BaseActorKitEvent<TestEnv>;

type CounterInput = WithActorKitInput<
  { initialCount?: number },
  TestEnv
>;

type CounterContext = {
  public: { count: number; lastUpdatedBy: string | null };
  private: Record<string, { accessCount: number }>;
};

const counterMachine = setup({
  types: {
    context: {} as CounterContext,
    events: {} as CounterEvent,
    input: {} as CounterInput,
  },
  guards: {
    isAdmin: ({ event }) => event.caller.id === "admin",
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
    resetCounter: assign({
      public: ({ context }) => ({
        ...context.public,
        count: 0,
        lastUpdatedBy: null,
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
  },
}).createMachine({
  id: "counter",
  type: "parallel",
  context: ({ input }: { input: CounterInput }) => ({
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
        ADMIN_RESET: {
          guard: "isAdmin",
          actions: ["resetCounter"],
        },
      },
    },
  },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createActorKitMachineClient", () => {
  it("runs the real machine: send() triggers actions", () => {
    const client = createActorKitMachineClient({
      machine: counterMachine,
      caller: { type: "client", id: "user-1" },
    });

    client.send({ type: "INCREMENT" });

    expect(client.getState().public.count).toBe(1);
    expect(client.getState().public.lastUpdatedBy).toBe("user-1");
  });

  it("evaluates guards: non-admin cannot reset", () => {
    const client = createActorKitMachineClient({
      machine: counterMachine,
      caller: { type: "client", id: "user-1" },
    });

    client.send({ type: "SET", value: 10 });
    expect(client.getState().public.count).toBe(10);

    // Non-admin tries to reset — guard should reject
    client.send({ type: "ADMIN_RESET" });
    expect(client.getState().public.count).toBe(10);
  });

  it("evaluates guards: admin can reset", () => {
    const client = createActorKitMachineClient({
      machine: counterMachine,
      caller: { type: "client", id: "admin" },
    });

    client.send({ type: "SET", value: 10 });
    client.send({ type: "ADMIN_RESET" });
    expect(client.getState().public.count).toBe(0);
  });

  it("subscribe notifies on transitions", () => {
    const client = createActorKitMachineClient({
      machine: counterMachine,
      caller: { type: "client", id: "user-1" },
    });

    const listener = vi.fn();
    client.subscribe(listener);

    client.send({ type: "INCREMENT" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].public.count).toBe(1);
  });

  it("unsubscribe stops notifications", () => {
    const client = createActorKitMachineClient({
      machine: counterMachine,
      caller: { type: "client", id: "user-1" },
    });

    const listener = vi.fn();
    const unsub = client.subscribe(listener);
    unsub();

    client.send({ type: "INCREMENT" });

    expect(listener).not.toHaveBeenCalled();
  });

  it("returns caller-scoped snapshot", () => {
    const client = createActorKitMachineClient({
      machine: counterMachine,
      caller: { type: "client", id: "user-1" },
    });

    client.send({ type: "INCREMENT" });

    const state = client.getState();
    expect(state.public.count).toBe(1);
    expect(state.private.accessCount).toBe(1);
    expect(state.value).toBeDefined();
  });

  it("accepts custom input props", () => {
    const client = createActorKitMachineClient({
      machine: counterMachine,
      caller: { type: "client", id: "user-1" },
      input: { initialCount: 50 },
    });

    expect(client.getState().public.count).toBe(50);
  });

  it("connect and disconnect are no-ops (don't throw)", async () => {
    const client = createActorKitMachineClient({
      machine: counterMachine,
      caller: { type: "client", id: "user-1" },
    });

    await expect(client.connect()).resolves.toBeUndefined();
    expect(() => client.disconnect()).not.toThrow();
  });

  it("waitFor resolves when condition is met", async () => {
    const client = createActorKitMachineClient({
      machine: counterMachine,
      caller: { type: "client", id: "user-1" },
    });

    // Already at 0 — condition met
    await expect(
      client.waitFor((s) => s.public.count === 0)
    ).resolves.toBeUndefined();
  });

  it("select() works on machine client", () => {
    const client = createActorKitMachineClient({
      machine: counterMachine,
      caller: { type: "client", id: "user-1" },
    });

    const count = client.select((s) => s.public.count);
    expect(count.get()).toBe(0);

    client.send({ type: "INCREMENT" });
    expect(count.get()).toBe(1);
  });

  it("trigger works on machine client", () => {
    const client = createActorKitMachineClient({
      machine: counterMachine,
      caller: { type: "client", id: "user-1" },
    });

    client.trigger.INCREMENT();
    expect(client.getState().public.count).toBe(1);
  });
});
