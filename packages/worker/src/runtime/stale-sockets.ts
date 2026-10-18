/**
 * Sockets whose heartbeat stopped (ADR-020 E, opt-in with `heartbeat: { staleMs }`). A phone that
 * slept leaves a half-open socket: its client reconnects on a new one, but the actor never hears
 * the old one close, so the player would stay online. The runtime answers client pings itself
 * (`setWebSocketAutoResponse`) and records when it last did; a socket that pinged and then went
 * quiet for longer than `staleMs` is closed by the actor, which runs its disconnect lifecycle.
 */
import { type ConnectionAttachment, isStudioSocket, readConnectionAttachment } from "./live-connections";

export interface PingedSocket<TSocket> {
  socket: TSocket;
  tags: readonly string[];
  attachment: unknown;
  /** `ctx.getWebSocketAutoResponseTimestamp(ws)`: null until the socket's first ping. */
  lastPing: Date | null;
}

export function staleSockets<TSocket>(
  sockets: ReadonlyArray<PingedSocket<TSocket>>,
  now: number,
  staleMs: number,
): TSocket[] {
  return sockets
    .filter((s) => {
      if (isStudioSocket(s.tags) || s.lastPing === null) return false;
      const attachment = readConnectionAttachment(s.attachment);
      return attachment !== null && attachment.reaped !== true && now - s.lastPing.getTime() > staleMs;
    })
    .map((s) => s.socket);
}

/** The attachment of a socket the actor closed for a stopped heartbeat: no longer a live connection. */
export function reapedAttachment(attachment: ConnectionAttachment): ConnectionAttachment {
  return { ...attachment, reaped: true };
}

/** The close code the actor sends a socket it closes for a stopped heartbeat (application range). */
export const STALE_CLOSE_CODE = 4001;
