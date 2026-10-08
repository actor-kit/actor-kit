import { env } from "cloudflare:test";
import { applyDelta, decode, FrameType, nullable, parseFrame, schema, string, uint32 } from "@actor-kit/core";
import { describe, expect, it } from "vitest";

const NullableCounterView = schema({ count: uint32, lastUpdatedBy: nullable(string) });

function getStub(name: string) {
  const id = env.NULLABLE_COUNTER.idFromName(name);
  return { stub: env.NULLABLE_COUNTER.get(id), actorId: name };
}

async function connectBinary(stub: DurableObjectStub, actorId: string, callerId: string) {
  const response = await stub.fetch(`http://localhost/api/nullable-counter/${actorId}`, {
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

function nextMessage(ws: WebSocket): Promise<ArrayBuffer> {
  return new Promise<ArrayBuffer>((resolve) => {
    ws.addEventListener(
      "message",
      (event) => {
        if (event.data instanceof ArrayBuffer) resolve(event.data);
        else resolve(new TextEncoder().encode(event.data as string).buffer);
      },
      { once: true },
    );
  });
}

describe("Nullable binary views (integration)", () => {
  it("initial snapshot decodes lastUpdatedBy as null", async () => {
    const { stub, actorId } = getStub("nullable-1");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    const { ws, data } = await connectBinary(stub, actorId, "u1");
    const frame = parseFrame(new Uint8Array(data));
    expect(frame.type).toBe(FrameType.SNAPSHOT);

    const view = decode(NullableCounterView, frame.payload);
    expect(view.count).toBe(0);
    expect(view.lastUpdatedBy).toBeNull();

    ws.close(1000);
    await new Promise((r) => setTimeout(r, 50));
  });

  it("null → value transition via delta", async () => {
    const { stub, actorId } = getStub("nullable-2");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    const { ws, data } = await connectBinary(stub, actorId, "u1");
    const initialFrame = parseFrame(new Uint8Array(data));
    const initialView = decode(NullableCounterView, initialFrame.payload) as Record<string, unknown>;
    expect(initialView.lastUpdatedBy).toBeNull();

    // Send SET_COUNT to change lastUpdatedBy from null to "u1"
    ws.send(JSON.stringify({ type: "SET_COUNT", value: 42 }));

    const updateData = await nextMessage(ws);
    const deltaFrame = parseFrame(new Uint8Array(updateData));
    expect(deltaFrame.type).toBe(FrameType.DELTA);

    const updatedView = applyDelta(NullableCounterView, initialView, deltaFrame.payload);
    expect(updatedView.count).toBe(42);
    expect(updatedView.lastUpdatedBy).toBe("u1");

    ws.close(1000);
    await new Promise((r) => setTimeout(r, 50));
  });

  it("value → null transition via delta", async () => {
    const { stub, actorId } = getStub("nullable-3");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    // Set a value first
    const { ws, data } = await connectBinary(stub, actorId, "u1");
    const snap = decode(NullableCounterView, parseFrame(new Uint8Array(data)).payload) as Record<string, unknown>;

    ws.send(JSON.stringify({ type: "SET_COUNT", value: 10 }));
    const delta1 = await nextMessage(ws);
    const view1 = applyDelta(NullableCounterView, snap, parseFrame(new Uint8Array(delta1)).payload) as Record<
      string,
      unknown
    >;
    expect(view1.lastUpdatedBy).toBe("u1");

    // Now clear updater → null
    ws.send(JSON.stringify({ type: "CLEAR_UPDATER" }));
    const delta2 = await nextMessage(ws);
    const view2 = applyDelta(NullableCounterView, view1, parseFrame(new Uint8Array(delta2)).payload);
    expect(view2.count).toBe(10);
    expect(view2.lastUpdatedBy).toBeNull();

    ws.close(1000);
    await new Promise((r) => setTimeout(r, 50));
  });
});
