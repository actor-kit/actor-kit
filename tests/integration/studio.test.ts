import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Studio instrumentation (integration)", () => {
  describe("__inspect()", () => {
    it("returns current state and metadata", async () => {
      const actorId = `inspect-${Date.now()}`;
      const id = env.COUNTER.idFromName(actorId);
      const stub = env.COUNTER.get(id);

      await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });
      await stub.send("user-1", "user", { type: "INCREMENT", amount: 5 });

      const result = (await stub.__inspect()) as {
        state: { count: number; lastCaller: string | null };
        version: number;
        actorId: string;
        connections: unknown[];
        outbox: unknown[];
        activeLinks: unknown[];
        linkSubscribers: unknown[];
      };

      expect(result.state.count).toBe(5);
      expect(result.state.lastCaller).toBe("user-1");
      expect(result.version).toBe(1);
      // actorId is the DO hex ID (auto-spawn sets ctx.id, not the name)
      expect(typeof result.actorId).toBe("string");
      expect(result.actorId.length).toBeGreaterThan(0);
      expect(result.connections).toEqual([]);
      expect(result.outbox).toEqual([]);
      expect(result.activeLinks).toEqual([]);
      expect(result.linkSubscribers).toEqual([]);
    });

    it("shows outbox entries for service executions", async () => {
      const actorId = `inspect-outbox-${Date.now()}`;
      const id = env.COUNTER.idFromName(actorId);
      const stub = env.COUNTER.get(id);

      await stub.spawn({ actorId, caller: "svc", callerType: "service", input: {} });
      // NOTIFY triggers ctx.execute("ANALYTICS", ...) — admin role required (callerType=service)
      await stub.send("svc", "service", { type: "NOTIFY" });

      const result = (await stub.__inspect()) as {
        outbox: Array<{ service: string; status: string }>;
      };

      // The execution should be in the outbox (may be pending or failed since ANALYTICS service doesn't exist)
      expect(result.outbox.length).toBeGreaterThanOrEqual(1);
      const analyticsEntry = result.outbox.find((e) => e.service === "ANALYTICS");
      expect(analyticsEntry).toBeDefined();
    });
  });

  describe("__getTimeline()", () => {
    it("records timeline entries for messages", async () => {
      const actorId = `timeline-${Date.now()}`;
      const id = env.COUNTER.idFromName(actorId);
      const stub = env.COUNTER.get(id);

      await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });
      await stub.send("user-1", "user", { type: "INCREMENT", amount: 3 });
      await stub.send("user-1", "user", { type: "INCREMENT", amount: 7 });

      const result = (await stub.__getTimeline()) as {
        entries: Array<{
          id: number;
          causeType: string;
          causeData: string;
          stateSnapshot: string;
          checksum: string;
          createdAt: number;
        }>;
        hasMore: boolean;
      };

      // init + 2 messages = 3 entries (newest first)
      expect(result.entries.length).toBe(3);
      expect(result.hasMore).toBe(false);

      // Most recent entry should be the second INCREMENT
      const newest = result.entries[0];
      expect(newest?.causeType).toBe("message");
      const newestCause = JSON.parse(newest?.causeData ?? "{}") as { messageType: string };
      expect(newestCause.messageType).toBe("INCREMENT");

      const newestState = JSON.parse(newest?.stateSnapshot ?? "{}") as { count: number };
      expect(newestState.count).toBe(10);

      // Oldest entry should be init
      const oldest = result.entries[2];
      expect(oldest?.causeType).toBe("init");
    });

    it("supports pagination with before cursor", async () => {
      const actorId = `timeline-page-${Date.now()}`;
      const id = env.COUNTER.idFromName(actorId);
      const stub = env.COUNTER.get(id);

      await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });
      // Send 5 messages
      for (let i = 0; i < 5; i++) {
        await stub.send("user-1", "user", { type: "INCREMENT", amount: 1 });
      }

      // Get first page (limit 3)
      const page1 = (await stub.__getTimeline({ limit: 3 })) as {
        entries: Array<{ id: number; causeType: string }>;
        hasMore: boolean;
      };

      expect(page1.entries.length).toBe(3);
      expect(page1.hasMore).toBe(true);

      // Get second page using cursor
      const lastId = page1.entries[2]?.id;
      expect(lastId).toBeDefined();

      const page2 = (await stub.__getTimeline({ limit: 3, before: lastId })) as {
        entries: Array<{ id: number; causeType: string }>;
        hasMore: boolean;
      };

      expect(page2.entries.length).toBe(3); // init + 2 remaining messages
      expect(page2.hasMore).toBe(false);
    });

    it("records init cause on spawn", async () => {
      const actorId = `timeline-init-${Date.now()}`;
      const id = env.COUNTER.idFromName(actorId);
      const stub = env.COUNTER.get(id);

      await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });

      const result = (await stub.__getTimeline()) as {
        entries: Array<{ causeType: string; stateSnapshot: string }>;
      };

      expect(result.entries.length).toBe(1);
      expect(result.entries[0]?.causeType).toBe("init");

      const state = JSON.parse(result.entries[0]?.stateSnapshot ?? "{}") as { count: number };
      expect(state.count).toBe(0);
    });

    it("records message payload in cause data", async () => {
      const actorId = `timeline-payload-${Date.now()}`;
      const id = env.COUNTER.idFromName(actorId);
      const stub = env.COUNTER.get(id);

      await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });
      await stub.send("user-1", "user", { type: "INCREMENT", amount: 42 });

      const result = (await stub.__getTimeline()) as {
        entries: Array<{ causeType: string; causeData: string }>;
      };

      const messageEntry = result.entries.find((e) => e.causeType === "message");
      expect(messageEntry).toBeDefined();

      const cause = JSON.parse(messageEntry?.causeData ?? "{}") as {
        messageType: string;
        caller: string;
        role: string;
        payload: { amount: number };
      };
      expect(cause.messageType).toBe("INCREMENT");
      expect(cause.caller).toBe("user-1");
      expect(cause.role).toBe("user");
      expect(cause.payload.amount).toBe(42);
    });
  });

  describe("studio WebSocket", () => {
    it("connects with __studio caller and receives snapshot", async () => {
      const actorId = `studio-ws-${Date.now()}`;
      const id = env.COUNTER.idFromName(actorId);
      const stub = env.COUNTER.get(id);

      await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });
      await stub.send("user-1", "user", { type: "INCREMENT", amount: 5 });

      // Connect as studio
      const response = await stub.fetch(`http://localhost/api/counter/${actorId}`, {
        headers: {
          Upgrade: "websocket",
          "X-Actor-Kit-Caller-Id": "__studio",
          "X-Actor-Kit-Caller-Type": "service",
        },
      });

      expect(response.status).toBe(101);
      const ws = response.webSocket;
      expect(ws).toBeDefined();
      ws?.accept();

      // Should receive studio.snapshot
      const msg = await waitForMessage(ws);
      const snapshot = JSON.parse(msg) as {
        type: string;
        state: { count: number };
        actorType: string;
        actorId: string;
        timeline: unknown[];
        connections: unknown[];
      };

      expect(snapshot.type).toBe("studio.snapshot");
      expect(snapshot.state.count).toBe(5);
      expect(snapshot.actorType).toBe("counter");
      expect(typeof snapshot.actorId).toBe("string");
      expect(snapshot.actorId.length).toBeGreaterThan(0);
      expect(snapshot.timeline.length).toBeGreaterThanOrEqual(1);
      expect(snapshot.connections).toEqual([]); // no app clients connected

      ws?.close(1000, "done");
      await new Promise((r) => setTimeout(r, 50));
    });

    it("receives live timeline entries when state changes", async () => {
      const actorId = `studio-live-${Date.now()}`;
      const id = env.COUNTER.idFromName(actorId);
      const stub = env.COUNTER.get(id);

      await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });

      // Connect studio
      const response = await stub.fetch(`http://localhost/api/counter/${actorId}`, {
        headers: {
          Upgrade: "websocket",
          "X-Actor-Kit-Caller-Id": "__studio",
          "X-Actor-Kit-Caller-Type": "service",
        },
      });
      const ws = response.webSocket;
      ws?.accept();

      // Consume the initial snapshot
      await waitForMessage(ws);

      // Set up listener BEFORE sending to avoid race
      const liveEntryPromise = waitForMessage(ws);

      // Now send a message via RPC
      await stub.send("user-1", "user", { type: "INCREMENT", amount: 10 });

      // Studio should receive a timeline entry
      const msg = await liveEntryPromise;
      const entry = JSON.parse(msg) as {
        type: string;
        entry: { causeType: string; stateSnapshot: string };
      };

      expect(entry.type).toBe("studio.timeline");
      expect(entry.entry.causeType).toBe("message");

      const state = JSON.parse(entry.entry.stateSnapshot) as { count: number };
      expect(state.count).toBe(10);

      ws?.close(1000, "done");
      await new Promise((r) => setTimeout(r, 50));
    });

    it("does not interfere with normal client connections", async () => {
      const actorId = `studio-nointerfer-${Date.now()}`;
      const id = env.COUNTER.idFromName(actorId);
      const stub = env.COUNTER.get(id);

      await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });

      // Connect studio
      const studioRes = await stub.fetch(`http://localhost/api/counter/${actorId}`, {
        headers: {
          Upgrade: "websocket",
          "X-Actor-Kit-Caller-Id": "__studio",
          "X-Actor-Kit-Caller-Type": "service",
        },
      });
      const studioWs = studioRes.webSocket;
      studioWs?.accept();
      await waitForMessage(studioWs); // consume snapshot

      // Set up listener for studio connection notification BEFORE connecting client
      const studioConnNotifPromise = waitForMessage(studioWs);

      // Connect normal client
      const clientRes = await stub.fetch(`http://localhost/api/counter/${actorId}`, {
        headers: {
          Upgrade: "websocket",
          "X-Actor-Kit-Caller-Id": "user-1",
          "X-Actor-Kit-Caller-Type": "user",
          "X-Actor-Kit-Binary": "0",
        },
      });
      expect(clientRes.status).toBe(101);
      const clientWs = clientRes.webSocket;
      clientWs?.accept();

      // Client should receive normal JSON snapshot (not studio format)
      const clientMsg = await waitForMessage(clientWs);
      const clientSnapshot = JSON.parse(clientMsg) as { type: string; role: string; data: { count: number } };
      expect(clientSnapshot.type).toBe("snapshot");
      expect(clientSnapshot.role).toBe("user");
      expect(clientSnapshot.data.count).toBe(0);

      // Studio should receive connection notification
      const studioMsg = await studioConnNotifPromise;
      const connNotif = JSON.parse(studioMsg) as {
        type: string;
        action: string;
        connection: { caller: string };
      };
      expect(connNotif.type).toBe("studio.connection");
      expect(connNotif.action).toBe("connect");
      expect(connNotif.connection.caller).toBe("user-1");

      // Inspect should show 1 connection (not counting studio)
      const inspectResult = (await stub.__inspect()) as { connections: unknown[] };
      expect(inspectResult.connections.length).toBe(1);

      clientWs?.close(1000, "done");
      studioWs?.close(1000, "done");
      await new Promise((r) => setTimeout(r, 50));
    });

    it("handles studio.requestView", async () => {
      const actorId = `studio-view-${Date.now()}`;
      const id = env.COUNTER.idFromName(actorId);
      const stub = env.COUNTER.get(id);

      await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });
      await stub.send("user-1", "user", { type: "INCREMENT", amount: 7 });

      // Connect studio
      const response = await stub.fetch(`http://localhost/api/counter/${actorId}`, {
        headers: {
          Upgrade: "websocket",
          "X-Actor-Kit-Caller-Id": "__studio",
          "X-Actor-Kit-Caller-Type": "service",
        },
      });
      const ws = response.webSocket;
      ws?.accept();
      await waitForMessage(ws); // consume snapshot

      // Request view for "user" role
      ws?.send(JSON.stringify({ type: "studio.requestView", role: "user" }));

      const msg = await waitForMessage(ws);
      const viewResult = JSON.parse(msg) as {
        type: string;
        role: string;
        data: { count: number };
      };

      expect(viewResult.type).toBe("studio.view");
      expect(viewResult.role).toBe("user");
      expect(viewResult.data.count).toBe(7);

      ws?.close(1000, "done");
      await new Promise((r) => setTimeout(r, 50));
    });
  });
});

// --- Helper ---

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
        if (typeof event.data === "string") {
          resolve(event.data);
        } else {
          reject(new Error("Expected string message"));
        }
      },
      { once: true },
    );
  });
}
