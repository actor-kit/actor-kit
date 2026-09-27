import { useState } from "react";
import { createFileRoute, useHydrated, useNavigate } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const navigate = useNavigate();
  // Client-side navigation: the button is inert until hydrated, so disable it
  // rather than let pre-hydration clicks silently do nothing.
  const hydrated = useHydrated();
  const [item, setItem] = useState("Widget");

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <section className="mx-auto flex max-w-lg flex-col items-center gap-6 rounded-3xl bg-white p-10 shadow-sm">
        <p className="text-sm font-medium uppercase tracking-wider text-[var(--sea-ink-soft)]">
          TanStack Start Example
        </p>
        <h1 className="text-center text-4xl font-bold tracking-tight text-[var(--sea-ink)]">
          Actor Kit Auction
        </h1>
        <p className="text-center text-base text-[var(--sea-ink-soft)]">
          SSR + client hydration + real-time WebSocket sync, deployed as a single
          Cloudflare Worker with a Durable Object backend.
        </p>
        <div className="flex w-full flex-col gap-3">
          <label
            htmlFor="item-name"
            className="text-sm font-medium text-[var(--sea-ink-soft)]"
          >
            Item Name
          </label>
          <input
            id="item-name"
            type="text"
            value={item}
            onChange={(e) => setItem(e.target.value)}
            placeholder="Enter item name"
            className="w-full rounded-xl border border-gray-200 px-4 py-3 text-base outline-none transition focus:border-[var(--lagoon-deep)] focus:ring-1 focus:ring-[var(--lagoon-deep)]"
          />
        </div>
        <button
          className="rounded-full border border-[rgba(26,138,122,0.3)] bg-[rgba(26,138,122,0.1)] px-6 py-3 text-sm font-semibold text-[var(--lagoon-deep)] transition hover:-translate-y-0.5 hover:bg-[rgba(26,138,122,0.2)]"
          onClick={() =>
            navigate({
              to: "/auction/$auctionId",
              params: { auctionId: crypto.randomUUID() },
              search: { item: item || "Mystery Item" },
            })
          }
          type="button"
          disabled={!hydrated}
        >
          Start Auction
        </button>
      </section>
    </main>
  );
}
