import { beforeAll, describe, expect, it, vi } from "vitest";
import { assign, setup } from "xstate";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class DurableObject {
    constructor(
      public readonly state: unknown,
      public readonly env: unknown
    ) {}
  },
}));

// Import the machine client after mocking
let createActorKitMachineClient: typeof import("../src/createActorKitMachineClient").createActorKitMachineClient;

beforeAll(async () => {
  const mod = await import("../src/createActorKitMachineClient");
  createActorKitMachineClient = mod.createActorKitMachineClient;
});

// Simple test machine inline — no dependency on the todo example
const counterMachine = setup({
  types: {
    context: {} as {
      public: { count: number; ownerId: string };
      private: Record<string, never>;
    },
    events: {} as
      | { type: "INCREMENT"; caller: { id: string; type: "client" } }
      | { type: "DECREMENT"; caller: { id: string; type: "client" } }
      | { type: "RESET"; caller: { id: string; type: "client" } },
    input: {} as { id: string; caller: { id: string; type: string } },
  },
  guards: {
    isOwner: ({ context, event }) =>
      event.caller.id === context.public.ownerId,
  },
}).createMachine({
  id: "counter",
  initial: "active",
  context: ({ input }) => ({
    public: { count: 0, ownerId: input.caller.id },
    private: {},
  }),
  states: {
    active: {
      on: {
        INCREMENT: {
          guard: "isOwner",
          actions: assign({
            public: ({ context }) => ({
              ...context.public,
              count: context.public.count + 1,
            }),
          }),
        },
        DECREMENT: {
          guard: "isOwner",
          actions: assign({
            public: ({ context }) => ({
              ...context.public,
              count: context.public.count - 1,
            }),
          }),
        },
        RESET: {
          guard: "isOwner",
          actions: assign({
            public: ({ context }) => ({
              ...context.public,
              count: 0,
            }),
          }),
        },
      },
    },
  },
});

type CounterMachine = typeof counterMachine;

