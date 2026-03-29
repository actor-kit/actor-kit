import { boolean, schema, string, uint32, view } from "@actor-kit/core";
import { createActorClass, defineActor, message } from "@actor-kit/worker";
import { z } from "zod";

// --- Counter actor (v3: defineActor + flat messages + guards) ---

type CounterState = { count: number; lastCaller: string | null };

const CounterView = schema({ count: uint32, lastCaller: string });

const increment = message(
  z.object({ amount: z.number().int().positive() }),
  (state: CounterState, { amount }, { caller }) => ({
    count: state.count + amount,
    lastCaller: caller,
  }),
);

const decrement = message(z.object({ amount: z.number().int().positive() }), {
  guard: (_state: CounterState, _payload: { amount: number }, ctx: { role: string }) => ctx.role === "admin",
  handler: (state: CounterState, { amount }, { caller }) => ({
    count: state.count - amount,
    lastCaller: caller,
  }),
});

const reset = message(z.object({}), {
  guard: (_state: CounterState, _payload: Record<string, never>, ctx: { role: string }) => ctx.role === "admin",
  handler: (_state: CounterState) => ({ count: 0, lastCaller: null }),
});

const notify = message(z.object({}), {
  guard: (_state: CounterState, _payload: Record<string, never>, ctx: { role: string }) => ctx.role === "admin",
  handler: (
    state: CounterState,
    _payload: Record<string, never>,
    ctx: { emit: (effect: { queue: string; body: unknown }) => void },
  ) => {
    ctx.emit({ queue: "ANALYTICS", body: { count: state.count } });
    return state;
  },
});

const guardedAdd = message(z.object({ amount: z.number().int().positive() }), {
  guard: (state: CounterState, { amount }: { amount: number }) => state.count + amount <= 100,
  handler: (state: CounterState, { amount }, { caller }) => ({
    ...state,
    count: state.count + amount,
    lastCaller: caller,
  }),
});

const CounterContract = defineActor("counter", {
  input: z.object({}),
  init: (): CounterState => ({ count: 0, lastCaller: null }),
  roles: {
    admin: (_state: CounterState, _caller: string, { callerType }: { callerType: "user" | "service" }) =>
      callerType === "service",
    user: () => true,
  },
  messages: {
    INCREMENT: increment,
    DECREMENT: decrement,
    RESET: reset,
    NOTIFY: notify,
    GUARDED_ADD: guardedAdd,
  },
  views: {
    admin: view(CounterView, (state: CounterState) => ({
      count: state.count,
      lastCaller: state.lastCaller ?? "",
    })),
    user: view(CounterView, (state: CounterState) => ({
      count: state.count,
      lastCaller: state.lastCaller ?? "",
    })),
  },
});

export const Counter = createActorClass(CounterContract);

// --- Timer actor (v3: defineActor + flat messages, after/tick) ---

type TimerState = { expired: boolean; count: number };

const TimerView = schema({ expired: boolean, count: uint32 });

const timerIncrement = message(z.object({}), (state: TimerState) => ({
  ...state,
  count: state.count + 1,
}));

const TimerContract = defineActor("timer", {
  input: z.object({}),
  init: (): TimerState => ({ expired: false, count: 0 }),
  roles: {
    user: () => true,
  },
  messages: {
    INCREMENT: timerIncrement,
  },
  views: {
    user: view(TimerView, (state: TimerState) => ({
      expired: state.expired,
      count: state.count,
    })),
  },
  after: {
    "1 second": (state: TimerState) => ({ ...state, expired: true }),
  },
  tick: {
    frequency: 50,
    handler: (state: TimerState) => ({
      ...state,
      count: state.count + 1,
    }),
  },
});

export const TimerActor = createActorClass(TimerContract);

// --- Auction actor (v3: defineActor + sequential states) ---

type AuctionState = { bids: number[]; winner: number | null };

const AuctionView = schema({ bidCount: uint32 });

const bid = message(z.object({ amount: z.number() }), (state: AuctionState, { amount }) => ({
  ...state,
  bids: [...state.bids, amount],
}));

const closeAuction = message(z.object({}), (state: AuctionState) => ({
  ...state,
  winner: Math.max(...state.bids, 0),
}));

const AuctionContract = defineActor("auction", {
  input: z.object({}),
  initial: "bidding",
  init: (): AuctionState => ({ bids: [], winner: null }),
  roles: {
    user: () => true,
  },
  states: {
    bidding: {
      messages: {
        user: { BID: bid, CLOSE: closeAuction },
      },
    },
    closed: {
      messages: {
        user: {},
      },
    },
  },
  views: {
    user: view(AuctionView, (state: AuctionState) => ({
      bidCount: state.bids.length,
    })),
  },
});

export const Auction = createActorClass(AuctionContract);

// --- Worker entrypoint ---

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response("ok");
    }
    return new Response("Actor Kit v3 test worker", { status: 200 });
  },
};
