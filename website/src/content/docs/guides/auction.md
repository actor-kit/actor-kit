---
title: Auction
description: Guards, competitive bidding, and real-time updates.
---

The auction demonstrates guards — conditions that reject messages before the handler runs.

**Source**: [`examples/auction/`](https://github.com/actor-kit/actor-kit/tree/main/examples/auction)

## What it demonstrates

- Guards on `message()` to enforce business rules
- Competitive real-time bidding between users
- Service-only actions (close auction) via `callerType`
- View projections showing bid counts and highest bid

## Guards

```typescript
const placeBid = message(
  z.object({ amount: z.number().int().positive() }),
  {
    guard: (state) => !state.closed,
    handler: (state, { amount }, { caller }) => {
      const highest = state.bids.length > 0
        ? Math.max(...state.bids.map(b => b.amount))
        : 0;
      if (amount <= highest) return state;  // Reject lower bids
      return {
        ...state,
        bids: [...state.bids, { bidder: caller, amount, timestamp: Date.now() }],
      };
    },
  },
);
```

The guard `(state) => !state.closed` runs before the handler. If the auction is closed, the framework rejects the message with a `guard_failed` error — the handler never executes.

Inside the handler, the bid amount check is business logic (not a guard) — it returns the unchanged state instead of throwing.

## Service-Only Close

```typescript
const closeAuction = message(z.object({}), {
  guard: (state) => !state.closed && state.bids.length > 0,
  handler: (state) => {
    const winner = state.bids.reduce((best, b) =>
      b.amount > best.amount ? b : best, state.bids[0]!
    );
    return { ...state, closed: true, winner: winner.bidder, winningBid: winner.amount };
  },
});

messages: {
  auctioneer: { BID: placeBid, CLOSE: closeAuction },  // service callerType
  bidder: { BID: placeBid },                             // regular users
},
```

Only the `auctioneer` role (determined by `callerType === "service"`) can close the auction.

## Try it

```bash
cd examples/auction
pnpm install
pnpm dev
# Open http://localhost:8787?user=alice
# Open http://localhost:8787?user=bob
# Both bid — highest bid wins
```
