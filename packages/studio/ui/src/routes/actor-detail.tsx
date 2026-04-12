import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { type InspectResult, type TimelineEntry, fetchInspect, fetchTimeline } from "../api";
import { JsonTree } from "../components/json-tree";

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

function formatCauseSummary(entry: TimelineEntry): string {
  const data = JSON.parse(entry.causeData) as Record<string, unknown>;
  switch (entry.causeType) {
    case "message":
      return `${data["caller"]} sent ${data["messageType"]}`;
    case "lifecycle.connect":
      return `${data["caller"]} connected (${data["role"]})`;
    case "lifecycle.disconnect":
      return `${data["caller"]} disconnected`;
    case "service.onDone":
      return `${data["service"]} completed`;
    case "service.onError":
      return `${data["service"]} failed: ${data["error"]}`;
    case "link.onUpdate":
      return `${data["sourceType"]}:${data["sourceId"]} updated`;
    case "init":
      return "Actor initialized";
    default:
      return entry.causeType;
  }
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 1000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return new Date(ts).toLocaleTimeString();
}

type Tab = "state" | "timeline" | "connections" | "outbox" | "links";

export function ActorDetailPage() {
  const { actorType, actorId } = useParams({ from: "/actors/$actorType/$actorId" });
  const [inspect, setInspect] = useState<InspectResult | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>("state");
  const [expandedEntry, setExpandedEntry] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    Promise.all([fetchInspect(actorType, actorId), fetchTimeline(actorType, actorId)])
      .then(([inspectResult, timelineResult]) => {
        setInspect(inspectResult);
        setTimeline(timelineResult.entries);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load actor");
      });
  }, [actorType, actorId]);

  if (error) {
    return (
      <div className="max-w-4xl mx-auto">
        <p className="text-red-400">{error}</p>
        <Link to="/" className="text-sky-400 hover:underline text-sm mt-2 inline-block">
          Back to dashboard
        </Link>
      </div>
    );
  }

  if (!inspect) {
    return <p className="text-zinc-500">Loading...</p>;
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
        <h1 className="text-xl font-bold mt-1" data-testid="actor-title">
          <span className="bg-zinc-800 text-zinc-300 px-2 py-0.5 rounded text-sm mr-2">{actorType}</span>
          {actorId}
        </h1>
        <p className="text-zinc-500 text-sm mt-1">Version {inspect.version}</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-zinc-800 mb-4" data-testid="tab-bar">
        {tabs.map((tab) => (
          <button
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
        <div className="bg-zinc-900 border border-zinc-800 rounded p-4 text-sm" data-testid="state-panel">
          <JsonTree data={inspect.state} />
        </div>
      )}

      {activeTab === "timeline" && (
        <div className="space-y-1" data-testid="timeline-panel">
          {timeline.length === 0 && <p className="text-zinc-500">No timeline entries.</p>}
          {timeline.map((entry) => {
            const cause = CAUSE_LABELS[entry.causeType] ?? { label: entry.causeType, color: "bg-zinc-700" };
            const isExpanded = expandedEntry === entry.id;
            return (
              <div key={entry.id} className="border border-zinc-800 rounded">
                <button
                  onClick={() => setExpandedEntry(isExpanded ? null : entry.id)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-zinc-900/50 cursor-pointer"
                  data-testid={`timeline-entry-${entry.id}`}
                >
                  <span className={`${cause.color} text-white text-xs px-1.5 py-0.5 rounded`}>{cause.label}</span>
                  <span className="flex-1 text-zinc-300">{formatCauseSummary(entry)}</span>
                  <span className="text-zinc-600 text-xs">{relativeTime(entry.createdAt)}</span>
                </button>
                {isExpanded && (
                  <div className="px-3 pb-3 border-t border-zinc-800/50 space-y-2">
                    <div>
                      <p className="text-xs text-zinc-500 mb-1">Cause data:</p>
                      <div className="bg-zinc-950 rounded p-2 text-xs">
                        <JsonTree data={JSON.parse(entry.causeData)} />
                      </div>
                    </div>
                    <div>
                      <p className="text-xs text-zinc-500 mb-1">State after:</p>
                      <div className="bg-zinc-950 rounded p-2 text-xs">
                        <JsonTree data={JSON.parse(entry.stateSnapshot)} />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
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
                </tr>
              </thead>
              <tbody>
                {inspect.connections.map((conn, i) => (
                  <tr key={i} className="border-b border-zinc-800/50">
                    <td className="px-4 py-2">{conn.caller}</td>
                    <td className="px-4 py-2 text-zinc-400">{conn.callerType}</td>
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
                    <tr key={exec.id} className="border-b border-zinc-800/50">
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
                  {inspect.activeLinks.map((link, i) => (
                    <tr key={i} className="border-b border-zinc-800/50">
                      <td className="px-4 py-2">{link.linkName}</td>
                      <td className="px-4 py-2">
                        {link.targetType}:{link.targetId}
                      </td>
                      <td className="px-4 py-2 text-right text-zinc-400">{link.version}</td>
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
                  {inspect.linkSubscribers.map((sub, i) => (
                    <tr key={i} className="border-b border-zinc-800/50">
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
