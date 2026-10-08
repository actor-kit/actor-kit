import { env } from "cloudflare:test";
import { applyDelta, decode, FrameType, parseFrame, schema, string, uint32 } from "@actor-kit/core";
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

function waitForFrame(ws: WebSocket): Promise<{ type: number; payload: Uint8Array; raw: Uint8Array }> {
  return new Promise((resolve) => {
    ws.addEventListener(
      "message",
      (event) => {
        let bytes: Uint8Array;
        if (event.data instanceof ArrayBuffer) {
          bytes = new Uint8Array(event.data);
        } else {
          bytes = new TextEncoder().encode(event.data as string);
        }
        const frame = parseFrame(bytes);
        resolve({ type: frame.type, payload: frame.payload, raw: bytes });
      },
      { once: true },
    );
  });
}

describe("Delta sync end-to-end (integration)", () => {
  it("first message after connect is a SNAPSHOT, second is a DELTA", async () => {
    const actorId = `delta-sync-1-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const id = env.COUNTER.idFromName(actorId);
    const stub = env.COUNTER.get(id);
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    const ws = await connectWs(stub, actorId, "u1");

    // First frame: SNAPSHOT (full state)
    const first = await waitForFrame(ws);
    expect(first.type).toBe(FrameType.SNAPSHOT);
    const initialView = decode(CounterView, first.payload) as { count: number; lastCaller: string };
    expect(initialView.count).toBe(0);

    // Send INCREMENT
    ws.send(JSON.stringify({ type: "INCREMENT", amount: 5 }));

    // Second frame: should be DELTA (only changed fields)
    const second = await waitForFrame(ws);
    expect(second.type).toBe(FrameType.DELTA);

    // Apply delta to get the updated view
    const updatedView = applyDelta(CounterView, initialView, second.payload) as { count: number; lastCaller: string };
    expect(updatedView.count).toBe(5);
    expect(updatedView.lastCaller).toBe("u1");

    ws.close(1000);
    await new Promise((r) => setTimeout(r, 50));
  });

  it("second update is a DELTA frame, not a SNAPSHOT", async () => {
    const actorId = `delta-sync-type-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const id = env.COUNTER.idFromName(actorId);
    const stub = env.COUNTER.get(id);
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    const ws = await connectWs(stub, actorId, "u1");

    // First: SNAPSHOT
    const snapshot = await waitForFrame(ws);
    expect(snapshot.type).toBe(FrameType.SNAPSHOT);

    // Send two increments — both should produce DELTA frames
    ws.send(JSON.stringify({ type: "INCREMENT", amount: 1 }));
    const delta1 = await waitForFrame(ws);
    expect(delta1.type).toBe(FrameType.DELTA);

    ws.send(JSON.stringify({ type: "INCREMENT", amount: 2 }));
    const delta2 = await waitForFrame(ws);
    expect(delta2.type).toBe(FrameType.DELTA);

    // Verify the deltas have the correct data by applying them
    let view = decode(CounterView, snapshot.payload) as Record<string, unknown>;
    view = applyDelta(CounterView, view, delta1.payload) as Record<string, unknown>;
    view = applyDelta(CounterView, view, delta2.payload) as Record<string, unknown>;
    expect((view as { count: number }).count).toBe(3);

    ws.close(1000);
    await new Promise((r) => setTimeout(r, 50));
  });

  it("multiple deltas accumulate correctly", async () => {
    const actorId = `delta-sync-multi-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const id = env.COUNTER.idFromName(actorId);
    const stub = env.COUNTER.get(id);
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    const ws = await connectWs(stub, actorId, "u1");

    // Get initial snapshot
    const first = await waitForFrame(ws);
    let currentView = decode(CounterView, first.payload) as Record<string, unknown>;

    // Send 3 increments, applying each delta
    for (let i = 1; i <= 3; i++) {
      ws.send(JSON.stringify({ type: "INCREMENT", amount: 1 }));
      const frame = await waitForFrame(ws);
      expect(frame.type).toBe(FrameType.DELTA);
      currentView = applyDelta(CounterView, currentView, frame.payload) as Record<string, unknown>;
    }

    expect((currentView as { count: number }).count).toBe(3);

    ws.close(1000);
    await new Promise((r) => setTimeout(r, 50));
  });
});
