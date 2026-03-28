---
title: Auction
description: Guards, competitive bidding, and real-time updates.
---

The auction demonstrates guards — conditions that reject messages before the handler runs.

**Source**: [`examples/auction/`](https://github.com/actor-kit/actor-kit/tree/main/examples/auction)

## What it demonstrates

- Guards on `message()` to enforce business rules
- Guards checking both state and `ctx.role` for authorization
- Competitive real-time bidding between users
- Service-only actions (close auction) via `callerType` role
- Contract-derived client: no manual event unions

## Guards

```typescript
export const AuctionContract = defineActor("auction", {
  input: z.object({ item: z.string() }),
  init: (input) => ({
    item: input.item, bids: [], closed: false, winner: null, winningBid: 0,
  }),

  roles: {
    auctioneer: (_state, _caller, { callerType }) => callerType === "service",
    bidder: () => true,
  },

  messages: {
    BID: message(z.object({ amount: z.number().int().positive() }), {
      guard: (state) => !state.closed,
      handler: (state, { amount }, { caller }) => {
        const highest = state.bids.length > 0
          ? Math.max(...state.bids.map(b => b.amount))
          : 0;
        if (amount <= highest) return state;  // Reject lower bids silently
        return {
          ...state,
          bids: [...state.bids, { bidder: caller, amount, timestamp: Date.now() }],
        };
      },
    }),
    CLOSE: message(z.object({}), {
      guard: (state, _payload, ctx) =>
        ctx.role === "auctioneer" && !state.closed && state.bids.length > 0,
      handler: (state) => {
        const winner = state.bids.reduce((best, b) =>
          b.amount > best.amount ? b : best, state.bids[0]!
        );
        return { ...state, closed: true, winner: winner.bidder, winningBid: winner.amount };
      },
    }),
  },

  views: {
    auctioneer: view(AuctionViewSchema, (state) => ({ ... })),
    bidder: view(AuctionViewSchema, (state) => ({ ... })),
  },
});

export const Auction = createActorClass(AuctionContract);
```

Key points:
- **BID guard** checks state only: `!state.closed` — any role can bid when open
- **CLOSE guard** checks both state and role: `ctx.role === "auctioneer" && !state.closed && state.bids.length > 0`
- Guards run before the handler. If the guard returns `false`, the framework sends a `guard_failed` error — the handler never executes
- Inside the BID handler, the amount check is business logic (not a guard) — it returns unchanged state instead of throwing

## The Client

### Vanilla TypeScript

Use `actorClient(contract)` for typed views and events. Binary delta decoding is handled transparently — the `subscribe` callback always receives the full, merged view:

```typescript
import { actorClient } from "actor-kit/client";
import { AuctionContract } from "./auction";

// Events and views inferred from the contract
const AuctionClient = actorClient(AuctionContract);

// Get a token
const { token } = await fetch("/api/token?actorId=my-auction").then(r => r.json());

// Create a runtime connection
const client = AuctionClient.create({
  url: `ws://localhost:8787/api/auction/my-auction`,
  accessToken: token,
});

// view is typed from the contract's view schemas
client.subscribe((view) => {
  document.getElementById("highest")!.textContent = String(view.highestBid);
  document.getElementById("count")!.textContent = `${view.bidCount} bids`;

  if (view.closed) {
    document.getElementById("bid-form")!.hidden = true;
    document.getElementById("winner")!.textContent = `Winner: ${view.winner}`;
  }
});

client.send({ type: "BID", amount: 100 });
```

### React

```tsx
import { useState, useEffect } from "react";
import { actorClient } from "actor-kit/client";
import { actorContext } from "actor-kit/react";
import { AuctionContract } from "./auction";

const AuctionClient = actorClient(AuctionContract);
const AuctionCtx = actorContext(AuctionContract);

function AuctionApp({ auctionId, token }: { auctionId: string; token: string }) {
  const [client, setClient] = useState<ReturnType<typeof AuctionClient.create> | null>(null);

  useEffect(() => {
    const c = AuctionClient.create({
      url: `wss://${location.host}/api/auction/${encodeURIComponent(auctionId)}`,
      accessToken: token,
    });
    setClient(c);
    return () => c.disconnect();
  }, [auctionId, token]);

  if (!client) return null;

  return (
    <AuctionCtx.Provider client={client}>
      <Auction />
    </AuctionCtx.Provider>
  );
}

function Auction() {
  const view = AuctionCtx.useView();   // typed from contract view schemas
  const send = AuctionCtx.useSend();   // event types inferred from contract
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
