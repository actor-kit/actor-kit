// Auction actor contract — browser-safe (imports from @actor-kit/worker/testing, no cloudflare:workers).
// Used by both server (SSR loader, DO class) and client (typed React context, typed client).

import { z } from "zod";
import { boolean, nullable, schema, string, uint32, view } from "@actor-kit/core";
import { defineActor, setup } from "@actor-kit/worker/testing";

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
  winner: nullable(string),
});

/** Domain events (ADR-017 §2): what happened, journaled with the transition that emitted them. */
const auction = setup({
  events: {
    BidPlaced: z.object({ bidder: z.string(), amount: z.number() }),
    BidIgnored: z.object({ bidder: z.string(), amount: z.number(), reason: z.literal("too_low") }),
    AuctionClosed: z.object({ winner: z.string(), amount: z.number() }),
  },
});

const highestOf = (state: AuctionState) =>
  state.bids.length > 0 ? Math.max(...state.bids.map((b) => b.amount)) : 0;

export const AuctionContract = defineActor("auction", {
  events: auction.events,

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
    BID: auction.message(z.object({ amount: z.number().int().positive() }), {
      guard: (state: AuctionState) => !state.closed,
      handler: (state: AuctionState, { amount }, { caller, now, emit }) => {
        if (amount <= highestOf(state)) {
          // A lower bid changes nothing, but the journal still records that it was ignored.
          emit("BidIgnored", { bidder: caller, amount, reason: "too_low" });
          return state;
        }
        emit("BidPlaced", { bidder: caller, amount });
        return {
          ...state,
          bids: [...state.bids, { bidder: caller, amount, timestamp: now() }],
        };
      },
    }),
    CLOSE: auction.message(z.object({}), {
      guard: (
        state: AuctionState,
        _payload: Record<string, never>,
        ctx: { role: string },
      ) => ctx.role === "auctioneer" && !state.closed && state.bids.length > 0,
      handler: (state: AuctionState, _payload, { emit }) => {
        const highestBid = state.bids.reduce(
          (best, b) => (b.amount > best.amount ? b : best),
          state.bids[0]!,
        );
        emit("AuctionClosed", { winner: highestBid.bidder, amount: highestBid.amount });
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
    auctioneer: view.shared(AuctionViewSchema, (state: AuctionState) => ({
      item: state.item,
      bidCount: state.bids.length,
      highestBid:
        state.bids.length > 0 ? Math.max(...state.bids.map((b) => b.amount)) : 0,
      closed: state.closed,
      winner: state.winner,
    })),
    bidder: view.shared(AuctionViewSchema, (state: AuctionState) => ({
      item: state.item,
      bidCount: state.bids.length,
      highestBid:
        state.bids.length > 0 ? Math.max(...state.bids.map((b) => b.amount)) : 0,
      closed: state.closed,
      winner: state.winner,
    })),
  },
});

export type AuctionContract = typeof AuctionContract;