describe("createActorKitMachineClient", () => {
  it("runs the real machine and applies events", () => {
    const client = createActorKitMachineClient<CounterMachine>({
      machine: counterMachine,
      input: { id: "counter-1", caller: { id: "user-1", type: "client" } },
    });

    expect(client.getState().public.count).toBe(0);

    client.send({ type: "INCREMENT", caller: { id: "user-1", type: "client" } });
    expect(client.getState().public.count).toBe(1);

    client.send({ type: "INCREMENT", caller: { id: "user-1", type: "client" } });
    expect(client.getState().public.count).toBe(2);

    client.send({ type: "DECREMENT", caller: { id: "user-1", type: "client" } });
    expect(client.getState().public.count).toBe(1);
  });

  it("evaluates guards — non-owner events are rejected", () => {
    const client = createActorKitMachineClient<CounterMachine>({
      machine: counterMachine,
      input: { id: "counter-1", caller: { id: "owner", type: "client" } },
    });

    // Non-owner tries to increment
    client.send({ type: "INCREMENT", caller: { id: "hacker", type: "client" } });
    expect(client.getState().public.count).toBe(0); // Unchanged — guard rejected
  });

  it("notifies subscribers on state transitions", () => {
    const client = createActorKitMachineClient<CounterMachine>({
      machine: counterMachine,
      input: { id: "counter-1", caller: { id: "user-1", type: "client" } },
    });

    const listener = vi.fn();
    client.subscribe(listener);

    client.send({ type: "INCREMENT", caller: { id: "user-1", type: "client" } });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].public.count).toBe(1);
  });

  it("unsubscribe stops notifications", () => {
    const client = createActorKitMachineClient<CounterMachine>({
      machine: counterMachine,
      input: { id: "counter-1", caller: { id: "user-1", type: "client" } },
    });

    const listener = vi.fn();
    const unsub = client.subscribe(listener);

    client.send({ type: "INCREMENT", caller: { id: "user-1", type: "client" } });
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    client.send({ type: "INCREMENT", caller: { id: "user-1", type: "client" } });
    expect(listener).toHaveBeenCalledTimes(1); // Not called again
  });

  it("getState returns caller-scoped snapshot shape", () => {
    const client = createActorKitMachineClient<CounterMachine>({
      machine: counterMachine,
      input: { id: "counter-1", caller: { id: "user-1", type: "client" } },
    });

    const state = client.getState();
    expect(state).toHaveProperty("public");
    expect(state).toHaveProperty("private");
    expect(state).toHaveProperty("value");
    expect(state.value).toBe("active");
  });

  it("connect and disconnect are safe no-ops", async () => {
    const client = createActorKitMachineClient<CounterMachine>({
      machine: counterMachine,
      input: { id: "counter-1", caller: { id: "user-1", type: "client" } },
    });

    await expect(client.connect()).resolves.toBeUndefined();
    expect(() => client.disconnect()).not.toThrow();
  });

  it("scopes private data to the caller ID, not the full private map", () => {
    // Machine with per-caller private data
    const privateMachine = setup({
      types: {
        context: {} as {
          public: { total: number };
          private: Record<string, { seen: boolean }>;
        },
        events: {} as {
          type: "MARK_SEEN";
          caller: { id: string; type: "client" };
          storage: unknown;
          env: unknown;
        },
        input: {} as { id: string; caller: { id: string; type: string } },
      },
    }).createMachine({
      id: "private-test",
      initial: "active",
      context: ({ input }) => ({
        public: { total: 0 },
        private: {
          [input.caller.id]: { seen: false },
          "other-user": { seen: true },
        },
      }),
      states: {
        active: {
          on: {
            MARK_SEEN: {
              actions: assign({
                private: ({ context, event }) => ({
                  ...context.private,
                  [event.caller.id]: { seen: true },
                }),
              }),
            },
          },
        },
      },
    });

    type PrivateMachine = typeof privateMachine;

    const client = createActorKitMachineClient<PrivateMachine>({
      machine: privateMachine,
      input: { id: "test-1", caller: { id: "user-1", type: "client" } },
    });

    const state = client.getState();
    // Should return only user-1's private data, not the whole map
    expect(state.private).toEqual({ seen: false });
    // Should NOT contain other-user's data
    expect(state.private).not.toHaveProperty("other-user");
  });

  it("augments events with caller, storage, and env fields", () => {
    // Machine that reads event.caller and event.env in a guard
    let receivedEvent: Record<string, unknown> | null = null;

    const inspectMachine = setup({
      types: {
        context: {} as {
          public: { count: number; ownerId: string };
          private: Record<string, never>;
        },
        events: {} as {
          type: "PING";
          caller: { id: string; type: string };
          storage: unknown;
          env: unknown;
        },
        input: {} as { id: string; caller: { id: string; type: string } },
      },
      guards: {
        hasCallerAndEnv: ({ event }) => {
          receivedEvent = event as unknown as Record<string, unknown>;
          return event.caller !== undefined;
        },
      },
    }).createMachine({
      id: "inspect-test",
      initial: "active",
      context: ({ input }) => ({
        public: { count: 0, ownerId: input.caller.id },
        private: {},
      }),
      states: {
        active: {
          on: {
            PING: {
              guard: "hasCallerAndEnv",
              actions: assign({
                public: ({ context }) => ({
                  ...context.public,
                  count: context.public.count + 1,
                }),
              }),
            },
          },
        },
      },
    });

    type InspectMachine = typeof inspectMachine;

    const client = createActorKitMachineClient<InspectMachine>({
      machine: inspectMachine,
      input: { id: "test-1", caller: { id: "user-1", type: "client" } },
    });

    // Send without explicit caller — the client should inject it
    client.send({
      type: "PING",
    } as any);

    // Guard should have passed (event had caller)
    expect(client.getState().public.count).toBe(1);

    // Verify the event had the expected fields
    expect(receivedEvent).toHaveProperty("caller");
    expect(receivedEvent).toHaveProperty("storage");
    expect(receivedEvent).toHaveProperty("env");
    expect((receivedEvent as any).caller.id).toBe("user-1");
  });

  it("waitFor resolves when predicate matches after send", async () => {
    const client = createActorKitMachineClient<CounterMachine>({
      machine: counterMachine,
      input: { id: "counter-1", caller: { id: "user-1", type: "client" } },
    });

    const waitPromise = client.waitFor((s) => s.public.count === 3);

    client.send({ type: "INCREMENT", caller: { id: "user-1", type: "client" } });
    client.send({ type: "INCREMENT", caller: { id: "user-1", type: "client" } });
    client.send({ type: "INCREMENT", caller: { id: "user-1", type: "client" } });

    await expect(waitPromise).resolves.toBeUndefined();
  });
});
