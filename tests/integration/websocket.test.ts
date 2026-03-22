import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createAccessToken } from "../../packages/actor-kit/src/auth/auth";

const SECRET = "test-secret-for-integration-tests-only";

describe("Counter DO WebSocket", () => {
  it("connects via WebSocket and receives initial snapshot", async () => {
    const id = env.COUNTER.idFromName("ws-test-1");
    const stub = env.COUNTER.get(id);

    // First spawn the actor
    await stub.spawn({ caller: "user-1", callerType: "user", input: {} });

    // Create JWT for WebSocket auth
    const token = await createAccessToken({
      actorType: "counter",
      actorId: "ws-test-1",
      callerId: "user-1",
      callerType: "user",
      secret: SECRET,
    });

    // Connect via WebSocket
    const response = await stub.fetch("http://localhost/api/counter/ws-test-1", {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": `token.${token}`,
      },
    });

    expect(response.status).toBe(101);
    expect(response.webSocket).toBeDefined();

    const ws = response.webSocket!;
    ws.accept();

    // Should receive initial snapshot
    const message = await new Promise<string>((resolve) => {
      ws.addEventListener("message", (event) => {
        resolve(event.data as string);
      });
    });

    const parsed = JSON.parse(message);
    expect(parsed.type).toBe("snapshot");
    expect(parsed.role).toBe("user");
    expect(parsed.data).toEqual({ count: 0, lastCaller: "" });

    ws.close();
  });

  it("receives view updates after sending messages", async () => {
    const id = env.COUNTER.idFromName("ws-test-2");
    const stub = env.COUNTER.get(id);

    await stub.spawn({ caller: "user-1", callerType: "user", input: {} });

    const token = await createAccessToken({
      actorType: "counter",
      actorId: "ws-test-2",
      callerId: "user-1",
      callerType: "user",
      secret: SECRET,
    });

    const response = await stub.fetch("http://localhost/api/counter/ws-test-2", {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": `token.${token}`,
      },
    });

    const ws = response.webSocket!;
    ws.accept();

    // Consume initial snapshot
    await new Promise<void>((resolve) => {
      ws.addEventListener("message", () => resolve(), { once: true });
    });

    // Send INCREMENT via WebSocket
    ws.send(JSON.stringify({ type: "INCREMENT", amount: 7 }));

    // Should receive updated view
    const update = await new Promise<string>((resolve) => {
      ws.addEventListener("message", (event) => {
        resolve(event.data as string);
      });
    });

    const parsed = JSON.parse(update);
    expect(parsed.type).toBe("snapshot");
    expect(parsed.data.count).toBe(7);

    ws.close();
  });

  it("rejects WebSocket without auth token", async () => {
    const id = env.COUNTER.idFromName("ws-test-noauth");
    const stub = env.COUNTER.get(id);

    await stub.spawn({ caller: "user-1", callerType: "user", input: {} });

    const response = await stub.fetch("http://localhost/api/counter/ws-test-noauth", {
      headers: {
        Upgrade: "websocket",
      },
    });

    expect(response.status).toBe(401);
  });
});
