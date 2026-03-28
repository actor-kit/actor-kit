import { env } from "cloudflare:test";
import { applyDelta, decode, FrameType, parseFrame, schema, string, uint32 } from "@actor-kit/core";
import { describe, expect, it } from "vitest";

const CounterView = schema({ count: uint32, lastCaller: string });

function getStub(name: string) {
  const id = env.COUNTER.idFromName(name);
  return { stub: env.COUNTER.get(id), actorId: name };
}

async function connectAndGetSnapshot(stub: DurableObjectStub, actorId: string, callerId: string) {
  const response = await stub.fetch(`http://localhost/api/counter/${actorId}`, {
    headers: {
      Upgrade: "websocket",
      "X-Actor-Kit-Caller-Id": callerId,
      "X-Actor-Kit-Caller-Type": "user",
    },
  });

  const ws = response.webSocket!;
  ws.accept();

  const data = await new Promise<ArrayBuffer>((resolve) => {
    ws.addEventListener(
      "message",
      (event) => {
        if (event.data instanceof ArrayBuffer) resolve(event.data);
        else resolve(new TextEncoder().encode(event.data as string).buffer);
      },
      { once: true },
    );
  });

  return { ws, data };
}

describe("Binary view sync (integration)", () => {
  it("initial snapshot contains correct binary-encoded view", async () => {
    const { stub, actorId } = getStub("binary-view-1");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });
    await stub.send("u1", "user", { type: "INCREMENT", amount: 25 });

    const { ws, data } = await connectAndGetSnapshot(stub, actorId, "u1");
    const frame = parseFrame(new Uint8Array(data));

    expect(frame.type).toBe(FrameType.SNAPSHOT);
    const view = decode(CounterView, frame.payload) as { count: number; lastCaller: string };
    expect(view.count).toBe(25);
    expect(view.lastCaller).toBe("u1");

    ws.close(1000);
    await new Promise((r) => setTimeout(r, 50));
  });

  it("view updates are broadcast as binary delta after message", async () => {
    const { stub, actorId } = getStub("binary-view-2");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    const { ws, data: snapshotData } = await connectAndGetSnapshot(stub, actorId, "u1");
    const initialView = decode(CounterView, parseFrame(new Uint8Array(snapshotData)).payload) as Record<
      string,
      unknown
    >;

    // Send INCREMENT via WS (JSON)
    ws.send(JSON.stringify({ type: "INCREMENT", amount: 10 }));

    // Receive binary DELTA update
    const updateData = await new Promise<ArrayBuffer>((resolve) => {
      ws.addEventListener(
        "message",
        (event) => {
          if (event.data instanceof ArrayBuffer) resolve(event.data);
          else resolve(new TextEncoder().encode(event.data as string).buffer);
        },
        { once: true },
      );
    });

    const frame = parseFrame(new Uint8Array(updateData));
    expect(frame.type).toBe(FrameType.DELTA);
    const view = applyDelta(CounterView, initialView, frame.payload) as { count: number };
    expect(view.count).toBe(10);

    ws.close(1000);
    await new Promise((r) => setTimeout(r, 50));
  });

  it("multiple callers each get their own binary snapshot", async () => {
    const { stub, actorId } = getStub("binary-view-3");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });
    await stub.send("u1", "user", { type: "INCREMENT", amount: 7 });

    // Connect two users
    const { ws: ws1, data: data1 } = await connectAndGetSnapshot(stub, actorId, "u1");
    const { ws: ws2, data: data2 } = await connectAndGetSnapshot(stub, actorId, "u2");

    // Both should see count=7
    const view1 = decode(CounterView, parseFrame(new Uint8Array(data1)).payload) as { count: number };
    const view2 = decode(CounterView, parseFrame(new Uint8Array(data2)).payload) as { count: number };

    expect(view1.count).toBe(7);
    expect(view2.count).toBe(7);

    ws1.close(1000);
    ws2.close(1000);
    await new Promise((r) => setTimeout(r, 50));
  });
});
