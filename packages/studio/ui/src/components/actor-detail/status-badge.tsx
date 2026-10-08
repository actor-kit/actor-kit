import type { StudioStatus } from "../../studio-state";

interface Badge {
  label: string;
  className: string;
  title?: string;
  pulse?: boolean;
}

/** What the header shows for each connection status; nothing while first connecting. */
const BADGES: Readonly<Record<StudioStatus, Badge | null>> = {
  connecting: null,
  live: { label: "Live", className: "inline-flex items-center gap-1 text-emerald-400", pulse: true },
  reconnecting: { label: "Reconnecting...", className: "text-amber-400" },
  polling: { label: "Polling", className: "text-amber-400", title: "Live updates unavailable; showing HTTP data" },
  "not-found": { label: "Not found", className: "text-amber-400" },
  error: { label: "Disconnected", className: "text-red-400" },
};

export function StatusBadge({ status }: { status: StudioStatus }) {
  const badge = BADGES[status];
  if (badge === null) return null;
  return (
    <span className={`ml-2 ${badge.className}`} data-testid="status" title={badge.title}>
      {badge.pulse && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />}
      {badge.label}
    </span>
  );
}
