/**
 * Plain counter using defineLogic — no state library dependency.
 */
import { defineLogic, createDurableActor, type BaseEnv, type Caller } from "../../../packages/core/src/index";
import { z } from "zod";

// --- Env ---

export interface Env extends BaseEnv {
  COUNTER: DurableObjectNamespace<InstanceType<typeof Counter>>;
}

// --- State ---

type CounterState = {
  count: number;
  accessCounts: Record<string, number>;
};

// --- Events ---

type CounterEvent =
  | { type: "INCREMENT" }
  | { type: "DECREMENT" }
  | { type: "RESET" };

// --- View ---

export type CounterView = {
  count: number;
  myAccessCount: number;
};

// --- Logic ---

const counterLogic = defineLogic<CounterState, CounterEvent, CounterView, Env>({
  create: (_input, _ctx) => ({
    count: 0,
    accessCounts: {},
  }),

  transition: (state, event) => {
    const caller = event.caller;
    const bumpAccess = (s: CounterState, c: Caller): CounterState => ({
      ...s,
      accessCounts: {
        ...s.accessCounts,
        [c.id]: (s.accessCounts[c.id] ?? 0) + 1,
      },
    });

    switch (event.type) {
      case "INCREMENT":
        return bumpAccess({ ...state, count: state.count + 1 }, caller);
      case "DECREMENT":
        return bumpAccess({ ...state, count: state.count - 1 }, caller);
      case "RESET":
        if (caller.type !== "service") return state;
        return { ...state, count: 0 };
      default:
        return state;
    }
  },

  getView: (state, caller) => ({
    count: state.count,
    myAccessCount: state.accessCounts[caller.id] ?? 0,
  }),
});

// --- Durable Object ---

export const Counter = createDurableActor({
  logic: counterLogic,
  events: {
    client: z.discriminatedUnion("type", [
      z.object({ type: z.literal("INCREMENT") }),
      z.object({ type: z.literal("DECREMENT") }),
    ]),
    service: z.discriminatedUnion("type", [
      z.object({ type: z.literal("RESET") }),
    ]),
  },
  input: z.object({}),
  persisted: true,
});
