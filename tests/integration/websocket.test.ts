import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createAccessToken } from "../../packages/actor-kit/src/auth/auth";

const SECRET = "test-secret-for-integration-tests-only";

async function connectWs(stub: DurableObjectStub, actorId: string, callerId: string, callerType: "user" | "service" = "user") {
  const token = await createAccessToken({
    actorType: "counter",
    actorId,
    callerId,
    callerType,
    secret: SECRET,
  });

  const response = await stub.fetch(`http://localhost/api/counter/${actorId}`, {
    headers: {
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": `token.${token}`,
    },
  });

  return response;
}

function waitForMessage(ws: WebSocket): Promise<string> {
  return new Promise<string>((resolve) => {
    ws.addEventListener("message", (event) => {
      resolve(event.data as string);
    }, { once: true });
  });
}

describe("Counter DO WebSocket", () => {
  it("connects via WebSocket and receives initial snapshot", async () => {
    const actorId = "ws-snapshot-test";
    const id = env.COUNTER.idFromName(actorId);
    const stub = env.COUNTER.get(id);

    await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });

    const response = await connectWs(stub, actorId, "user-1");
    expect(response.status).toBe(101);
    expect(response.webSocket).toBeDefined();

    const ws = response.webSocket!;
    ws.accept();

    const message = await waitForMessage(ws);
    const parsed = JSON.parse(message);

    expect(parsed.type).toBe("snapshot");
    expect(parsed.role).toBe("user");
    expect(parsed.data).toEqual({ count: 0, lastCaller: "" });

    // Close cleanly — send close and wait a tick for DO handler
    ws.close(1000, "test complete");
    await new Promise((r) => setTimeout(r, 50));
  });

  it("receives view updates after sending messages", async () => {
    const actorId = "ws-update-test";
    const id = env.COUNTER.idFromName(actorId);
    const stub = env.COUNTER.get(id);

    await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });

    const response = await connectWs(stub, actorId, "user-1");
    const ws = response.webSocket!;
    ws.accept();

    // Consume initial snapshot
    await waitForMessage(ws);

    // Send INCREMENT via WebSocket
    ws.send(JSON.stringify({ type: "INCREMENT", amount: 7 }));

    // Should receive updated view
    const update = await waitForMessage(ws);
    const parsed = JSON.parse(update);

    expect(parsed.type).toBe("snapshot");
    expect(parsed.data.count).toBe(7);

    ws.close(1000, "test complete");
    await new Promise((r) => setTimeout(r, 50));
  });

  it("rejects WebSocket without auth token", async () => {
    const actorId = "ws-noauth-test";
    const id = env.COUNTER.idFromName(actorId);
    const stub = env.COUNTER.get(id);

    await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });

    const response = await stub.fetch(`http://localhost/api/counter/${actorId}`, {
      headers: { Upgrade: "websocket" },
    });

    expect(response.status).toBe(401);
  });
});
