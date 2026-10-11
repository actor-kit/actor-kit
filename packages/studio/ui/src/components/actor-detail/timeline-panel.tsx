import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { parseCauseRef } from "../../cause-ref";
import { formatCauseSummary } from "../../cause-summary";
import { phaseChange } from "../../phase-change";
import type { TimelineItem } from "../../protocol";
import { recentTime } from "../../relative-time";
import { JsonDiff } from "../json-diff";
import { JsonTree } from "../json-tree";
import { SCROLL_X, TAP } from "../phone";
import { RestoreButton } from "../restore-button";

const CAUSE_LABELS = new Map<string, { label: string; color: string }>([
  ["init", { label: "init", color: "bg-zinc-600" }],
  ["migrate", { label: "migrate", color: "bg-zinc-600" }],
  ["message", { label: "message", color: "bg-sky-700" }],
  ["lifecycle.connect", { label: "connect", color: "bg-zinc-500" }],
  ["lifecycle.disconnect", { label: "disconnect", color: "bg-zinc-500" }],
  ["service.onDone", { label: "service ok", color: "bg-emerald-700" }],
  ["service.onError", { label: "service err", color: "bg-red-700" }],
  ["service.stale", { label: "service late", color: "bg-amber-800" }],
  ["link.onUpdate", { label: "link update", color: "bg-violet-700" }],
  ["link.onError", { label: "link err", color: "bg-red-700" }],
  ["link.onUnlink", { label: "link unlink", color: "bg-zinc-500" }],
  ["timer", { label: "timer", color: "bg-amber-700" }],
  ["restore", { label: "restore", color: "bg-fuchsia-800" }],
]);

/** The badge for a cause type; unknown types show their own name. */
export function causeLabel(causeType: string): { label: string; color: string } {
  return CAUSE_LABELS.get(causeType) ?? { label: causeType, color: "bg-zinc-700" };
}

/** The actor a timeline belongs to (its entries can restore it). */
interface ActorRef {
  actorType: string;
  actorId: string;
}

interface TimelinePanelProps {
  actor: ActorRef;
  timeline: TimelineItem[];
  expandedEntry: number | null;
  onToggle: (id: number) => void;
  /** Expand one entry (a cause link to this actor's own timeline). */
  onOpen: (id: number) => void;
}

