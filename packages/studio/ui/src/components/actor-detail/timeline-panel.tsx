import type { ReactNode } from "react";
import { formatCauseSummary } from "../../cause-summary";
import type { TimelineItem } from "../../protocol";
import { recentTime } from "../../relative-time";
import { JsonDiff } from "../json-diff";
import { JsonTree } from "../json-tree";

const CAUSE_LABELS = new Map<string, { label: string; color: string }>([
  ["init", { label: "init", color: "bg-zinc-600" }],
  ["migrate", { label: "migrate", color: "bg-zinc-600" }],
  ["message", { label: "message", color: "bg-sky-700" }],
  ["lifecycle.connect", { label: "connect", color: "bg-zinc-500" }],
  ["lifecycle.disconnect", { label: "disconnect", color: "bg-zinc-500" }],
  ["service.onDone", { label: "service ok", color: "bg-emerald-700" }],
  ["service.onError", { label: "service err", color: "bg-red-700" }],
  ["link.onUpdate", { label: "link update", color: "bg-violet-700" }],
  ["link.onError", { label: "link err", color: "bg-red-700" }],
  ["link.onUnlink", { label: "link unlink", color: "bg-zinc-500" }],
]);

/** The badge for a cause type; unknown types show their own name. */
export function causeLabel(causeType: string): { label: string; color: string } {
  return CAUSE_LABELS.get(causeType) ?? { label: causeType, color: "bg-zinc-700" };
}

interface TimelinePanelProps {
  timeline: TimelineItem[];
  expandedEntry: number | null;
  onToggle: (id: number) => void;
}

export function TimelinePanel({ timeline, expandedEntry, onToggle }: TimelinePanelProps) {
  return (
    <div className="space-y-1" data-testid="timeline-panel">
      {timeline.length === 0 && <p className="text-zinc-500">No timeline entries.</p>}
      {timeline.map((entry, idx) => (
        <TimelineRow
          key={entry.id}
          entry={entry}
          // Timeline is newest-first, so the previous state is the next entry.
          previous={timeline[idx + 1]}
          expanded={expandedEntry === entry.id}
          onToggle={() => onToggle(entry.id)}
        />
      ))}
    </div>
  );
}

interface TimelineRowProps {
  entry: TimelineItem;
  previous: TimelineItem | undefined;
  expanded: boolean;
  onToggle: () => void;
}

function TimelineRow({ entry, previous, expanded, onToggle }: TimelineRowProps) {
  const cause = causeLabel(entry.causeType);
  return (
    <div className="border border-zinc-800 rounded">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-zinc-900/50 cursor-pointer"
        data-testid={`timeline-entry-${entry.id}`}
      >
        <span className={`${cause.color} text-white text-xs px-1.5 py-0.5 rounded`}>{cause.label}</span>
        <span className="flex-1 text-zinc-300 break-all">{formatCauseSummary(entry.causeType, entry.cause)}</span>
        <span className="text-zinc-600 text-xs" title={new Date(entry.createdAt).toISOString()}>
          {recentTime(entry.createdAt)}
        </span>
      </button>
      {expanded && <EntryDetails entry={entry} previous={previous} />}
    </div>
  );
}

function EntryDetails({ entry, previous }: { entry: TimelineItem; previous: TimelineItem | undefined }) {
  return (
    <div className="px-3 pb-3 border-t border-zinc-800/50 space-y-2">
      {previous !== undefined && (
        <Section title="Changes:">
          <JsonDiff before={previous.state} after={entry.state} />
        </Section>
      )}
      <Section title="Cause data:">
        <JsonTree data={entry.cause} />
      </Section>
      <Section title="State after:">
        <JsonTree data={entry.state} />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-xs text-zinc-500 mb-1">{title}</p>
      <div className="bg-zinc-950 rounded p-2 text-xs">{children}</div>
    </div>
  );
}
