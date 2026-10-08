import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";

const INPUT_CLASS = "bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm flex-1";

/** Open an actor by type and id, even one the registry does not list yet. */
export function ManualConnect() {
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
          className={INPUT_CLASS}
          data-testid="manual-type"
        />
        <input
          type="text"
          placeholder="Actor ID"
          aria-label="Actor ID"
          value={manualId}
          onChange={(e) => setManualId(e.target.value)}
          className={INPUT_CLASS}
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
