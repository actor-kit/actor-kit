import type { ReactNode } from "react";
import type { InspectResult } from "../../protocol";
import { recentTime } from "../../relative-time";

const TABLE_CLASS = "w-full text-sm border border-zinc-800 rounded";
const ROW_CLASS = "border-b border-zinc-800/50";
const CELL = "px-4 py-2";

/** A table with left/right aligned headers, or an empty message when there are no rows. */
function Table({
  empty,
  emptyClass,
  headers,
  rows,
}: {
  empty: string;
  emptyClass: string;
  headers: ReadonlyArray<readonly [label: string, align: "text-left" | "text-right"]>;
  rows: ReactNode[];
}) {
  if (rows.length === 0) return <p className={emptyClass}>{empty}</p>;
  return (
    <table className={TABLE_CLASS}>
      <thead>
        <tr className="border-b border-zinc-800 text-zinc-400">
          {headers.map(([label, align]) => (
            <th key={label} className={`${align} ${CELL}`}>
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{rows}</tbody>
    </table>
  );
}

export function ConnectionsPanel({ connections }: { connections: InspectResult["connections"] }) {
  return (
    <div data-testid="connections-panel">
      <Table
        empty="No active connections."
        emptyClass="text-zinc-500"
        headers={[
          ["Caller", "text-left"],
          ["Type", "text-left"],
          ["Role", "text-left"],
          ["Connected", "text-left"],
        ]}
        rows={connections.map((conn) => (
          <tr key={conn.connectionId} className={ROW_CLASS}>
            <td className={`${CELL} font-mono`}>{conn.caller}</td>
            <td className={`${CELL} text-zinc-400`}>{conn.callerType}</td>
            <td className={CELL}>
              {conn.role !== null ? (
                <span className="bg-sky-900/40 text-sky-300 px-1.5 py-0.5 rounded text-xs">{conn.role}</span>
              ) : (
                <span className="text-zinc-600 text-xs">—</span>
              )}
            </td>
            <td className={`${CELL} text-zinc-400`} title={new Date(conn.connectedAt).toISOString()}>
              {recentTime(conn.connectedAt)}
            </td>
          </tr>
        ))}
      />
    </div>
  );
}

/** Text colour per outbox status; the status itself is also shown as text and in data-status. */
const OUTBOX_STATUS_CLASS = new Map([
  ["done", "text-emerald-400"],
  ["failed", "text-red-400"],
  ["pending", "text-amber-400"],
]);

export function OutboxPanel({ outbox }: { outbox: InspectResult["outbox"] }) {
  return (
    <div data-testid="outbox-panel">
      <Table
        empty="No executions."
        emptyClass="text-zinc-500"
        headers={[
          ["Service", "text-left"],
          ["Status", "text-left"],
          ["Attempts", "text-right"],
        ]}
        rows={outbox.map((exec) => (
          <tr key={exec.id} className={ROW_CLASS} data-testid="outbox-row" data-status={exec.status}>
            <td className={CELL}>{exec.service}</td>
            <td className={`${CELL} ${OUTBOX_STATUS_CLASS.get(exec.status) ?? "text-zinc-400"}`}>{exec.status}</td>
            <td className={`${CELL} text-right text-zinc-400`}>{exec.attempts}</td>
          </tr>
        ))}
      />
    </div>
  );
}

export function LinksPanel({ activeLinks, linkSubscribers }: Pick<InspectResult, "activeLinks" | "linkSubscribers">) {
  return (
    <div data-testid="links-panel" className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-zinc-400 mb-2">Linked to</h3>
        <Table
          empty="No active links."
          emptyClass="text-zinc-500 text-sm"
          headers={[
            ["Link", "text-left"],
            ["Target", "text-left"],
            ["Version", "text-right"],
          ]}
          rows={activeLinks.map((link) => (
            <tr
              key={`${link.linkName}:${link.targetType}:${link.targetId}`}
              className={ROW_CLASS}
              data-testid="active-link-row"
            >
              <td className={CELL}>{link.linkName}</td>
              <td className={CELL}>
                {link.targetType}:{link.targetId}
              </td>
              <td className={`${CELL} text-right text-zinc-400`} data-testid="active-link-version">
                {link.version}
              </td>
            </tr>
          ))}
        />
      </div>
      <div>
        <h3 className="text-sm font-semibold text-zinc-400 mb-2">Subscribers</h3>
        <Table
          empty="No subscribers."
          emptyClass="text-zinc-500 text-sm"
          headers={[
            ["Type", "text-left"],
            ["ID", "text-left"],
          ]}
          rows={linkSubscribers.map((sub) => (
            <tr
              key={`${sub.subscriberType}:${sub.subscriberId}`}
              className={ROW_CLASS}
              data-testid="link-subscriber-row"
            >
              <td className={CELL}>{sub.subscriberType}</td>
              <td className={CELL}>{sub.subscriberId}</td>
            </tr>
          ))}
        />
      </div>
    </div>
  );
}
