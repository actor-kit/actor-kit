import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createAccessToken } from "../../packages/actor-kit/src/auth/auth";
import { decode } from "../../packages/actor-kit/src/schema/binary";
import { FrameType, parseFrame } from "../../packages/actor-kit/src/schema/frame";
import { schema, string, uint32 } from "../../packages/actor-kit/src/schema/schema";

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
    const actorId = "ws-binary-test";
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

  it("receives updated binary snapshot after send", async () => {
    const actorId = "ws-binary-update";
    const id = env.COUNTER.idFromName(actorId);
    const stub = env.COUNTER.get(id);

    await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });

    const response = await connectWs(stub, actorId, "user-1");
    const ws = response.webSocket!;
    ws.accept();

    // Consume initial snapshot
    await waitForBinaryMessage(ws);

    // Send INCREMENT — client messages are still JSON
    ws.send(JSON.stringify({ type: "INCREMENT", amount: 7 }));

    // Receive updated binary snapshot
    const data = await waitForBinaryMessage(ws);
    const frame = parseFrame(new Uint8Array(data));
    expect(frame.type).toBe(FrameType.SNAPSHOT);

    const view = decode(CounterView, frame.payload);
    expect((view as { count: number }).count).toBe(7);

    ws.close(1000, "done");
    await new Promise((r) => setTimeout(r, 50));
  });

  it("rejects WebSocket without auth token", async () => {
    const actorId = "ws-noauth-binary";
    const id = env.COUNTER.idFromName(actorId);
    const stub = env.COUNTER.get(id);

    await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });

    const response = await stub.fetch(`http://localhost/api/counter/${actorId}`, {
      headers: { Upgrade: "websocket" },
    });

    expect(response.status).toBe(401);
  });
});
