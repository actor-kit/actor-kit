import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function getStub(name: string) {
  const id = env.ORIGIN_COUNTER.idFromName(name);
  return { stub: env.ORIGIN_COUNTER.get(id), actorId: name };
}

describe("Origin validation (header-based auth)", () => {
  it("accepts WebSocket when Origin matches allowedOrigins", async () => {
    const { stub, actorId } = getStub("origin-ok");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    const response = await stub.fetch(`http://localhost/api/counter/${actorId}`, {
      headers: {
        Upgrade: "websocket",
        "X-Actor-Kit-Caller-Id": "u1",
        "X-Actor-Kit-Caller-Type": "user",
        Origin: "https://example.com",
      },
    });
    expect(response.status).toBe(101);

    if (response.webSocket) {
      response.webSocket.accept();
      response.webSocket.close(1000);
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  it("accepts WebSocket when Origin matches second allowed origin", async () => {
    const { stub, actorId } = getStub("origin-ok-2");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    const response = await stub.fetch(`http://localhost/api/counter/${actorId}`, {
      headers: {
        Upgrade: "websocket",
        "X-Actor-Kit-Caller-Id": "u1",
        "X-Actor-Kit-Caller-Type": "user",
        Origin: "https://staging.example.com",
      },
    });
    expect(response.status).toBe(101);

    if (response.webSocket) {
      response.webSocket.accept();
      response.webSocket.close(1000);
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  it("rejects WebSocket when Origin does not match allowedOrigins", async () => {
    const { stub, actorId } = getStub("origin-bad");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    const response = await stub.fetch(`http://localhost/api/counter/${actorId}`, {
      headers: {
        Upgrade: "websocket",
        "X-Actor-Kit-Caller-Id": "u1",
        "X-Actor-Kit-Caller-Type": "user",
        Origin: "https://evil.com",
      },
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Origin not allowed");
  });

  it("allows WebSocket when Origin header is absent (non-browser client)", async () => {
    // Non-browser clients (Worker-to-DO, Node) typically omit Origin.
    // Browsers always send Origin on WebSocket upgrades, so absence means non-browser.
    const { stub, actorId } = getStub("origin-missing");
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

  // Token-based auth bypass test omitted: jose crypto context issue in
  // vitest-pool-workers non-isolated mode prevents JWT validation inside DOs.
  // The code path is: token auth → skip Origin check (no CSRF risk, tokens
  // are self-authenticating and browsers can't forge Sec-WebSocket-Protocol).

  it("skips Origin validation when allowedOrigins is not configured", async () => {
    // Use the regular Counter which has no allowedOrigins
    const id = env.COUNTER.idFromName("origin-no-config");
    const stub = env.COUNTER.get(id);
    await stub.spawn({ actorId: "origin-no-config", caller: "u1", callerType: "user", input: {} });

    // No Origin header, no allowedOrigins config — should succeed
    const response = await stub.fetch(`http://localhost/api/counter/origin-no-config`, {
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

  it("rejects with bad Origin even when identity headers are valid", async () => {
    const { stub, actorId } = getStub("origin-valid-headers-bad-origin");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    // Valid identity headers but bad Origin
    const response = await stub.fetch(`http://localhost/api/counter/${actorId}`, {
      headers: {
        Upgrade: "websocket",
        "X-Actor-Kit-Caller-Id": "u1",
        "X-Actor-Kit-Caller-Type": "user",
        Origin: "https://attacker.com",
      },
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Origin not allowed");
  });
});
