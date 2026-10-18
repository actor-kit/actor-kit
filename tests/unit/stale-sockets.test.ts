/**
 * ADR-020 E: which app sockets an actor that opted in (`heartbeat: { staleMs }`) closes because
 * their heartbeat stopped. Only sockets that pinged at least once and then went quiet for longer
 * than staleMs; never Studio, never a socket already reaped, never one that never pinged.
 */
import { describe, expect, it } from "vitest";
import { readConnectionAttachment, toLiveConnections } from "../../packages/worker/src/runtime/live-connections";
import { reapedAttachment, staleSockets } from "../../packages/worker/src/runtime/stale-sockets";

const app = (id: string, lastPing: number | null, extra: Record<string, unknown> = {}) => ({
  socket: id,
  tags: [`caller:${id}`, "callerType:user"],
  attachment: { connectionId: id, connectedAt: 1, ...extra },
  lastPing: lastPing === null ? null : new Date(lastPing),
});

describe("staleSockets", () => {
  const now = 100_000;

  it("picks app sockets whose last ping is more than staleMs ago", () => {
    const sockets = [app("fresh", now - 1000), app("edge", now - 5000), app("stale", now - 5001)];
    expect(staleSockets(sockets, now, 5000)).toEqual(["stale"]);
  });

  it("never picks a socket that never pinged (heartbeat off, an older client)", () => {
    expect(staleSockets([app("quiet", null)], now, 1)).toEqual([]);
  });

  it("never picks Studio or a socket already reaped", () => {
    const studio = { ...app("s", 0), tags: ["caller:__studio", "callerType:service"] };
    expect(staleSockets([studio, app("gone", 0, { reaped: true })], now, 1)).toEqual([]);
  });

  it("never picks a socket without a valid attachment", () => {
    expect(staleSockets([{ ...app("x", 0), attachment: null }], now, 1)).toEqual([]);
  });
});

describe("a reaped socket's attachment", () => {
  it("keeps the connection's identity and marks it reaped", () => {
    const attachment = reapedAttachment({ connectionId: "c1", connectedAt: 5, seq: 2 });
    expect(attachment).toEqual({ connectionId: "c1", connectedAt: 5, seq: 2, reaped: true });
    expect(readConnectionAttachment(attachment)).toEqual(attachment);
  });

  it("is not a live connection any more", () => {
    const roles = { player: () => true };
    const live = toLiveConnections(
      [app("a", 0), app("b", 0, { reaped: true })].map(({ tags, attachment }) => ({ tags, attachment })),
      roles,
      {},
    );
    expect(live.map((c) => c.caller)).toEqual(["a"]);
  });
});
