/**
 * Test worker: Counter DO using @actor-kit/core with zero XState dependency.
 * Validates createDurableActor + defineLogic work in the real Workers runtime.
 */
import { defineLogic, createDurableActor, type BaseEnv, type Caller } from "../../../src/index";
import { z } from "zod";

// --- Env ---

export interface Env extends BaseEnv {
  COUNTER: DurableObjectNamespace<InstanceType<typeof Counter>>;
}

// --- State ---

type CounterState = {
  count: number;
  lastUpdatedBy: string | null;
  accessCounts: Record<string, number>;
};

// --- Events ---

type CounterEvent =
  | { type: "INCREMENT" }
  | { type: "DECREMENT" }
  | { type: "SET"; value: number }
  | { type: "RESET" };

// --- View ---

type CounterView = {
  count: number;
  lastUpdatedBy: string | null;
  myAccessCount: number;
};

// --- Logic ---

const counterLogic = defineLogic<CounterState, CounterEvent, CounterView, Env, { initialCount?: number }>({
  create: (input, _ctx) => ({
    count: input.initialCount ?? 0,
    lastUpdatedBy: null,
    accessCounts: {},
  }),

  transition: (state, event) => {
    const caller = event.caller;
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
        return {
          ...state,
          count: state.count - 1,
          lastUpdatedBy: caller.id,
        };
      case "SET":
        return {
          ...state,
          count: event.value,
          lastUpdatedBy: caller.id,
        };
      case "RESET":
        if (caller.type !== "service") return state;
        return {
          ...state,
          count: 0,
          lastUpdatedBy: null,
        };
      default:
        return state;
    }
  },

  getView: (state, caller) => ({
    count: state.count,
    lastUpdatedBy: state.lastUpdatedBy,
    myAccessCount: state.accessCounts[caller.id] ?? 0,
  }),

  onConnect: (state, caller) => {
    return {
      ...state,
      accessCounts: {
        ...state.accessCounts,
        [caller.id]: (state.accessCounts[caller.id] ?? 0) + 1,
      },
    };
  },
});

// --- Durable Object ---

export const Counter = createDurableActor({
  logic: counterLogic,
  events: {
    client: z.discriminatedUnion("type", [
      z.object({ type: z.literal("INCREMENT") }),
      z.object({ type: z.literal("DECREMENT") }),
      z.object({ type: z.literal("SET"), value: z.number() }),
    ]),
    service: z.discriminatedUnion("type", [
      z.object({ type: z.literal("RESET") }),
    ]),
  },
  input: z.object({ initialCount: z.number().optional() }),
  persisted: true,
});

// --- Worker ---

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    return new Response("actor-kit core test worker", { status: 200 });
  },
};
