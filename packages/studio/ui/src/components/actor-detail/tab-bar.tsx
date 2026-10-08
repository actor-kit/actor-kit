import type { InspectResult } from "../../protocol";

export type Tab = "state" | "timeline" | "connections" | "outbox" | "links";

interface TabSpec {
  key: Tab;
  label: string;
  count?: number;
}

/** The tabs in order, with row counts for the list tabs. */
export function tabsFor(inspect: InspectResult, timelineLength: number): TabSpec[] {
  return [
    { key: "state", label: "State" },
    { key: "timeline", label: "Timeline", count: timelineLength },
    { key: "connections", label: "Connections", count: inspect.connections.length },
    { key: "outbox", label: "Outbox", count: inspect.outbox.length },
    { key: "links", label: "Links", count: inspect.activeLinks.length + inspect.linkSubscribers.length },
  ];
}

interface TabBarProps {
  tabs: TabSpec[];
  active: Tab;
  onSelect: (tab: Tab) => void;
}

export function TabBar({ tabs, active, onSelect }: TabBarProps) {
  return (
    <div className="flex gap-1 border-b border-zinc-800 mb-4" data-testid="tab-bar">
      {tabs.map((tab) => (
        <button
          type="button"
          key={tab.key}
          onClick={() => onSelect(tab.key)}
          className={`px-3 py-2 text-sm cursor-pointer border-b-2 ${
            active === tab.key ? "border-sky-400 text-white" : "border-transparent text-zinc-500 hover:text-zinc-300"
          }`}
          data-testid={`tab-${tab.key}`}
        >
          {tab.label}
          {(tab.count ?? 0) > 0 && <span className="ml-1 text-xs text-zinc-500">({tab.count})</span>}
        </button>
      ))}
    </div>
  );
}
