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
  /** Per-actor connect order; breaks `connectedAt` ties and survives hibernation with the socket. */
  seq: z.number().int().nonnegative().optional(),
  /** Closed by the actor because its heartbeat stopped (ADR-020 E): no longer a live connection. */
  reaped: z.literal(true).optional(),
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
 * Lists app connections from socket records, oldest first (by `connectedAt`, then connect sequence), with each caller's
 * current role. Studio sockets, and sockets without a valid identity or
 * attachment, are rejected rather than coerced.
 */
export function toLiveConnections<TState>(
  sockets: ReadonlyArray<SocketRecord>,
  roles: Record<string, RolePredicate<TState>>,
  state: TState,
): LiveConnection[] {
  const connections: Array<{ connection: LiveConnection; seq: number }> = [];
  for (const socket of sockets) {
    if (isStudioSocket(socket.tags)) continue;
    const caller = tagValue(socket.tags, "caller:");
    const callerType = CallerTypeSchema.safeParse(tagValue(socket.tags, "callerType:"));
    const attachment = readConnectionAttachment(socket.attachment);
    if (caller === undefined || !callerType.success || attachment === null || attachment.reaped) continue;
    connections.push({
      seq: attachment.seq ?? 0,
      connection: {
        connectionId: attachment.connectionId,
        caller,
        callerType: callerType.data,
        connectedAt: attachment.connectedAt,
        role: resolveRole(roles, state, caller, { callerType: callerType.data }),
      },
    });
  }
  return connections
    .sort((a, b) => a.connection.connectedAt - b.connection.connectedAt || a.seq - b.seq)
    .map((entry) => entry.connection);
}

/**
 * The sequence number for the next connection: one past the highest among the
 * sockets held now. Derived from the attachments, so it keeps increasing across
 * hibernation without any extra storage.
 */
export function nextConnectionSeq(sockets: ReadonlyArray<SocketRecord>): number {
  let highest = 0;
  for (const socket of sockets) {
    highest = Math.max(highest, readConnectionAttachment(socket.attachment)?.seq ?? 0);
  }
  return highest + 1;
}
