import { useState } from "react";
import { postAction } from "../api";

/**
 * "Restore to here" for one timeline entry (ADR-015 D3, mutate scope): asks first, then restores
 * the actor to the entry's journal seq. History is kept: the restore is a new event.
 */
export function RestoreButton({ actorType, actorId, seq }: { actorType: string; actorId: string; seq: number }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const restore = () => {
    setError(null);
    setBusy(true);
    postAction(actorType, actorId, { action: "restore", toSeq: seq })
      .then(() => setConfirming(false))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {confirming ? (
        <>
          <span className="text-amber-300">
            Restore this actor to seq {seq}? A new restore event is added; history is kept.
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={restore}
            className="px-2 py-0.5 rounded border border-amber-700 text-amber-200 hover:bg-amber-950 disabled:opacity-50"
          >
            Confirm restore
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="px-2 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
          >
            Cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="px-2 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
        >
          Restore to here
        </button>
      )}
      {error !== null && (
        <p role="alert" className="w-full rounded border border-red-900 bg-red-950/40 px-2 py-1 text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}
