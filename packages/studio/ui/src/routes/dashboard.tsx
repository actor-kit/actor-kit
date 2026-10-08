import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { type ActorEntry, fetchActors, fetchActorTypes, StudioApiError } from "../api";

/** Rows per dashboard page. One extra row is requested to know whether a next page exists. */
export const PAGE_SIZE = 50;

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 1000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

type ListState =
  | { kind: "loading" }
  | { kind: "loaded"; actors: ActorEntry[]; hasMore: boolean }
  | { kind: "failed"; message: string; unauthorized: boolean };

export function DashboardPage() {
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [types, setTypes] = useState<string[]>([]);
  const [typeFilter, setTypeFilter] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    fetchActorTypes(abort.signal)
      .then(setTypes)
      .catch(() => {
        // The type list is optional: the actor list reports registry errors.
      });
    return () => abort.abort();
  }, []);

  useEffect(() => {
    // Each request owns an AbortController; a newer filter/search/page aborts
    // the older request, so a slow stale response can never overwrite it.
    const abort = new AbortController();
    setList({ kind: "loading" });
    fetchActors(
      {
        type: typeFilter || undefined,
        search: search || undefined,
        limit: PAGE_SIZE + 1,
        offset,
      },
      abort.signal,
    )
      .then((rows) => {
        if (abort.signal.aborted) return;
        setList({ kind: "loaded", actors: rows.slice(0, PAGE_SIZE), hasMore: rows.length > PAGE_SIZE });
      })
      .catch((err: unknown) => {
        if (abort.signal.aborted || isAbort(err)) return;
        setList({
          kind: "failed",
          message: err instanceof Error ? err.message : "Failed to fetch actors",
          unauthorized: err instanceof StudioApiError && (err.kind === "unauthorized" || err.kind === "forbidden"),
        });
      });
    return () => abort.abort();
  }, [typeFilter, search, offset]);

  const actors = list.kind === "loaded" ? list.actors : [];
  const showPager = list.kind === "loaded" && (offset > 0 || list.hasMore);

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Actors</h1>

      {/* Filters */}
      <div className="flex gap-3 mb-4">
        <select
          value={typeFilter}
          onChange={(e) => {
            setTypeFilter(e.target.value);
            setOffset(0);
          }}
          className="bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-sm"
          data-testid="type-filter"
        >
          <option value="">All types</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Search actor ID..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOffset(0);
          }}
          className="bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-sm flex-1"
          data-testid="search-input"
        />
      </div>

      {list.kind === "loading" && <p className="text-zinc-500">Loading...</p>}
      {list.kind === "failed" && (
        <div className="mb-4">
          <p role="alert" className="text-red-400">
            {list.message}
          </p>
          {list.unauthorized && <SignInAgain />}
        </div>
      )}

      {/* Manual connect — always available: the registry is debounced and may
          not list an actor yet, or may be unavailable entirely. */}
      <ManualConnect />

      {list.kind === "loaded" && actors.length === 0 && (
        <div className="text-zinc-500 border border-zinc-800 rounded p-6 text-center mb-6">
          <p>No actors found.</p>
        </div>
      )}

      {actors.length > 0 && (
        <div className="border border-zinc-800 rounded overflow-hidden" data-testid="actor-list">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-zinc-400">
                <th className="text-left px-4 py-2">Type</th>
                <th className="text-left px-4 py-2">Actor ID</th>
                <th className="text-left px-4 py-2">Last Active</th>
                <th className="text-right px-4 py-2">Connections</th>
              </tr>
            </thead>
            <tbody>
              {actors.map((actor) => (
                <tr
                  key={`${actor.actorType}:${actor.actorId}`}
                  className="border-b border-zinc-800/50 hover:bg-zinc-900/50"
                >
                  <td className="px-4 py-2">
                    <span className="bg-zinc-800 text-zinc-300 px-2 py-0.5 rounded text-xs">{actor.actorType}</span>
                  </td>
                  <td className="px-4 py-2 break-all">
                    <Link
                      to="/actors/$actorType/$actorId"
                      params={{ actorType: actor.actorType, actorId: actor.actorId }}
                      className="text-sky-400 hover:text-sky-300 hover:underline"
                      data-testid={`actor-link-${actor.actorId}`}
                    >
                      {actor.actorId}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-zinc-500" title={new Date(actor.lastActiveAt).toISOString()}>
                    {relativeTime(actor.lastActiveAt)}
                  </td>
                  <td className="px-4 py-2 text-right text-zinc-400">{actor.connectionCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showPager && list.kind === "loaded" && (
        <div className="flex items-center gap-3 mt-3 text-sm text-zinc-400">
          <button
            type="button"
            disabled={offset === 0}
            onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
            className="px-2 py-1 rounded bg-zinc-800 disabled:opacity-40 cursor-pointer disabled:cursor-default"
            data-testid="page-prev"
          >
            Previous
          </button>
          <span data-testid="page-info">
            {offset + 1}–{offset + actors.length}
          </span>
          <button
            type="button"
            disabled={!list.hasMore}
            onClick={() => setOffset((o) => o + PAGE_SIZE)}
            className="px-2 py-1 rounded bg-zinc-800 disabled:opacity-40 cursor-pointer disabled:cursor-default"
            data-testid="page-next"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

function ManualConnect() {
  const navigate = useNavigate();
  const [manualType, setManualType] = useState("");
  const [manualId, setManualId] = useState("");
  const actorType = manualType.trim();
  const actorId = manualId.trim();
  const ready = actorType !== "" && actorId !== "";

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    void navigate({ to: "/actors/$actorType/$actorId", params: { actorType, actorId } });
  };

  return (
    <form className="mb-6 max-w-md" onSubmit={onSubmit}>
      <p className="text-zinc-400 text-sm mb-2">Connect manually:</p>
      <div className="flex gap-2">
        <input
          type="text"
          placeholder="Actor type"
          aria-label="Actor type"
          value={manualType}
          onChange={(e) => setManualType(e.target.value)}
          className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm flex-1"
          data-testid="manual-type"
        />
        <input
          type="text"
          placeholder="Actor ID"
          aria-label="Actor ID"
          value={manualId}
          onChange={(e) => setManualId(e.target.value)}
          className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm flex-1"
          data-testid="manual-id"
        />
        <button
          type="submit"
          disabled={!ready}
          className="bg-zinc-700 hover:bg-zinc-600 px-3 py-1 rounded text-sm cursor-pointer disabled:opacity-40 disabled:cursor-default"
          data-testid="manual-connect"
        >
          Connect
        </button>
      </div>
    </form>
  );
}

/** ADR-014: production Studio sits behind Cloudflare Access; a full page load goes through its login. */
function SignInAgain() {
  return (
    <a
      href="/__studio/"
      className="mt-2 inline-block bg-zinc-700 hover:bg-zinc-600 px-3 py-1 rounded text-sm"
      data-testid="studio-sign-in"
    >
      Sign in through Cloudflare Access
    </a>
  );
}
