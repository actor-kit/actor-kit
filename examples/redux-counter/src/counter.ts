/**
 * Counter using fromRedux adapter with a standard Redux reducer.
 */
import { fromRedux } from "../../../packages/redux/src/fromRedux";
import { createDurableActor, type BaseEnv, type Caller } from "../../../packages/core/src/index";
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

// --- Actions ---

type CounterAction =
  | { type: "INCREMENT" }
  | { type: "DECREMENT" }
  | { type: "RESET" };

// --- View ---

export type CounterView = {
  count: number;
  myAccessCount: number;
};

// --- Reducer ---

const initialState: CounterState = { count: 0, accessCounts: {} };

function counterReducer(
  state: CounterState | undefined,
  action: CounterAction & { caller: Caller; env: Env }
): CounterState {
  const s = state ?? initialState;
  const callerId = action.caller.id;

  switch (action.type) {
    case "INCREMENT":
      return {
        ...s,
        count: s.count + 1,
        accessCounts: {
          ...s.accessCounts,
          [callerId]: (s.accessCounts[callerId] ?? 0) + 1,
        },
      };
    case "DECREMENT":
      return {
        ...s,
        count: s.count - 1,
        accessCounts: {
          ...s.accessCounts,
          [callerId]: (s.accessCounts[callerId] ?? 0) + 1,
        },
      };
    case "RESET":
      if (action.caller.type !== "service") return s;
      return { ...s, count: 0 };
    default:
      return s;
  }
}

// --- Logic ---

const counterLogic = fromRedux<CounterState, CounterAction, CounterView, Env>(
  counterReducer,
  {
    create: (_input, _ctx) => ({ count: 0, accessCounts: {} }),
    getView: (state, caller) => ({
      count: state.count,
      myAccessCount: state.accessCounts[caller.id] ?? 0,
    }),
  }
);

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
