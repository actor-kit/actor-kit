import { createFileRoute, useNavigate } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const navigate = useNavigate();

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <section className="mx-auto flex max-w-lg flex-col items-center gap-6 rounded-3xl bg-white p-10 shadow-sm">
        <p className="text-sm font-medium uppercase tracking-wider text-[var(--sea-ink-soft)]">
          TanStack Start Example
        </p>
        <h1 className="text-center text-4xl font-bold tracking-tight text-[var(--sea-ink)]">
          Actor Kit Chat Room
        </h1>
        <p className="text-center text-base text-[var(--sea-ink-soft)]">
          SSR + client hydration + real-time WebSocket sync, deployed as a single
          Cloudflare Worker with a Durable Object backend.
        </p>
        <button
          className="rounded-full border border-[rgba(26,138,122,0.3)] bg-[rgba(26,138,122,0.1)] px-6 py-3 text-sm font-semibold text-[var(--lagoon-deep)] transition hover:-translate-y-0.5 hover:bg-[rgba(26,138,122,0.2)]"
          onClick={() =>
            navigate({
              to: "/chat/$roomId",
              params: { roomId: crypto.randomUUID() },
            })
          }
          type="button"
        >
          New Chat Room
        </button>
      </section>
    </main>
  );
}