export function TimelinePanel({ actor, timeline, expandedEntry, onToggle, onOpen }: TimelinePanelProps) {
  return (
    <div className="space-y-1" data-testid="timeline-panel">
      {timeline.length === 0 && <p className="text-zinc-500">No timeline entries.</p>}
      {timeline.map((entry, idx) => (
        <TimelineRow
          key={entry.id}
          actor={actor}
          entry={entry}
          // Timeline is newest-first, so the previous state is the next entry.
          previous={timeline[idx + 1]}
          expanded={expandedEntry === entry.id}
          onToggle={() => onToggle(entry.id)}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

interface TimelineRowProps {
  actor: ActorRef;
  entry: TimelineItem;
  previous: TimelineItem | undefined;
  expanded: boolean;
  onToggle: () => void;
  onOpen: (id: number) => void;
}

function TimelineRow({ actor, entry, previous, expanded, onToggle, onOpen }: TimelineRowProps) {
  const cause = causeLabel(entry.causeType);
  return (
    <div className="border border-zinc-800 rounded">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-zinc-900/50 cursor-pointer ${TAP}`}
        data-testid={`timeline-entry-${entry.id}`}
      >
        <span className={`${cause.color} text-white text-xs px-1.5 py-0.5 rounded`}>{cause.label}</span>
        <span className="flex-1 text-zinc-300 break-all">{formatCauseSummary(entry.causeType, entry.cause)}</span>
        {phaseChange(entry, previous) !== null && (
          <span className="text-xs text-fuchsia-300" data-testid={`timeline-phase-${entry.id}`}>
            → {phaseChange(entry, previous)}
          </span>
        )}
        {entry.emitted !== undefined && entry.emitted.length > 0 && (
          <span className="text-xs text-teal-300" data-testid={`timeline-emitted-${entry.id}`}>
            {entry.emitted.map((e) => e.name).join(", ")}
          </span>
        )}
        <NondeterministicBadge entry={entry} />
        <span className="text-zinc-600 text-xs" title={new Date(entry.createdAt).toISOString()}>
          {recentTime(entry.createdAt)}
        </span>
      </button>
      {expanded && <EntryDetails actor={actor} entry={entry} previous={previous} onOpen={onOpen} />}
    </div>
  );
}

/** A handler of this entry read the clock or randomness directly (ADR-018 E): replay cannot reproduce it. */
function NondeterministicBadge({ entry }: { entry: TimelineItem }) {
  if (entry.nondeterministic !== true) return null;
  return (
    <span
      className="text-xs text-amber-300"
      data-testid={`timeline-nondeterministic-${entry.id}`}
      title="A handler read the clock or randomness directly: use ctx.now(), ctx.random() or ctx.id()"
    >
      nondeterministic
    </span>
  );
}

/** The entry emitted domain events (ADR-017 §2). */
function hasEmitted(entry: TimelineItem): boolean {
  return entry.emitted !== undefined && entry.emitted.length > 0;
}

/** Both states could be rebuilt from the journal, so there is something to diff. */
function bothHaveState(previous: TimelineItem, entry: TimelineItem): boolean {
  return previous.stateUnavailable !== true && entry.stateUnavailable !== true;
}

function EntryDetails({
  actor,
  entry,
  previous,
  onOpen,
}: {
  actor: ActorRef;
  entry: TimelineItem;
  previous: TimelineItem | undefined;
  onOpen: (id: number) => void;
}) {
  return (
    <div className="px-3 pb-3 border-t border-zinc-800/50 space-y-2">
      <TraceSection actor={actor} entry={entry} onOpen={onOpen} />
      {entry.seq !== undefined && (
        <div className="pt-2">
          <RestoreButton actorType={actor.actorType} actorId={actor.actorId} seq={entry.seq} />
        </div>
      )}
      {previous !== undefined && bothHaveState(previous, entry) && (
        <Section title="Changes:">
          <JsonDiff before={previous.state} after={entry.state} />
        </Section>
      )}
      <Section title="Cause data:">
        <JsonTree data={entry.cause} />
      </Section>
      {hasEmitted(entry) && (
        <Section title="Emitted:">
          <JsonTree data={entry.emitted} />
        </Section>
      )}
      <Section title="State after:">
        {entry.stateUnavailable === true ? (
          <p className="text-zinc-500">State not available: it could not be rebuilt from the journal.</p>
        ) : (
          <JsonTree data={entry.state} />
        )}
      </Section>
    </div>
  );
}

/** The entry's flow and cause (ADR-017 §4); nothing for entries written before ids. */
function TraceSection({
  actor,
  entry,
  onOpen,
}: {
  actor: ActorRef;
  entry: TimelineItem;
  onOpen: (id: number) => void;
}) {
  const { correlationId, causationId } = entry;
  if (typeof correlationId !== "string") return null;
  return (
    <div className="pt-2 space-y-1 text-xs text-zinc-400">
      <p>
        Flow: <span data-testid="entry-correlation">{correlationId}</span>
      </p>
      {typeof causationId === "string" ? (
        <p>
          Caused by: <CauseLink actor={actor} causationId={causationId} onOpen={onOpen} />
        </p>
      ) : (
        <p>Started this flow</p>
      )}
    </div>
  );
}

/** The causing event: this actor's entry (expanded in place), another actor's timeline, or plain text. */
function CauseLink({
  actor,
  causationId,
  onOpen,
}: {
  actor: ActorRef;
  causationId: string;
  onOpen: (id: number) => void;
}) {
  const ref = parseCauseRef(causationId);
  if (ref === null) return <span data-testid="entry-causation">{causationId}</span>;
  if (ref.actorType === actor.actorType && ref.actorId === actor.actorId) {
    return (
      <button
        type="button"
        onClick={() => onOpen(ref.seq)}
        className={`text-sky-400 hover:underline break-all text-left ${TAP}`}
        data-testid="entry-causation"
      >
        {causationId}
      </button>
    );
  }
  return (
    <Link
      to="/actors/$actorType/$actorId"
      params={{ actorType: ref.actorType, actorId: ref.actorId }}
      search={{ entry: ref.seq }}
      className="text-sky-400 hover:underline"
      data-testid="entry-causation"
    >
      {causationId}
    </Link>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-xs text-zinc-500 mb-1">{title}</p>
      <div className={`bg-zinc-950 rounded p-2 text-xs ${SCROLL_X}`}>{children}</div>
    </div>
  );
}
