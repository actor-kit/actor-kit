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
- Client state-based UI: adapting when the auction closes

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

## The Client

The client renders bid status and adapts when the auction closes:

```javascript
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === "snapshot") {
    const { highestBid, bidCount, closed, winner } = msg.data;

    document.getElementById("highest").textContent = highestBid;
    document.getElementById("count").textContent = `${bidCount} bids`;

    if (closed) {
      document.getElementById("bid-form").hidden = true;
      document.getElementById("winner").textContent = `Winner: ${winner}`;
    }
  }
});

// Place a bid
ws.send(JSON.stringify({ type: "BID", amount: 100 }));
```

### With React

```tsx
import { actorClient } from "@actor-kit/client";
import { actorContext } from "@actor-kit/react";

const AuctionClient = actorClient(AuctionViewSchema).events<AuctionEvent>();
const AuctionCtx = actorContext<typeof AuctionClient>();

function Auction() {
  const view = AuctionCtx.useView();   // typed from AuctionViewSchema
  const send = AuctionCtx.useSend();   // (event: AuctionEvent) => void
  const [amount, setAmount] = useState(0);

  if (!view) return <div>Loading...</div>;

  return (
    <div>
      <div>Highest bid: ${view.highestBid} ({view.bidCount} bids)</div>
      {view.closed ? (
        <div>Winner: {view.winner}</div>
      ) : (
        <div>
          <input type="number" value={amount} onChange={e => setAmount(+e.target.value)} />
          <button onClick={() => send({ type: "BID", amount })}>Place Bid</button>
        </div>
      )}
    </div>
  );
}
```

When the auction closes (via the `auctioneer` service role), all connected clients receive the updated view with `closed: true` and the winner — the UI adapts automatically.

## Try it

```bash
cd examples/auction
pnpm install
pnpm dev
# Open http://localhost:8787?user=alice
# Open http://localhost:8787?user=bob
# Both bid — highest bid wins
```

## Related

- [Messages & Guards](/concepts/messages-and-guards/) — how guards validate messages before the handler runs
- [Testing](/concepts/testing/) — test actors with `testActor()` to verify guard and handler behavior
