import { env } from "cloudflare:test";
import { decode, FrameType, parseFrame, schema, string, uint32, xxh64 } from "@actor-kit/core";
import { describe, expect, it } from "vitest";

const CounterView = schema({ count: uint32, lastCaller: string });

async function connectWs(stub: DurableObjectStub, actorId: string, callerId: string) {
  const response = await stub.fetch(`http://localhost/api/counter/${actorId}`, {
    headers: {
      Upgrade: "websocket",
      "X-Actor-Kit-Caller-Id": callerId,
      "X-Actor-Kit-Caller-Type": "user",
      "X-Actor-Kit-Binary": "1",
    },
  });

  const ws = response.webSocket;

  if (ws === null) throw new Error("expected a WebSocket upgrade");
  ws.accept();
  return ws;
}

function waitForMessage(ws: WebSocket): Promise<{ binary: boolean; data: ArrayBuffer | string }> {
  return new Promise((resolve) => {
    ws.addEventListener(
      "message",
      (event) => {
        if (event.data instanceof ArrayBuffer) {
          resolve({ binary: true, data: event.data });
        } else {
          resolve({ binary: false, data: event.data as string });
        }
      },
      { once: true },
    );
  });
}

function computeChecksum(json: string): string {
  return xxh64(json);
}

describe("Reconnection with checksum (integration)", () => {
  it("reconnect with matching checksum gets ack (no data resent)", async () => {
    const actorId = `reconnect-1-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const id = env.COUNTER.idFromName(actorId);
    const stub = env.COUNTER.get(id);
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    // First connection — get initial snapshot
    const ws1 = await connectWs(stub, actorId, "u1");
    const msg1 = await waitForMessage(ws1);
    expect(msg1.binary).toBe(true);

    // Decode to get the view, compute checksum
    const frame1 = parseFrame(new Uint8Array(msg1.data as ArrayBuffer));
    const view1 = decode(CounterView, frame1.payload);
    const checksum = computeChecksum(JSON.stringify(view1));

    // Close first connection
    ws1.close(1000);
    await new Promise((r) => setTimeout(r, 50));

    // Reconnect — send __reconnect with the checksum
    const ws2 = await connectWs(stub, actorId, "u1");
    // Consume the initial snapshot from the new connection
    await waitForMessage(ws2);

    // Now send __reconnect handshake
    ws2.send(JSON.stringify({ type: "__reconnect", lastChecksum: checksum }));

    // Should get __reconnect_ack (state hasn't changed)
    const ackMsg = await waitForMessage(ws2);
    expect(ackMsg.binary).toBe(false);
    const ack = JSON.parse(ackMsg.data as string);
    expect(ack.type).toBe("__reconnect_ack");
    expect(ack.checksum).toBe(checksum);

    ws2.close(1000);
    await new Promise((r) => setTimeout(r, 50));
  });

  it("reconnect with stale checksum gets new snapshot", async () => {
    const actorId = `reconnect-2-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const id = env.COUNTER.idFromName(actorId);
    const stub = env.COUNTER.get(id);
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    // First connection
    const ws1 = await connectWs(stub, actorId, "u1");
    const msg1 = await waitForMessage(ws1);
    const frame1 = parseFrame(new Uint8Array(msg1.data as ArrayBuffer));
    const view1 = decode(CounterView, frame1.payload);
    const oldChecksum = computeChecksum(JSON.stringify(view1));

    ws1.close(1000);
    await new Promise((r) => setTimeout(r, 50));

    // Modify state while disconnected
    await stub.send("u1", "user", { type: "INCREMENT", amount: 42 });

    // Reconnect with stale checksum
    const ws2 = await connectWs(stub, actorId, "u1");
    await waitForMessage(ws2); // consume initial snapshot

    ws2.send(JSON.stringify({ type: "__reconnect", lastChecksum: oldChecksum }));

    // Should get a new SNAPSHOT (checksum doesn't match)
    const updateMsg = await waitForMessage(ws2);
    expect(updateMsg.binary).toBe(true);

    const frame2 = parseFrame(new Uint8Array(updateMsg.data as ArrayBuffer));
    expect(frame2.type).toBe(FrameType.SNAPSHOT);

    const view2 = decode(CounterView, frame2.payload) as { count: number };
    expect(view2.count).toBe(42);

    ws2.close(1000);
    await new Promise((r) => setTimeout(r, 50));
  });
});
