/**
 * Contract between the actor's studio WebSocket and the Studio UI.
 *
 * The UI keys timeline rows by entry id and de-duplicates live entries
 * against the snapshot by id, so every live `studio.timeline` entry must
 * carry the same id the row has in SQLite (and in `__getTimeline()`).
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const LiveTimelineFrame = z.object({
  type: z.literal("studio.timeline"),
  entry: z.object({ id: z.number().int(), causeType: z.string() }),
});

const TimelinePage = z.object({
  entries: z.array(z.object({ id: z.number().int() })),
});

describe("studio WebSocket → UI contract", () => {
  it("live timeline entries carry the persisted row id", async () => {
    const actorId = `studio-ui-id-${Date.now()}`;
    const stub = env.COUNTER.get(env.COUNTER.idFromName(actorId));
    await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });

    const response = await stub.fetch(`http://localhost/api/counter/${actorId}`, {
      headers: {
        Upgrade: "websocket",
        "X-Actor-Kit-Caller-Id": "__studio",
        "X-Actor-Kit-Caller-Type": "service",
      },
    });
    const ws = response.webSocket;
    ws?.accept();
    await waitForMessage(ws); // snapshot

    const firstLive = waitForMessage(ws);
    await stub.send("user-1", "user", { type: "INCREMENT", amount: 1 });
    const first = LiveTimelineFrame.parse(JSON.parse(await firstLive));

    const secondLive = waitForMessage(ws);
    await stub.send("user-1", "user", { type: "INCREMENT", amount: 1 });
    const second = LiveTimelineFrame.parse(JSON.parse(await secondLive));

    const page = TimelinePage.parse(await stub.__getTimeline({ limit: 2 }));
    expect(page.entries.map((e) => e.id)).toEqual([second.entry.id, first.entry.id]);
    expect(second.entry.id).toBeGreaterThan(first.entry.id);

    ws?.close(1000, "done");
    await new Promise((r) => setTimeout(r, 50));
  });

  // When the Studio page navigates away it closes its socket. The actor must
  // answer the close frame, or the browser socket sits in CLOSING forever.
  it.each([
    ["studio", "__studio", "service"],
    ["client", "user-1", "user"],
  ])("completes the close handshake when a %s socket closes", async (_label, callerId, callerType) => {
    const actorId = `studio-ui-close-${callerId}-${Date.now()}`;
    const stub = env.COUNTER.get(env.COUNTER.idFromName(actorId));
    await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });

    const response = await stub.fetch(`http://localhost/api/counter/${actorId}`, {
      headers: {
        Upgrade: "websocket",
        "X-Actor-Kit-Caller-Id": callerId,
        "X-Actor-Kit-Caller-Type": callerType,
      },
    });
    const ws = response.webSocket;
    if (!ws) throw new Error("no websocket");
    ws.accept();
    await waitForMessage(ws);

    const closed = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("server never answered the close frame")), 2000);
      ws.addEventListener("close", (event) => {
        clearTimeout(timer);
        resolve(event.code);
      });
    });
    ws.close(1000, "studio view closed");
    expect(await closed).toBe(1000);
  });
});

function waitForMessage(ws: WebSocket | null | undefined, timeout = 2000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (!ws) {
      reject(new Error("WebSocket is null"));
      return;
    }
    const timer = setTimeout(() => reject(new Error("Timeout waiting for message")), timeout);
    ws.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        if (typeof event.data === "string") resolve(event.data);
        else reject(new Error("Expected string message"));
      },
      { once: true },
    );
  });
}
