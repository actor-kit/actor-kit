import { Link } from "@tanstack/react-router";
import type { ActorEntry } from "../../api";
import { relativeTime } from "../../relative-time";
import { SCROLL_X } from "../phone";

export function ActorTable({ actors }: { actors: ActorEntry[] }) {
  return (
    <div className={`border border-zinc-800 rounded ${SCROLL_X}`} data-testid="actor-list">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-zinc-400">
            <th className="text-left px-4 py-2">Type</th>
            <th className="text-left px-4 py-2">Actor ID</th>
            <th className="text-left px-4 py-2 whitespace-nowrap">Last Active</th>
            <th className="text-right px-4 py-2">Connections</th>
          </tr>
        </thead>
        <tbody>
          {actors.map((actor) => (
            <ActorRow key={`${actor.actorType}:${actor.actorId}`} actor={actor} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActorRow({ actor }: { actor: ActorEntry }) {
  return (
    <tr className="border-b border-zinc-800/50 hover:bg-zinc-900/50">
      <td className="px-4 py-2">
        <span className="bg-zinc-800 text-zinc-300 px-2 py-0.5 rounded text-xs">{actor.actorType}</span>
      </td>
      <td className="px-4 py-2 min-w-48 break-all">
        <Link
          to="/actors/$actorType/$actorId"
          params={{ actorType: actor.actorType, actorId: actor.actorId }}
          className="text-sky-400 hover:text-sky-300 hover:underline"
          data-testid={`actor-link-${actor.actorId}`}
        >
          {actor.actorId}
        </Link>
      </td>
      <td className="px-4 py-2 text-zinc-500 whitespace-nowrap" title={new Date(actor.lastActiveAt).toISOString()}>
        {relativeTime(actor.lastActiveAt)}
      </td>
      <td className="px-4 py-2 text-right text-zinc-400">{actor.connectionCount}</td>
    </tr>
  );
}
