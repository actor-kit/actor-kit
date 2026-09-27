import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { AuctionContext } from "../auction.context";
import { AuctionDisplay } from "../components/Auction";
import { getActorRuntimeEnv } from "../server-env";

const AuctionRouteInputSchema = z.object({
  auctionId: z.string().min(1),
  item: z.string().min(1),
});

// Parse the DO snapshot at the server function boundary.
const ViewSnapshotSchema = z.object({
  item: z.string(),
  bidCount: z.number(),
  highestBid: z.number(),
  closed: z.boolean(),
  winner: z.string().nullable(),
});

// Server function: fetch initial snapshot from the Durable Object.
// Runs on the Worker — has direct access to DO bindings.
const loadAuction = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => AuctionRouteInputSchema.parse(input))
  .handler(async ({ data }) => {
    const env = getActorRuntimeEnv();
    const auctionId = data.auctionId;
    const item = data.item;

    const doId = env.AUCTION.idFromName(auctionId);
    const stub = env.AUCTION.get(doId);

    // Spawn idempotently with system caller and item input
    await stub.spawn({
      actorId: auctionId,
      caller: "system",
      callerType: "service",
      input: { item },
    });

    // Get snapshot for the demo user — parse at the boundary
    const result = await stub.getSnapshot("demo-user", "user");
    const snapshot = ViewSnapshotSchema.parse(result.snapshot);

    return { auctionId, item, snapshot };
  });

const AuctionSearchSchema = z.object({
  item: z.string().default("Mystery Item"),
});

export const Route = createFileRoute("/auction/$auctionId")({
  validateSearch: (search) => AuctionSearchSchema.parse(search),
  // Loaders don't receive search params directly — declare them as deps.
  loaderDeps: ({ search }) => ({ item: search.item }),
  loader: ({ params, deps }) =>
    loadAuction({ data: { auctionId: params.auctionId, item: deps.item } }),
  component: AuctionRouteComponent,
});

function AuctionRouteComponent() {
  const { auctionId, item, snapshot } = Route.useLoaderData();

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <section className="mx-auto flex w-full max-w-lg flex-col items-center gap-6 rounded-3xl bg-white p-10 shadow-sm">
        <div className="flex w-full items-center justify-between">
          <p className="text-sm font-medium uppercase tracking-wider text-[var(--sea-ink-soft)]">
            Live Auction
          </p>
          <Link
            to="/"
            className="text-sm font-medium text-[var(--lagoon-deep)] hover:underline"
          >
            Home
          </Link>
        </div>
        <AuctionLive auctionId={auctionId} item={item} initialSnapshot={snapshot} />
      </section>
    </main>
  );
}

// Client component: creates a WebSocket client via useClient() and provides it
// through the typed context. The SSR snapshot is the initial view until the
// WebSocket delivers live state.
function AuctionLive({
  auctionId,
  item,
  initialSnapshot,
}: {
  auctionId: string;
  item: string;
  initialSnapshot: {
    item: string;
    bidCount: number;
    highestBid: number;
    closed: boolean;
    winner: string | null;
  };
}) {
  const client = AuctionContext.useClient({
    path: `/api/auction/${auctionId}?item=${encodeURIComponent(item)}`,
    initialView: { role: "bidder", ...initialSnapshot },
  });

  return (
    <AuctionContext.Provider client={client}>
      <AuctionWithHooks />
    </AuctionContext.Provider>
  );
}

// Reads live state from the actor client via typed hooks.
function AuctionWithHooks() {
  const view = AuctionContext.useView();
  const send = AuctionContext.useSend();

  return (
    <AuctionDisplay
      item={view.item}
      bidCount={view.bidCount}
      highestBid={view.highestBid}
      closed={view.closed}
      winner={view.winner}
      onBid={(amount) => send({ type: "BID", amount })}
    />
  );
}
