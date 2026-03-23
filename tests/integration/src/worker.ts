import { z } from "zod";
import { actor } from "../../../packages/actor-kit/src/core/actor";
import { message } from "../../../packages/actor-kit/src/core/message";
import { view } from "../../../packages/actor-kit/src/core/view";
import { schema, string, uint32 } from "../../../packages/actor-kit/src/schema/schema";

// --- Counter actor ---

type CounterState = { count: number; lastCaller: string | null };

const CounterView = schema({ count: uint32, lastCaller: string });

const increment = message(
  z.object({ amount: z.number().int().positive() }),
  (state: CounterState, { amount }, { caller }) => ({
    count: state.count + amount,
    lastCaller: caller,
  }),
);

const decrement = message(
  z.object({ amount: z.number().int().positive() }),
  (state: CounterState, { amount }, { caller }) => ({
    count: state.count - amount,
    lastCaller: caller,
  }),
);

const reset = message(z.object({}), (_state: CounterState) => ({ count: 0, lastCaller: null }));

const notify = message(z.object({}), (state: CounterState, _payload, ctx) => {
  ctx.emit({ queue: "ANALYTICS", body: { count: state.count } });
  return state;
});

export const Counter = actor("counter", {
  binarySync: true,
  input: z.object({}),
  init: () => ({ count: 0, lastCaller: null }),
  roles: {
    admin: (_state: CounterState, _caller: string, { callerType }: { callerType: "user" | "service" }) =>
      callerType === "service",
    user: () => true,
  },
  messages: {
    admin: { INCREMENT: increment, DECREMENT: decrement, RESET: reset, NOTIFY: notify },
    user: { INCREMENT: increment },
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

// --- Timer actor (for testing after/alarm) ---

import { boolean } from "../../../packages/actor-kit/src/schema/schema";

type TimerState = { expired: boolean; count: number };

const TimerView = schema({ expired: boolean, count: uint32 });

const timerIncrement = message(z.object({}), (state: TimerState) => ({
  ...state,
  count: state.count + 1,
}));

export const TimerActor = actor("timer", {
  input: z.object({}),
  init: (): TimerState => ({ expired: false, count: 0 }),
  roles: {
    user: () => true,
  },
  messages: {
    user: { INCREMENT: timerIncrement },
  },
  views: {
    user: view(TimerView, (state: TimerState) => ({
      expired: state.expired,
      count: state.count,
    })),
  },
  after: {
    "1 second": (state: unknown) => ({ ...(state as TimerState), expired: true }),
  },
});

// --- Auction actor (for testing sequential states) ---

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

export const Auction = actor("auction", {
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

// --- Worker entrypoint ---

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response("ok");
    }
    return new Response("Actor Kit v2 test worker", { status: 200 });
  },
};
