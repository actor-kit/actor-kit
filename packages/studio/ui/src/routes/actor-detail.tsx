import { Link, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { formatCauseSummary } from "../cause-summary";
import { JsonDiff } from "../components/json-diff";
import { JsonTree } from "../components/json-tree";
import { useStudioWs } from "../hooks/use-studio-ws";
import type { TimelineItem } from "../protocol";
import type { StudioStatus } from "../studio-state";

const CAUSE_LABELS: Record<string, { label: string; color: string }> = {
  init: { label: "init", color: "bg-zinc-600" },
  migrate: { label: "migrate", color: "bg-zinc-600" },
  message: { label: "message", color: "bg-sky-700" },
  "lifecycle.connect": { label: "connect", color: "bg-zinc-500" },
  "lifecycle.disconnect": { label: "disconnect", color: "bg-zinc-500" },
  "service.onDone": { label: "service ok", color: "bg-emerald-700" },
  "service.onError": { label: "service err", color: "bg-red-700" },
  "link.onUpdate": { label: "link update", color: "bg-violet-700" },
  "link.onError": { label: "link err", color: "bg-red-700" },
  "link.onUnlink": { label: "link unlink", color: "bg-zinc-500" },
};

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 1000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return new Date(ts).toLocaleTimeString();
}

type Tab = "state" | "timeline" | "connections" | "outbox" | "links";

function StatusBadge({ status }: { status: StudioStatus }) {
  switch (status) {
    case "live":
      return (
        <span className="ml-2 inline-flex items-center gap-1 text-emerald-400" data-testid="status">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          Live
        </span>
      );
    case "reconnecting":
      return (
        <span className="ml-2 text-amber-400" data-testid="status">
          Reconnecting...
        </span>
      );
    case "polling":
      return (
        <span className="ml-2 text-amber-400" data-testid="status" title="Live updates unavailable; showing HTTP data">
          Polling
        </span>
      );
    case "not-found":
      return (
        <span className="ml-2 text-amber-400" data-testid="status">
          Not found
        </span>
      );
    case "error":
      return (
        <span className="ml-2 text-red-400" data-testid="status">
          Disconnected
        </span>
      );
    case "connecting":
      return null;
  }
}

