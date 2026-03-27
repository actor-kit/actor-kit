import { env } from "cloudflare:test";
import { applyDelta, decode, FrameType, parseFrame, schema, string, uint32 } from "@actor-kit/core";
import { createAccessToken } from "@actor-kit/worker";
import { describe, expect, it } from "vitest";

const SECRET = "test-secret-for-integration-tests-only";

// Must match the CounterView from the test worker
const CounterView = schema({ count: uint32, lastCaller: string });

async function connectWs(
  stub: DurableObjectStub,
  actorId: string,
  callerId: string,
  callerType: "user" | "service" = "user",
) {
  const token = await createAccessToken({
    actorType: "counter",
    actorId,
    callerId,
    callerType,
    secret: SECRET,
  });

  return stub.fetch(`http://localhost/api/counter/${actorId}`, {
    headers: {
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": `token.${token}`,
    },
  });
}

function waitForBinaryMessage(ws: WebSocket): Promise<ArrayBuffer> {
  return new Promise<ArrayBuffer>((resolve) => {
    ws.addEventListener(
      "message",
      (event) => {
        if (event.data instanceof ArrayBuffer) {
          resolve(event.data);
        } else if (typeof event.data === "string") {
          // JSON fallback — convert to buffer for uniform handling
          resolve(new TextEncoder().encode(event.data).buffer);
        }
      },
      { once: true },
    );
  });
}

describe("Counter DO WebSocket (binary)", () => {
  it("connects and receives binary snapshot frame", async () => {
    const actorId = `ws-binary-test-${Date.now()}`;
    const id = env.COUNTER.idFromName(actorId);
    const stub = env.COUNTER.get(id);

    await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });

    const response = await connectWs(stub, actorId, "user-1");
    expect(response.status).toBe(101);

    const ws = response.webSocket!;
    ws.accept();

    const data = await waitForBinaryMessage(ws);
    const bytes = new Uint8Array(data);

    // Parse the frame
    const frame = parseFrame(bytes);
    expect(frame.type).toBe(FrameType.SNAPSHOT);

    // Decode the payload using the schema
    const view = decode(CounterView, frame.payload);
    expect(view).toEqual({ count: 0, lastCaller: "" });

    ws.close(1000, "done");
    await new Promise((r) => setTimeout(r, 50));
  });

  it("receives binary delta after send", async () => {
    const actorId = `ws-binary-update-${Date.now()}`;
    const id = env.COUNTER.idFromName(actorId);
    const stub = env.COUNTER.get(id);

    await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });

    const response = await connectWs(stub, actorId, "user-1");
    const ws = response.webSocket!;
    ws.accept();

    // Get initial snapshot
    const initialData = await waitForBinaryMessage(ws);
    const initialFrame = parseFrame(new Uint8Array(initialData));
    expect(initialFrame.type).toBe(FrameType.SNAPSHOT);
    const initialView = decode(CounterView, initialFrame.payload) as Record<string, unknown>;

    // Send INCREMENT
    ws.send(JSON.stringify({ type: "INCREMENT", amount: 7 }));

    // Receive DELTA frame (not snapshot — delta encoding is active)
    const data = await waitForBinaryMessage(ws);
    const frame = parseFrame(new Uint8Array(data));
    expect(frame.type).toBe(FrameType.DELTA);

    // Apply delta to get updated view
    const view = applyDelta(CounterView, initialView, frame.payload);
    expect((view as { count: number }).count).toBe(7);

    ws.close(1000, "done");
    await new Promise((r) => setTimeout(r, 50));
  });

  it("rejects WebSocket without auth token", async () => {
    const actorId = `ws-noauth-${Date.now()}`;
    const id = env.COUNTER.idFromName(actorId);
    const stub = env.COUNTER.get(id);

    await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });

    const response = await stub.fetch(`http://localhost/api/counter/${actorId}`, {
      headers: { Upgrade: "websocket" },
    });

    expect(response.status).toBe(401);
  });
});
