import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { CounterContext } from "../counter.context";
import { CounterDisplay } from "../components/Counter";
import { getActorRuntimeEnv } from "../server-env";

const CounterRouteInputSchema = z.object({
  counterId: z.string().min(1),
});

// Parse the DO snapshot at the server function boundary.
const ViewSnapshotSchema = z.object({
  count: z.number(),
  lastUpdatedBy: z.string().nullable(),
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

// Client component: creates a WebSocket client via useClient() and provides it
// through the typed context. The SSR snapshot is the initial view until the
// WebSocket delivers live state.
function CounterLive({
  counterId,
  initialSnapshot,
}: {
  counterId: string;
  initialSnapshot: { count: number; lastUpdatedBy: string | null };
}) {
  // useClient creates the client once (stable across re-renders) and manages
  // connect/disconnect on mount/unmount. initialView seeds the view before the
  // socket opens — no undefined state. Cookie-based auth: caller_id is set by
  // the actor-kit middleware on first request, so no explicit callerId is
  // needed on the client.
  const client = CounterContext.useClient({
    path: `/api/counter/${counterId}`,
    initialView: { role: "user", ...initialSnapshot },
  });

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
  // Disabled until the socket is live: during SSR / pre-hydration a click has
  // no handler, and before connect() a send would be dropped.
  const connectionState = CounterContext.useConnectionState();

  return (
    <CounterDisplay
      count={view.count}
      lastUpdatedBy={view.lastUpdatedBy}
      onIncrement={() => send({ type: "INCREMENT" })}
      onDecrement={() => send({ type: "DECREMENT" })}
      disabled={connectionState !== "connected"}
    />
  );
}
