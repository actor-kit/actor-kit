import { Link, useParams, useSearch } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { ConnectionsPanel, LinksPanel } from "../components/actor-detail/inspect-panels";
import { StatusBadge } from "../components/actor-detail/status-badge";
import { type Tab, TabBar, tabsFor } from "../components/actor-detail/tab-bar";
import { TimelinePanel } from "../components/actor-detail/timeline-panel";
import { JsonTree } from "../components/json-tree";
import { OutboxPanel } from "../components/outbox-panel";
import { TimersPanel } from "../components/timers-panel";
import { useStudioWs } from "../hooks/use-studio-ws";
import type { InspectResult, TimelineItem } from "../protocol";
import type { StudioStatus } from "../studio-state";

export function ActorDetailPage() {
  const { actorType, actorId } = useParams({ from: "/actors/$actorType/$actorId" });
  const { entry } = useSearch({ from: "/actors/$actorType/$actorId" });
  // Keyed so switching actors (or the entry to open) starts from a clean slate (tabs, expanded rows).
  return (
    <ActorDetail
      key={`${actorType}\u0000${actorId}\u0000${entry ?? ""}`}
      actorType={actorType}
      actorId={actorId}
      entry={entry ?? null}
    />
  );
}

function ErrorBanner({ error }: { error: string | null }) {
  if (error === null) return null;
  return (
    <p role="alert" className="mb-4 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
      {error}
    </p>
  );
}

function ActorDetail({ actorType, actorId, entry }: { actorType: string; actorId: string; entry: number | null }) {
  const { inspect, timeline, status, error } = useStudioWs(actorType, actorId);

  if (!inspect) return <Waiting status={status} error={error} />;

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6">
        <Link to="/" className="text-zinc-500 hover:text-zinc-300 text-sm">
          &larr; Dashboard
        </Link>
        <h1 className="text-xl font-bold mt-1 break-all" data-testid="actor-title">
          <span className="bg-zinc-800 text-zinc-300 px-2 py-0.5 rounded text-sm mr-2">{actorType}</span>
          {actorId}
        </h1>
        <p className="text-zinc-500 text-sm mt-1">
          Version {inspect.version}
          <StatusBadge status={status} />
        </p>
      </div>
      <ErrorBanner error={error} />
      <ActorTabs actorType={actorType} actorId={actorId} inspect={inspect} timeline={timeline} entry={entry} />
    </div>
  );
}

/** Nothing to show yet: say why (not created yet, still connecting) and offer the way back. */
function Waiting({ status, error }: { status: StudioStatus; error: string | null }) {
  return (
    <div className="max-w-4xl mx-auto">
      <ErrorBanner error={error} />
      {status === "not-found" && (
        <p className="text-zinc-500" data-testid="not-found">
          This actor doesn&apos;t exist yet. Waiting for it to be created...
        </p>
      )}
      {(status === "connecting" || status === "reconnecting") && <p className="text-zinc-500">Connecting...</p>}
      <Link to="/" className="text-sky-400 hover:underline text-sm mt-2 inline-block">
        Back to dashboard
      </Link>
    </div>
  );
}

function ActorTabs({
  actorType,
  actorId,
  inspect,
  timeline,
  entry,
}: {
  actorType: string;
  actorId: string;
  inspect: InspectResult;
  timeline: TimelineItem[];
  /** Open the timeline at this entry (from `?entry=`). */
  entry: number | null;
}) {
  const [activeTab, setActiveTab] = useState<Tab>(entry === null ? "state" : "timeline");
  const [expandedEntry, setExpandedEntry] = useState<number | null>(entry);
  const toggleEntry = (id: number) => setExpandedEntry((current) => (current === id ? null : id));

  // One renderer per tab: only the active one is called.
  const panels: Record<Tab, () => ReactNode> = {
    state: () => (
      <div className="bg-zinc-900 border border-zinc-800 rounded p-4 text-sm overflow-x-auto" data-testid="state-panel">
        <JsonTree data={inspect.state} />
      </div>
    ),
    timeline: () => (
      <TimelinePanel
        actor={{ actorType, actorId }}
        timeline={timeline}
        expandedEntry={expandedEntry}
        onToggle={toggleEntry}
        onOpen={setExpandedEntry}
      />
    ),
    connections: () => <ConnectionsPanel connections={inspect.connections} />,
    outbox: () => <OutboxPanel actorType={actorType} actorId={actorId} outbox={inspect.outbox} />,
    timers: () => <TimersPanel actorType={actorType} actorId={actorId} timers={inspect.timers ?? []} />,
    links: () => <LinksPanel activeLinks={inspect.activeLinks} linkSubscribers={inspect.linkSubscribers} />,
  };

  return (
    <>
      <TabBar tabs={tabsFor(inspect, timeline.length)} active={activeTab} onSelect={setActiveTab} />
      {panels[activeTab]()}
    </>
  );
}
