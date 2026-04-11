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
- Contract-derived client: no manual message unions

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
    // Auctioneer sees all bids with bidder names + revenue
    auctioneer: view.shared(AuctioneerView, (state) => ({
      item: state.item,
      bids: state.bids,
      bidCount: state.bids.length,
      highestBid: Math.max(0, ...state.bids.map(b => b.amount)),
      revenue: state.closed ? state.winningBid : 0,
      closed: state.closed,
      winner: state.winner ?? "",
    })),
    // Bidders see bid count and highest bid — not who bid
    bidder: view.shared(BidderView, (state) => ({
      item: state.item,
      bidCount: state.bids.length,
      highestBid: Math.max(0, ...state.bids.map(b => b.amount)),
      closed: state.closed,
      winner: state.winner ?? "",
    })),
  },
});
export type AuctionContract = typeof AuctionContract;

```

The server file imports the contract value and creates the DO class:

```typescript
// auction.server.ts
import { createActorClass } from "@actor-kit/worker";
import { AuctionContract } from "./auction.contract";

export const Auction = createActorClass(AuctionContract);
```

Key points:
- **BID guard** checks state only: `!state.closed` — any role can bid when open
- **CLOSE guard** checks both state and role: `ctx.role === "auctioneer" && !state.closed && state.bids.length > 0`
- Guards run before the handler. If the guard returns `false`, the framework sends a `guard_failed` error — the handler never executes
- Inside the BID handler, the amount check is business logic (not a guard) — it returns unchanged state instead of throwing

## The Client

### Vanilla TypeScript

Client code uses `import type` to import the contract — this keeps Zod, handlers, and Cloudflare dependencies out of the browser bundle. Binary delta decoding is handled transparently — the `subscribe` callback always receives the full, merged view:

The Worker authenticates via session cookie and stamps identity with `withCallerIdentity()` — the auctioneer role is granted based on `callerType: "service"`, not on URL params.

```typescript
import { actorClient } from "@actor-kit/client";
import type { AuctionContract } from "./auction.contract";

// Type-only — no runtime contract value in the bundle
const AuctionClient = actorClient<AuctionContract>();

// Create a runtime connection — the browser sends the session cookie automatically
const client = AuctionClient.create({
  path: `/api/auction/my-auction`,
  initialView: {
    role: "bidder",
    item: "",
    bidCount: 0,
    highestBid: 0,
    closed: false,
    winner: "",
  }, // or an SSR snapshot
});
client.connect();

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
import { useState } from "react";
import { actorContext } from "@actor-kit/react";
import type { LinkedView } from "@actor-kit/core";
import type { AuctionContract } from "./auction.contract";

type AuctionView = LinkedView<typeof AuctionContract>;

// Type-only — no runtime contract value in the bundle
const AuctionCtx = actorContext<typeof AuctionContract>();

// Server loader: fetch the role-scoped initial snapshot from the DO
export async function loader({ env, params, callerId }: { env: Env; params: { auctionId: string }; callerId: string }) {
  const stub = env.AUCTION.get(env.AUCTION.idFromName(params.auctionId));
  await stub.spawn({
    actorId: params.auctionId,
    caller: "system",
    callerType: "service",
    input: { item: "Vintage poster" },
  });
  const { snapshot, role } = await stub.getSnapshot(callerId, "user");
  return { auctionId: params.auctionId, snapshot, role };
}

function AuctionApp({ auctionId, snapshot, role }: { auctionId: string; snapshot: object; role: string }) {
  // useClient manages connect/disconnect on mount. Cookies supply auth,
  // so no callerId is needed on the client.
  const client = AuctionCtx.useClient({
    path: `/api/auction/${auctionId}`,
    initialView: { role, ...snapshot } as never,
  });

  return (
    <AuctionCtx.Provider client={client}>
      <Auction />
    </AuctionCtx.Provider>
  );
}

function Auction() {
  const view = AuctionCtx.useView();
  // view type is a discriminated union:
  // | { role: "auctioneer"; item; bids; bidCount; highestBid; revenue; closed; winner }
  // | { role: "bidder";     item; bidCount; highestBid; closed; winner }

  // view is always defined — initialView seeds it before the socket opens.

  // Common fields — accessible without narrowing (exist on ALL role variants)
  return (
    <div>
      <h1>{view.item}</h1>
      <div>Highest bid: ${view.highestBid} ({view.bidCount} bids)</div>

      {/* Role-specific UI — narrow with view.role */}
      {view.role === "auctioneer" && <AuctioneerPanel view={view} />}
      {view.role === "bidder" && <BidderPanel view={view} />}
    </div>
  );
}

// TypeScript narrows the view type in each component:

function AuctioneerPanel({ view }: { view: Extract<AuctionView, { role: "auctioneer" }> }) {
  const send = AuctionCtx.useSend();
  // view.bids and view.revenue are available — TS knows this is the auctioneer variant
  return (
    <div>
      <div>Revenue: ${view.revenue}</div>
      <div>{view.bids.length} bids from {new Set(view.bids.map(b => b.bidder)).size} bidders</div>
      {!view.closed && (
        <button onClick={() => send({ type: "CLOSE" })}>Close Auction</button>
      )}
    </div>
  );
}

function BidderPanel({ view }: { view: Extract<AuctionView, { role: "bidder" }> }) {
  const send = AuctionCtx.useSend();
  const [amount, setAmount] = useState(0);
  // view.bids is NOT available here — TS correctly excludes it from the bidder variant
  return view.closed ? (
    <div>Winner: {view.winner}</div>
  ) : (
    <div>
      <input type="number" value={amount} onChange={e => setAmount(+e.target.value)} />
      <button onClick={() => send({ type: "BID", amount })}>Place Bid</button>
    </div>
  );
}
```

**Role narrowing works because every view push includes a `role` discriminant.** Common fields (`item`, `bidCount`, `highestBid`, `closed`, `winner`) are accessible on the union without narrowing. Role-specific fields (`bids`, `revenue`) require narrowing via `view.role`.

You can also use `useSelector` with a role for fine-grained subscriptions:

```tsx
// Only re-renders when revenue changes — and only if you're the auctioneer
const revenue = AuctionCtx.useSelector("auctioneer", (v) => v.revenue);

// Common fields work without a role
const bidCount = AuctionCtx.useSelector((v) => v?.bidCount ?? 0);
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
