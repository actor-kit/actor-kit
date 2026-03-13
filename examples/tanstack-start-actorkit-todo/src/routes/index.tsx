import { Link, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const listId = crypto.randomUUID();

  return (
    <main className="page-wrap px-4 py-12">
      <section className="island-shell mx-auto flex max-w-3xl flex-col gap-6 rounded-[2rem] px-8 py-10">
        <p className="island-kicker">TanStack Start Example</p>
        <h1 className="display-title text-4xl font-bold tracking-tight text-[var(--sea-ink)] sm:text-6xl">
          Actor-powered todos with type-safe routes.
        </h1>
        <p className="max-w-2xl text-base text-[var(--sea-ink-soft)] sm:text-lg">
          This mirrors the other todo examples, but uses TanStack Start for the
          app shell and route loaders.
        </p>
        <div>
          <Link
            to="/lists/$listId"
            params={{ listId }}
            className="inline-flex"
          >
            <button
              className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-5 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] transition hover:-translate-y-0.5 hover:bg-[rgba(79,184,178,0.24)]"
              type="button"
            >
              New List
            </button>
          </Link>
        </div>
      </section>
    </main>
  );
}
