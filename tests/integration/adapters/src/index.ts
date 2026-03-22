/**
 * Test worker: PlainCounter + ReduxCounter + StoreCounter DOs
 * for adapter integration tests.
 *
 * All three implement identical counter behavior using different adapters:
 * - PlainCounter: defineLogic from @actor-kit/core
 * - ReduxCounter: fromRedux from @actor-kit/redux
 * - StoreCounter: fromXStateStore from @actor-kit/xstate-store
 *
 * Counter behavior:
 * - INCREMENT / DECREMENT: any caller
 * - RESET: service-only (clients ignored)
 * - Per-caller access tracking via onConnect lifecycle
 * - getView returns { count, myAccessCount } scoped to caller
 */
import {
  createDurableActor,
  defineLogic,
} from "../../../../packages/core/src/index";
import { fromRedux } from "../../../../packages/redux/src/index";
import { fromXStateStore } from "../../../../packages/xstate-store/src/index";
import { z } from "zod";
import type { Caller, BaseEnv } from "../../../../packages/core/src/types";

// ============================================================================
// Shared schemas and types
// ============================================================================

const ClientEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("INCREMENT") }),
  z.object({ type: z.literal("DECREMENT") }),
  z.object({ type: z.literal("RESET") }), // will be ignored for clients
]);

const ServiceEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("INCREMENT") }),
  z.object({ type: z.literal("DECREMENT") }),
  z.object({ type: z.literal("RESET") }),
]);

const InputPropsSchema = z.object({
  initialCount: z.number().optional(),
});

type InputProps = z.infer<typeof InputPropsSchema>;

/** Internal state shape shared by all three adapters */
type CounterState = {
  count: number;
  accessCounts: Record<string, number>;
};

/** Caller-scoped view — what clients see */
type CounterView = {
  count: number;
  myAccessCount: number;
};

// ============================================================================
// Shared helpers
// ============================================================================

function createInitialState(input: InputProps, _ctx: { id: string; caller: Caller; env: BaseEnv }): CounterState {
  return {
    count: input.initialCount ?? 0,
    accessCounts: {},
  };
}

function getCounterView(state: CounterState, caller: Caller): CounterView {
  return {
    count: state.count,
    myAccessCount: state.accessCounts[caller.id] ?? 0,
  };
}

function handleConnect(state: CounterState, caller: Caller): CounterState {
  return {
    ...state,
    accessCounts: {
      ...state.accessCounts,
      [caller.id]: (state.accessCounts[caller.id] ?? 0) + 1,
    },
  };
}

// ============================================================================
// PlainCounter — defineLogic
// ============================================================================

const plainCounterLogic = defineLogic<
  CounterState,
  { type: "INCREMENT" } | { type: "DECREMENT" } | { type: "RESET" },
  CounterView,
  BaseEnv,
  InputProps
>({
  create: createInitialState,

  transition(state, event) {
    switch (event.type) {
      case "INCREMENT":
        return { ...state, count: state.count + 1 };
      case "DECREMENT":
        return { ...state, count: state.count - 1 };
      case "RESET":
        if (event.caller.type !== "service") return state;
        return { ...state, count: 0 };
      default:
        return state;
    }
  },

  getView: getCounterView,
  onConnect: handleConnect,
});

export const PlainCounter = createDurableActor({
  logic: plainCounterLogic,
  events: {
    client: ClientEventSchema,
    service: ServiceEventSchema,
  },
  input: InputPropsSchema,
  persisted: true,
});

// ============================================================================
// ReduxCounter — fromRedux
// ============================================================================

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
      return { ...state, count: state.count + 1 };
    case "DECREMENT":
      return { ...state, count: state.count - 1 };
    case "RESET":
      if (action.caller.type !== "service") return state;
      return { ...state, count: 0 };
    default:
      return state;
  }
}

const reduxCounterLogic = fromRedux<
  CounterState,
  CounterAction,
  CounterView,
  BaseEnv,
  InputProps
>(counterReducer, {
  create: createInitialState,
  getView: getCounterView,
});

// fromRedux doesn't expose onConnect, so we add it manually
const reduxCounterLogicWithConnect = {
  ...reduxCounterLogic,
  onConnect: handleConnect,
};

export const ReduxCounter = createDurableActor({
  logic: reduxCounterLogicWithConnect,
  events: {
    client: ClientEventSchema,
    service: ServiceEventSchema,
  },
  input: InputPropsSchema,
  persisted: true,
});

// ============================================================================
// StoreCounter — fromXStateStore
// ============================================================================

const storeCounterLogic = fromXStateStore(
  {
    context: { count: 0, accessCounts: {} as Record<string, number> },
    on: {
      INCREMENT: (ctx) => ({ ...ctx, count: ctx.count + 1 }),
      DECREMENT: (ctx) => ({ ...ctx, count: ctx.count - 1 }),
      RESET: (ctx, event: { caller: Caller; env: BaseEnv }) => {
        if (event.caller.type !== "service") return ctx;
        return { ...ctx, count: 0 };
      },
    },
  },
  {
    getView: getCounterView,
  }
);

// fromXStateStore doesn't expose onConnect, so we add it manually
const storeCounterLogicWithConnect = {
  ...storeCounterLogic,
  onConnect: handleConnect,
  // Override create to support initialCount input
  create: (input: Record<string, unknown>, _ctx: { id: string; caller: Caller; env: BaseEnv }) => ({
    count: typeof input.initialCount === "number" ? input.initialCount : 0,
    accessCounts: {} as Record<string, number>,
  }),
};

export const StoreCounter = createDurableActor({
  logic: storeCounterLogicWithConnect,
  events: {
    client: ClientEventSchema,
    service: ServiceEventSchema,
  },
  input: InputPropsSchema,
  persisted: true,
});

// ============================================================================
// Worker entrypoint
// ============================================================================

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    return new Response("adapter test worker", { status: 200 });
  },
};