function TimelineRow({
  entry,
  previous,
  expanded,
  onToggle,
}: {
  entry: TimelineItem;
  previous: TimelineItem | undefined;
  expanded: boolean;
  onToggle: () => void;
}) {
  const cause = CAUSE_LABELS[entry.causeType] ?? { label: entry.causeType, color: "bg-zinc-700" };
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
          {relativeTime(entry.createdAt)}
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 border-t border-zinc-800/50 space-y-2">
          {previous !== undefined && (
            <div>
              <p className="text-xs text-zinc-500 mb-1">Changes:</p>
              <div className="bg-zinc-950 rounded p-2 text-xs">
                <JsonDiff before={previous.state} after={entry.state} />
              </div>
            </div>
          )}
          <div>
            <p className="text-xs text-zinc-500 mb-1">Cause data:</p>
            <div className="bg-zinc-950 rounded p-2 text-xs">
              <JsonTree data={entry.cause} />
            </div>
          </div>
          <div>
            <p className="text-xs text-zinc-500 mb-1">State after:</p>
            <div className="bg-zinc-950 rounded p-2 text-xs">
              <JsonTree data={entry.state} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function ActorDetailPage() {
  const { actorType, actorId } = useParams({ from: "/actors/$actorType/$actorId" });
  // Keyed so switching actors starts from a clean slate (tabs, expanded rows).
  return <ActorDetail key={`${actorType}\u0000${actorId}`} actorType={actorType} actorId={actorId} />;
}

function ActorDetail({ actorType, actorId }: { actorType: string; actorId: string }) {
  const { inspect, timeline, status, error } = useStudioWs(actorType, actorId);
  const [activeTab, setActiveTab] = useState<Tab>("state");
  const [expandedEntry, setExpandedEntry] = useState<number | null>(null);

  const errorBanner =
    error === null ? null : (
      <p role="alert" className="mb-4 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
        {error}
      </p>
    );

  if (!inspect) {
    return (
      <div className="max-w-4xl mx-auto">
        {errorBanner}
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

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "state", label: "State" },
    { key: "timeline", label: "Timeline", count: timeline.length },
    { key: "connections", label: "Connections", count: inspect.connections.length },
    { key: "outbox", label: "Outbox", count: inspect.outbox.length },
    { key: "links", label: "Links", count: inspect.activeLinks.length + inspect.linkSubscribers.length },
  ];

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
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

      {errorBanner}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-zinc-800 mb-4" data-testid="tab-bar">
        {tabs.map((tab) => (
          <button
            type="button"
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-3 py-2 text-sm cursor-pointer border-b-2 ${
              activeTab === tab.key
                ? "border-sky-400 text-white"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
            data-testid={`tab-${tab.key}`}
          >
            {tab.label}
            {tab.count !== undefined && tab.count > 0 && (
              <span className="ml-1 text-xs text-zinc-500">({tab.count})</span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "state" && (
        <div
          className="bg-zinc-900 border border-zinc-800 rounded p-4 text-sm overflow-x-auto"
          data-testid="state-panel"
        >
          <JsonTree data={inspect.state} />
        </div>
      )}

      {activeTab === "timeline" && (
        <div className="space-y-1" data-testid="timeline-panel">
          {timeline.length === 0 && <p className="text-zinc-500">No timeline entries.</p>}
          {timeline.map((entry, idx) => (
            <TimelineRow
              key={entry.id}
              entry={entry}
              // Timeline is newest-first, so the previous state is the next entry.
              previous={timeline[idx + 1]}
              expanded={expandedEntry === entry.id}
              onToggle={() => setExpandedEntry(expandedEntry === entry.id ? null : entry.id)}
            />
          ))}
        </div>
      )}

      {activeTab === "connections" && (
        <div data-testid="connections-panel">
          {inspect.connections.length === 0 ? (
            <p className="text-zinc-500">No active connections.</p>
          ) : (
            <table className="w-full text-sm border border-zinc-800 rounded">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-400">
                  <th className="text-left px-4 py-2">Caller</th>
                  <th className="text-left px-4 py-2">Type</th>
                  <th className="text-left px-4 py-2">Role</th>
                  <th className="text-left px-4 py-2">Connected</th>
                </tr>
              </thead>
              <tbody>
                {inspect.connections.map((conn) => (
                  <tr key={conn.connectionId} className="border-b border-zinc-800/50">
                    <td className="px-4 py-2 font-mono">{conn.caller}</td>
                    <td className="px-4 py-2 text-zinc-400">{conn.callerType}</td>
                    <td className="px-4 py-2">
                      {conn.role !== null ? (
                        <span className="bg-sky-900/40 text-sky-300 px-1.5 py-0.5 rounded text-xs">{conn.role}</span>
                      ) : (
                        <span className="text-zinc-600 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-zinc-400" title={new Date(conn.connectedAt).toISOString()}>
                      {relativeTime(conn.connectedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {activeTab === "outbox" && (
        <div data-testid="outbox-panel">
          {inspect.outbox.length === 0 ? (
            <p className="text-zinc-500">No executions.</p>
          ) : (
            <table className="w-full text-sm border border-zinc-800 rounded">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-400">
                  <th className="text-left px-4 py-2">Service</th>
                  <th className="text-left px-4 py-2">Status</th>
                  <th className="text-right px-4 py-2">Attempts</th>
                </tr>
              </thead>
              <tbody>
                {inspect.outbox.map((exec) => {
                  const statusColor =
                    exec.status === "done"
                      ? "text-emerald-400"
                      : exec.status === "failed"
                        ? "text-red-400"
                        : exec.status === "pending"
                          ? "text-amber-400"
                          : "text-zinc-400";
                  return (
                    <tr
                      key={exec.id}
                      className="border-b border-zinc-800/50"
                      data-testid="outbox-row"
                      data-status={exec.status}
                    >
                      <td className="px-4 py-2">{exec.service}</td>
                      <td className={`px-4 py-2 ${statusColor}`}>{exec.status}</td>
                      <td className="px-4 py-2 text-right text-zinc-400">{exec.attempts}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {activeTab === "links" && (
        <div data-testid="links-panel" className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-zinc-400 mb-2">Linked to</h3>
            {inspect.activeLinks.length === 0 ? (
              <p className="text-zinc-500 text-sm">No active links.</p>
            ) : (
              <table className="w-full text-sm border border-zinc-800 rounded">
                <thead>
                  <tr className="border-b border-zinc-800 text-zinc-400">
                    <th className="text-left px-4 py-2">Link</th>
                    <th className="text-left px-4 py-2">Target</th>
                    <th className="text-right px-4 py-2">Version</th>
                  </tr>
                </thead>
                <tbody>
                  {inspect.activeLinks.map((link) => (
                    <tr
                      key={`${link.linkName}:${link.targetType}:${link.targetId}`}
                      className="border-b border-zinc-800/50"
                      data-testid="active-link-row"
                    >
                      <td className="px-4 py-2">{link.linkName}</td>
                      <td className="px-4 py-2">
                        {link.targetType}:{link.targetId}
                      </td>
                      <td className="px-4 py-2 text-right text-zinc-400" data-testid="active-link-version">
                        {link.version}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div>
            <h3 className="text-sm font-semibold text-zinc-400 mb-2">Subscribers</h3>
            {inspect.linkSubscribers.length === 0 ? (
              <p className="text-zinc-500 text-sm">No subscribers.</p>
            ) : (
              <table className="w-full text-sm border border-zinc-800 rounded">
                <thead>
                  <tr className="border-b border-zinc-800 text-zinc-400">
                    <th className="text-left px-4 py-2">Type</th>
                    <th className="text-left px-4 py-2">ID</th>
                  </tr>
                </thead>
                <tbody>
                  {inspect.linkSubscribers.map((sub) => (
                    <tr
                      key={`${sub.subscriberType}:${sub.subscriberId}`}
                      className="border-b border-zinc-800/50"
                      data-testid="link-subscriber-row"
                    >
                      <td className="px-4 py-2">{sub.subscriberType}</td>
                      <td className="px-4 py-2">{sub.subscriberId}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
