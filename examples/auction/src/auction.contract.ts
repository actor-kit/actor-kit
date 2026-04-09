import { z } from "zod";
import { boolean, schema, string, uint32, view } from "@actor-kit/core";
import { defineActor, message } from "@actor-kit/worker";

type Bid = { bidder: string; amount: number; timestamp: number };
type AuctionState = {
  item: string;
  bids: Bid[];
  closed: boolean;
  winner: string | null;
  winningBid: number;
};

const AuctionViewSchema = schema({
  item: string,
  bidCount: uint32,
  highestBid: uint32,
  closed: boolean,
  winner: string,
});

export const AuctionContract = defineActor("auction", {
  input: z.object({ item: z.string() }),
  init: (input: { item: string }): AuctionState => ({
    item: input.item,
    bids: [],
    closed: false,
    winner: null,
    winningBid: 0,
  }),

  roles: {
    auctioneer: (
      _state: AuctionState,
      _caller: string,
      { callerType }: { callerType: "user" | "service" },
    ) => callerType === "service",
    bidder: () => true,
  },

  messages: {
    BID: message(z.object({ amount: z.number().int().positive() }), {
      guard: (state: AuctionState) => !state.closed,
      handler: (state: AuctionState, { amount }, { caller }) => {
        const highestBid =
          state.bids.length > 0 ? Math.max(...state.bids.map((b) => b.amount)) : 0;
        if (amount <= highestBid) return state; // Reject lower bids silently
        return {
          ...state,
          bids: [...state.bids, { bidder: caller, amount, timestamp: Date.now() }],
        };
      },
    }),
    CLOSE: message(z.object({}), {
      guard: (
        state: AuctionState,
        _payload: Record<string, never>,
        ctx: { role: string },
      ) => ctx.role === "auctioneer" && !state.closed && state.bids.length > 0,
      handler: (state: AuctionState) => {
        const highestBid = state.bids.reduce(
          (best, b) => (b.amount > best.amount ? b : best),
          state.bids[0]!,
        );
        return {
          ...state,
          closed: true,
          winner: highestBid.bidder,
          winningBid: highestBid.amount,
        };
      },
    }),
  },

  views: {
    auctioneer: view(AuctionViewSchema, (state: AuctionState) => ({
      item: state.item,
      bidCount: state.bids.length,
      highestBid:
        state.bids.length > 0 ? Math.max(...state.bids.map((b) => b.amount)) : 0,
      closed: state.closed,
      winner: state.winner ?? "",
    })),
    bidder: view(AuctionViewSchema, (state: AuctionState) => ({
      item: state.item,
      bidCount: state.bids.length,
      highestBid:
        state.bids.length > 0 ? Math.max(...state.bids.map((b) => b.amount)) : 0,
      closed: state.closed,
      winner: state.winner ?? "",
    })),
  },
});

export type AuctionContract = typeof AuctionContract;
