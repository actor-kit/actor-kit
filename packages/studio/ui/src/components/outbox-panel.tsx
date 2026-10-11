import { useState } from "react";
import { postAction } from "../api";
import type { OutboxEntry } from "../protocol";
import { SCROLL_X, TAP } from "./phone";

const STATUS_COLORS: Record<string, string> = {
  done: "text-emerald-400",
  failed: "text-red-400",
  pending: "text-amber-400",
  running: "text-sky-400",
  retrying: "text-amber-300",
  cancelled: "text-zinc-500",
};

function dueIn(at: number): string {
  const seconds = Math.max(0, Math.round((at - Date.now()) / 1000));
  if (seconds < 60) return `in ${seconds}s`;
  if (seconds < 3600) return `in ${Math.round(seconds / 60)}m`;
  return new Date(at).toLocaleTimeString();
}

/** A service name, or for a forward the link it goes through and its target. */
function EffectName({ entry }: { entry: OutboxEntry }) {
  if (entry.kind !== "forward") return <>{entry.service}</>;
  return <span data-testid="outbox-forward">{`forward → ${entry.service} / ${entry.target}`}</span>;
}

/**
 * Executions and forwards, newest effect first (ADR-015 D1): effect id, status, tries, when a
 * `retrying` row tries next and its last error. Failed rows are dead letters; an admin can redrive
 * them. A forward shows the link it goes through and its target.
 */
export function OutboxPanel({
  actorType,
  actorId,
  outbox,
}: {
  actorType: string;
  actorId: string;
  outbox: readonly OutboxEntry[];
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const redrive = (effectId: string) => {
    setError(null);
    setBusy(effectId);
    postAction(actorType, actorId, { action: "redrive", effectId })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(null));
  };

  return (
    <div data-testid="outbox-panel">
      {error !== null && (
        <p role="alert" className="mb-2 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}
      {outbox.length === 0 ? (
        <p className="text-zinc-500">No executions.</p>
      ) : (
        <div className={SCROLL_X}>
          <table className="w-full text-sm border border-zinc-800 rounded">
            <thead>
              <tr className="border-b border-zinc-800 text-zinc-400">
                <th className="text-left px-4 py-2">Effect</th>
                <th className="text-left px-4 py-2">Service</th>
                <th className="text-left px-4 py-2">Status</th>
                <th className="text-right px-4 py-2">Attempts</th>
                <th className="text-left px-4 py-2">Last error</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {outbox.map((exec) => (
                <tr
                  key={exec.id}
                  className="border-b border-zinc-800/50"
                  data-testid="outbox-row"
                  data-status={exec.status}
                >
                  <td className="px-4 py-2 font-mono text-zinc-500">{exec.id}</td>
                  <td className="px-4 py-2">
                    <EffectName entry={exec} />
                  </td>
                  <td className={`px-4 py-2 ${STATUS_COLORS[exec.status] ?? "text-zinc-400"}`}>
                    {exec.status}
                    {exec.status === "retrying" && typeof exec.nextAttemptAt === "number" && (
                      <span className="ml-1 text-zinc-500" data-testid="outbox-next-try">
                        ({dueIn(exec.nextAttemptAt)})
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right text-zinc-400">{exec.attempts}</td>
                  <td className="px-4 py-2 min-w-48 text-zinc-500 break-all">
                    {exec.lastErrorTag !== undefined && (
                      <span
                        data-testid="outbox-error-tag"
                        className="mr-1 rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-red-300"
                      >
                        {exec.lastErrorTag}
                      </span>
                    )}
                    {exec.lastError ?? ""}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {exec.status === "failed" && (
                      <button
                        type="button"
                        aria-label={`Redrive ${exec.id}`}
                        disabled={busy === exec.id}
                        onClick={() => redrive(exec.id)}
                        className={`text-xs px-2 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50 ${TAP}`}
                      >
                        Redrive
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
