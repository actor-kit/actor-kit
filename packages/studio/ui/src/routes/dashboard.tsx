import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { type ActorEntry, fetchActorTypes, fetchActors } from "../api";

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 1000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function DashboardPage() {
  const [actors, setActors] = useState<ActorEntry[]>([]);
  const [types, setTypes] = useState<string[]>([]);
  const [typeFilter, setTypeFilter] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Manual connect mode (when registry is unavailable)
  const [manualType, setManualType] = useState("");
  const [manualId, setManualId] = useState("");

  useEffect(() => {
    fetchActorTypes()
      .then(setTypes)
      .catch(() => {
        /* registry may not be available */
      });
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchActors({
      type: typeFilter || undefined,
      search: search || undefined,
    })
      .then((result) => {
        setActors(result);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to fetch actors");
        setLoading(false);
      });
  }, [typeFilter, search]);

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Actors</h1>

      {/* Filters */}
      <div className="flex gap-3 mb-4">
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
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
          onChange={(e) => setSearch(e.target.value)}
          className="bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-sm flex-1"
          data-testid="search-input"
        />
      </div>

      {/* Actor list */}
      {loading && <p className="text-zinc-500">Loading...</p>}
      {error && <p className="text-red-400">{error}</p>}

      {/* Manual connect — always available: the registry is debounced and may
          not list an actor yet, or may be unavailable entirely. */}
      {!loading && (
        <div className="mb-6 max-w-md">
          <p className="text-zinc-400 text-sm mb-2">Connect manually:</p>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Actor type"
              value={manualType}
              onChange={(e) => setManualType(e.target.value)}
              className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm flex-1"
              data-testid="manual-type"
            />
            <input
              type="text"
              placeholder="Actor ID"
              value={manualId}
              onChange={(e) => setManualId(e.target.value)}
              className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm flex-1"
              data-testid="manual-id"
            />
            <Link
              to="/actors/$actorType/$actorId"
              params={{ actorType: manualType, actorId: manualId }}
              className="bg-zinc-700 hover:bg-zinc-600 px-3 py-1 rounded text-sm"
              data-testid="manual-connect"
            >
              Connect
            </Link>
          </div>
        </div>
      )}

      {!loading && actors.length === 0 && (
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
                    <span className="bg-zinc-800 text-zinc-300 px-2 py-0.5 rounded text-xs">
                      {actor.actorType}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <Link
                      to="/actors/$actorType/$actorId"
                      params={{ actorType: actor.actorType, actorId: actor.actorId }}
                      className="text-sky-400 hover:text-sky-300 hover:underline"
                      data-testid={`actor-link-${actor.actorId}`}
                    >
                      {actor.actorId}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-zinc-500">{relativeTime(actor.lastActiveAt)}</td>
                  <td className="px-4 py-2 text-right text-zinc-400">{actor.connectionCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
