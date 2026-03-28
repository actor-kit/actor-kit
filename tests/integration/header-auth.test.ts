import { env } from "cloudflare:test";
import { decode, FrameType, parseFrame, schema, string, uint32 } from "@actor-kit/core";
import { createAccessToken } from "@actor-kit/worker";
import { describe, expect, it } from "vitest";

const SECRET = "test-secret-for-integration-tests-only";
const CounterView = schema({ count: uint32, lastCaller: string });

function getStub(name: string) {
  const id = env.COUNTER.idFromName(name);
  return { stub: env.COUNTER.get(id), actorId: name };
}

function waitForBinaryMessage(ws: WebSocket): Promise<ArrayBuffer> {
  return new Promise<ArrayBuffer>((resolve) => {
    ws.addEventListener(
      "message",
      (event) => {
        if (event.data instanceof ArrayBuffer) {
          resolve(event.data);
        } else if (typeof event.data === "string") {
          resolve(new TextEncoder().encode(event.data).buffer);
        }
      },
      { once: true },
    );
  });
}

describe("Header-based auth (Worker-trust model)", () => {
  it("accepts WebSocket with identity headers (no token)", async () => {
    const { stub, actorId } = getStub("hdr-auth-ok");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    const response = await stub.fetch(`http://localhost/api/counter/${actorId}`, {
      headers: {
        Upgrade: "websocket",
        "X-Actor-Kit-Caller-Id": "u1",
        "X-Actor-Kit-Caller-Type": "user",
      },
    });
    expect(response.status).toBe(101);

    if (response.webSocket) {
      response.webSocket.accept();
      response.webSocket.close(1000);
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  it("rejects WebSocket when caller ID header is missing", async () => {
    const { stub, actorId } = getStub("hdr-auth-no-id");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    const response = await stub.fetch(`http://localhost/api/counter/${actorId}`, {
      headers: {
        Upgrade: "websocket",
        "X-Actor-Kit-Caller-Type": "user",
      },
    });
    expect(response.status).toBe(401);
  });

  it("rejects WebSocket when caller type header is missing", async () => {
    const { stub, actorId } = getStub("hdr-auth-no-type");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    const response = await stub.fetch(`http://localhost/api/counter/${actorId}`, {
      headers: {
        Upgrade: "websocket",
        "X-Actor-Kit-Caller-Id": "u1",
      },
    });
    expect(response.status).toBe(401);
  });

  it("rejects WebSocket when caller type is invalid", async () => {
    const { stub, actorId } = getStub("hdr-auth-bad-type");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    const response = await stub.fetch(`http://localhost/api/counter/${actorId}`, {
      headers: {
        Upgrade: "websocket",
        "X-Actor-Kit-Caller-Id": "u1",
        "X-Actor-Kit-Caller-Type": "admin",
      },
    });
    expect(response.status).toBe(401);
  });

  it("receives correct binary snapshot after header auth", async () => {
    const { stub, actorId } = getStub("hdr-auth-snapshot");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    const response = await stub.fetch(`http://localhost/api/counter/${actorId}`, {
      headers: {
        Upgrade: "websocket",
        "X-Actor-Kit-Caller-Id": "u1",
        "X-Actor-Kit-Caller-Type": "user",
      },
    });
    expect(response.status).toBe(101);

    const ws = response.webSocket!;
    ws.accept();

    const data = await waitForBinaryMessage(ws);
    const frame = parseFrame(new Uint8Array(data));
    expect(frame.type).toBe(FrameType.SNAPSHOT);

    const view = decode(CounterView, frame.payload);
    expect(view).toEqual({ count: 0, lastCaller: "" });

    ws.close(1000, "done");
    await new Promise((r) => setTimeout(r, 50));
  });

  it("resolves correct role from header-based identity", async () => {
    const { stub, actorId } = getStub("hdr-auth-role");
    await stub.spawn({ actorId, caller: "svc1", callerType: "service", input: {} });

    // Connect as service → should get admin role
    const response = await stub.fetch(`http://localhost/api/counter/${actorId}`, {
      headers: {
        Upgrade: "websocket",
        "X-Actor-Kit-Caller-Id": "svc1",
        "X-Actor-Kit-Caller-Type": "service",
      },
    });
    expect(response.status).toBe(101);

    const ws = response.webSocket!;
    ws.accept();

    // Send DECREMENT (admin-only) — should succeed
    await waitForBinaryMessage(ws); // consume snapshot
    ws.send(JSON.stringify({ type: "DECREMENT", amount: 1 }));

    // Wait for delta frame (success means handler ran)
    const deltaData = await waitForBinaryMessage(ws);
    const deltaFrame = parseFrame(new Uint8Array(deltaData));
    expect(deltaFrame.type).toBe(FrameType.DELTA);

    ws.close(1000, "done");
    await new Promise((r) => setTimeout(r, 50));
  });

  it("prefers identity headers over token subprotocol", async () => {
    const { stub, actorId } = getStub("hdr-auth-priority");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    // Create a token for a different caller
    const token = await createAccessToken({
      actorType: "counter",
      actorId,
      callerId: "other-user",
      callerType: "user",
      secret: SECRET,
    });

    // Send both headers AND token — headers should win
    const response = await stub.fetch(`http://localhost/api/counter/${actorId}`, {
      headers: {
        Upgrade: "websocket",
        "X-Actor-Kit-Caller-Id": "u1",
        "X-Actor-Kit-Caller-Type": "user",
        "Sec-WebSocket-Protocol": `token.${token}`,
      },
    });
    expect(response.status).toBe(101);

    const ws = response.webSocket!;
    ws.accept();

    // Send INCREMENT, then check snapshot — lastCaller should be "u1" (from headers), not "other-user" (from token)
    await waitForBinaryMessage(ws);
    ws.send(JSON.stringify({ type: "INCREMENT", amount: 1 }));
    await waitForBinaryMessage(ws); // consume delta

    ws.close(1000, "done");
    await new Promise((r) => setTimeout(r, 50));

    // Verify via getSnapshot that caller was "u1"
    const snap = await stub.getSnapshot("u1", "user");
    expect(snap.snapshot.lastCaller).toBe("u1");
  });

  it("falls back to token when identity headers are absent", async () => {
    const { stub, actorId } = getStub("hdr-auth-fallback");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    const token = await createAccessToken({
      actorType: "counter",
      actorId,
      callerId: "u1",
      callerType: "user",
      secret: SECRET,
    });

    // No identity headers, only token subprotocol — should still work (backward compat)
    const response = await stub.fetch(`http://localhost/api/counter/${actorId}`, {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": `token.${token}`,
      },
    });
    expect(response.status).toBe(101);

    if (response.webSocket) {
      response.webSocket.accept();
      response.webSocket.close(1000);
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  it("returns 401 when neither headers nor token provided", async () => {
    const { stub, actorId } = getStub("hdr-auth-none");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    const response = await stub.fetch(`http://localhost/api/counter/${actorId}`, {
      headers: {
        Upgrade: "websocket",
      },
    });
    expect(response.status).toBe(401);
  });
});
