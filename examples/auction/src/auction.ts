import { z } from "zod";
import { array, boolean, schema, string, uint32, view } from "@actor-kit/core";
import { actor, message } from "@actor-kit/worker";

type Bid = { bidder: string; amount: number; timestamp: number };
type AuctionState = {
  item: string;
  bids: Bid[];
  closed: boolean;
  winner: string | null;
  winningBid: number;
};

const BidSchema = schema({ bidder: string, amount: uint32 });
const AuctionViewSchema = schema({
  item: string,
  bidCount: uint32,
  highestBid: uint32,
  closed: boolean,
  winner: string,
});

const placeBid = message(
  z.object({ amount: z.number().int().positive() }),
  {
    // Guard: can only bid if auction is open and bid is higher than current highest
    guard: (state: AuctionState) => !state.closed,
    handler: (state: AuctionState, { amount }, { caller }) => {
      const highestBid = state.bids.length > 0 ? Math.max(...state.bids.map((b) => b.amount)) : 0;
      if (amount <= highestBid) return state; // Reject lower bids silently
      return {
        ...state,
        bids: [...state.bids, { bidder: caller, amount, timestamp: Date.now() }],
      };
    },
  },
);

const closeAuction = message(
  z.object({}),
  {
    guard: (state: AuctionState) => !state.closed && state.bids.length > 0,
    handler: (state: AuctionState) => {
      const highestBid = state.bids.reduce((best, b) => (b.amount > best.amount ? b : best), state.bids[0]!);
      return {
        ...state,
        closed: true,
        winner: highestBid.bidder,
        winningBid: highestBid.amount,
      };
    },
  },
);

export const Auction = actor("auction", {
  input: z.object({ item: z.string() }),
  init: (input: { item: string }): AuctionState => ({
    item: input.item,
    bids: [],
    closed: false,
    winner: null,
    winningBid: 0,
  }),

  roles: {
    auctioneer: (_state: AuctionState, _caller: string, claims: { callerType: "user" | "service" }) =>
      claims.callerType === "service",
    bidder: () => true,
  },

  messages: {
    auctioneer: { BID: placeBid, CLOSE: closeAuction },
    bidder: { BID: placeBid },
  },

  views: {
    auctioneer: view(AuctionViewSchema, (state: AuctionState) => ({
      item: state.item,
      bidCount: state.bids.length,
      highestBid: state.bids.length > 0 ? Math.max(...state.bids.map((b) => b.amount)) : 0,
      closed: state.closed,
      winner: state.winner ?? "",
    })),
    bidder: view(AuctionViewSchema, (state: AuctionState) => ({
      item: state.item,
      bidCount: state.bids.length,
      highestBid: state.bids.length > 0 ? Math.max(...state.bids.map((b) => b.amount)) : 0,
      closed: state.closed,
      winner: state.winner ?? "",
    })),
  },
});
