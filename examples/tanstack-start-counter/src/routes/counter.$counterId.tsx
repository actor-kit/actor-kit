import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { actorClient } from "@actor-kit/client";
import type { ActorClient, ContractEvents, ContractView } from "@actor-kit/client";
import { CounterContract } from "../counter";
import { CounterContext } from "../counter.context";
import { CounterDisplay } from "../components/Counter";
import { getActorRuntimeEnv } from "../server-env";
import { useEffect, useState, useSyncExternalStore } from "react";

type CounterView = ContractView<typeof CounterContract>;
type CounterEvent = ContractEvents<typeof CounterContract>;

const CounterRouteInputSchema = z.object({
  counterId: z.string().min(1),
});

// Parse the DO snapshot at the server function boundary.
const ViewSnapshotSchema = z.object({
  count: z.number(),
  lastUpdatedBy: z.string(),
});

// Server function: fetch initial snapshot from the Durable Object.
// Runs on the Worker — has direct access to DO bindings.
const loadCounter = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => CounterRouteInputSchema.parse(input))
  .handler(async ({ data }) => {
    const env = getActorRuntimeEnv();
    const counterId = data.counterId;

    const doId = env.COUNTER.idFromName(counterId);
    const stub = env.COUNTER.get(doId);

    // Spawn idempotently with system caller
    await stub.spawn({
      actorId: counterId,
      caller: "system",
      callerType: "service",
      input: {},
    });

    // Get snapshot for the demo user — parse at the boundary
    const result = await stub.getSnapshot("demo-user", "user");
    const snapshot = ViewSnapshotSchema.parse(result.snapshot);

    return { counterId, snapshot };
  });

export const Route = createFileRoute("/counter/$counterId")({
  loader: ({ params }) => loadCounter({ data: params }),
  component: CounterRouteComponent,
});

function CounterRouteComponent() {
  const { counterId, snapshot } = Route.useLoaderData();

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <section className="mx-auto flex w-full max-w-lg flex-col items-center gap-6 rounded-3xl bg-white p-10 shadow-sm">
        <div className="flex w-full items-center justify-between">
          <p className="text-sm font-medium uppercase tracking-wider text-[var(--sea-ink-soft)]">
            Live Counter
          </p>
          <Link
            to="/"
            className="text-sm font-medium text-[var(--lagoon-deep)] hover:underline"
          >
            Home
          </Link>
        </div>
        <CounterLive counterId={counterId} initialSnapshot={snapshot} />
      </section>
    </main>
  );
}

// Client component: creates a WebSocket client and provides it via React context.
// Falls back to SSR'd snapshot until the WebSocket connection delivers live state.
function CounterLive({
  counterId,
  initialSnapshot,
}: {
  counterId: string;
  initialSnapshot: { count: number; lastUpdatedBy: string };
}) {
  const isHydrated = useHydrated();
  const [client, setClient] = useState<ActorClient<CounterView, CounterEvent> | null>(null);

  useEffect(() => {
    // PRODUCTION: use authenticated callerId from session cookie/OAuth.
    // This demo generates a random ID — NOT safe for production.
    const callerId = `user-${crypto.randomUUID().slice(0, 8)}`;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${location.host}/api/counter/${counterId}?callerId=${encodeURIComponent(callerId)}`;

    const CounterClientFactory = actorClient(CounterContract);
    const c = CounterClientFactory.create({ url });
    setClient(c);

    return () => {
      c.disconnect();
      setClient(null);
    };
  }, [counterId]);

  if (!isHydrated || !client) {
    // SSR or pre-connection: show the server-fetched snapshot
    return (
      <CounterDisplay
        count={initialSnapshot.count}
        lastUpdatedBy={initialSnapshot.lastUpdatedBy}
        onIncrement={() => {}}
        onDecrement={() => {}}
        disabled
      />
    );
  }

  return (
    <CounterContext.Provider client={client}>
      <CounterWithHooks />
    </CounterContext.Provider>
  );
}

// Reads live state from the actor client via typed hooks.
function CounterWithHooks() {
  const view = CounterContext.useView();
  const send = CounterContext.useSend();

  return (
    <CounterDisplay
      count={view?.count ?? 0}
      lastUpdatedBy={view?.lastUpdatedBy ?? ""}
      onIncrement={() => send({ type: "INCREMENT" })}
      onDecrement={() => send({ type: "DECREMENT" })}
      disabled={view === undefined}
    />
  );
}

function useHydrated() {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}
