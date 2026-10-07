/**
 * Live app connections — derived from the sockets the Durable Object holds
 * right now (`ctx.getWebSockets()`), not from a persisted table.
 *
 * The socket list survives hibernation and is emptied by a restart, so it is
 * the only source that is exact in both cases. Each app socket carries its
 * caller in its tags and `{ connectionId, connectedAt }` in its attachment;
 * both are parsed here at the storage boundary.
 */

import { z } from "zod";
import { type RolePredicate, resolveRole } from "./roles";

const STUDIO_CALLER = "__studio";

const ConnectionAttachmentSchema = z.object({
  connectionId: z.string().min(1),
  connectedAt: z.number(),
});
export type ConnectionAttachment = z.infer<typeof ConnectionAttachmentSchema>;

const CallerTypeSchema = z.enum(["user", "service"]);

/** What the runtime reads off one accepted socket. */
export interface SocketRecord {
  tags: readonly string[];
  attachment: unknown;
}

export interface LiveConnection {
  connectionId: string;
  caller: string;
  callerType: "user" | "service";
  connectedAt: number;
  role: string | null;
}

function tagValue(tags: readonly string[], prefix: string): string | undefined {
  const tag = tags.find((t) => t.startsWith(prefix));
  return tag?.slice(prefix.length);
}

/** True for the socket Studio itself holds; it is never an app connection. */
export function isStudioSocket(tags: readonly string[]): boolean {
  return tagValue(tags, "caller:") === STUDIO_CALLER;
}

/** Parses one socket's attachment; null when it carries none (e.g. a Studio socket). */
export function readConnectionAttachment(attachment: unknown): ConnectionAttachment | null {
  const parsed = ConnectionAttachmentSchema.safeParse(attachment);
  return parsed.success ? parsed.data : null;
}

/**
 * Lists app connections from socket records, oldest first, with each caller's
 * current role. Studio sockets, and sockets without a valid identity or
 * attachment, are rejected rather than coerced.
 */
export function toLiveConnections<TState>(
  sockets: ReadonlyArray<SocketRecord>,
  roles: Record<string, RolePredicate<TState>>,
  state: TState,
): LiveConnection[] {
  const connections: LiveConnection[] = [];
  for (const socket of sockets) {
    if (isStudioSocket(socket.tags)) continue;
    const caller = tagValue(socket.tags, "caller:");
    const callerType = CallerTypeSchema.safeParse(tagValue(socket.tags, "callerType:"));
    const attachment = readConnectionAttachment(socket.attachment);
    if (caller === undefined || !callerType.success || attachment === null) continue;
    connections.push({
      connectionId: attachment.connectionId,
      caller,
      callerType: callerType.data,
      connectedAt: attachment.connectedAt,
      role: resolveRole(roles, state, caller, { callerType: callerType.data }),
    });
  }
  return connections.sort((a, b) => a.connectedAt - b.connectedAt);
}
