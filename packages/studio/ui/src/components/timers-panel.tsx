import { useEffect, useState } from "react";
import { postAction } from "../api";
import type { TimerEntry } from "../protocol";
import { JsonTree } from "./json-tree";

function dueIn(fireAt: number, now: number): string {
  const seconds = Math.round((fireAt - now) / 1000);
  if (seconds < 0) return "overdue";
  if (seconds < 60) return `in ${seconds}s`;
  if (seconds < 3600) return `in ${Math.round(seconds / 60)}m`;
  return new Date(fireAt).toLocaleString();
}

/** The current time, refreshed every second, so due-in counts down while the panel is open. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * Pending durable timers (ADR-015 D2), soonest first: name, key, due-in and payload (redacted by
 * the actor). An admin can fire one now; the actor runs it exactly as its alarm would.
 */
export function TimersPanel({
  actorType,
  actorId,
  timers,
}: {
  actorType: string;
  actorId: string;
  timers: readonly TimerEntry[];
}) {
  const now = useNow();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const fire = (key: string) => {
    setError(null);
    setBusy(key);
    postAction(actorType, actorId, { action: "fireTimer", key })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(null));
  };

  return (
    <div data-testid="timers-panel">
      {error !== null && (
        <p role="alert" className="mb-2 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}
      {timers.length === 0 ? (
        <p className="text-zinc-500">No pending timers.</p>
      ) : (
        <table className="w-full text-sm border border-zinc-800 rounded">
          <thead>
            <tr className="border-b border-zinc-800 text-zinc-400">
              <th className="text-left px-4 py-2">Timer</th>
              <th className="text-left px-4 py-2">Key</th>
              <th className="text-left px-4 py-2">Due</th>
              <th className="text-left px-4 py-2">Payload</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {timers.map((timer) => (
              <tr key={timer.id} className="border-b border-zinc-800/50 align-top" data-testid="timer-row">
                <td className="px-4 py-2">{timer.name}</td>
                <td className="px-4 py-2 font-mono text-zinc-400">{timer.key}</td>
                <td
                  className="px-4 py-2 text-amber-300"
                  data-testid="timer-due"
                  title={new Date(timer.fireAt).toISOString()}
                >
                  {dueIn(timer.fireAt, now)}
                </td>
                <td className="px-4 py-2 text-xs">
                  <JsonTree data={timer.payload} />
                </td>
                <td className="px-4 py-2 text-right">
                  <button
                    type="button"
                    aria-label={`Fire ${timer.key} now`}
                    disabled={busy === timer.key}
                    onClick={() => fire(timer.key)}
                    className="text-xs px-2 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                  >
                    Fire now
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
