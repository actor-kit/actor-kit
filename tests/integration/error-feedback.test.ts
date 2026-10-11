import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Error feedback via WebSocket (integration)", () => {
  it("sends __error frame when message is rejected (wrong role)", async () => {
    const actorId = `error-fb-1-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const id = env.COUNTER.idFromName(actorId);
    const stub = env.COUNTER.get(id);
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    const response = await stub.fetch(`http://localhost/api/counter/${actorId}`, {
      headers: {
        Upgrade: "websocket",
        "X-Actor-Kit-Caller-Id": "u1",
        "X-Actor-Kit-Caller-Type": "user",
      },
    });

    const ws = response.webSocket;

    if (ws === null) throw new Error("expected a WebSocket upgrade");
    ws.accept();

    // Consume initial snapshot
    await new Promise<void>((resolve) => {
      ws.addEventListener("message", () => resolve(), { once: true });
    });

    // Send RESET — user role can't do this (guard rejects non-admin)
    ws.send(JSON.stringify({ type: "RESET" }));

    // Should receive __error frame
    const errorMsg = await new Promise<string>((resolve) => {
      ws.addEventListener(
        "message",
        (event) => {
          if (typeof event.data === "string") resolve(event.data);
          else resolve("");
        },
        { once: true },
      );
    });

    const parsed = JSON.parse(errorMsg);
    expect(parsed.type).toBe("__error");
    expect(parsed.code).toBe("guard_failed");

    ws.close(1000);
    await new Promise((r) => setTimeout(r, 50));
  });

  it("sends __error frame for invalid payload", async () => {
    const actorId = `error-fb-2-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const id = env.COUNTER.idFromName(actorId);
    const stub = env.COUNTER.get(id);
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    const response = await stub.fetch(`http://localhost/api/counter/${actorId}`, {
      headers: {
        Upgrade: "websocket",
        "X-Actor-Kit-Caller-Id": "u1",
        "X-Actor-Kit-Caller-Type": "user",
      },
    });

    const ws = response.webSocket;

    if (ws === null) throw new Error("expected a WebSocket upgrade");
    ws.accept();

    // Consume initial snapshot
    await new Promise<void>((resolve) => {
      ws.addEventListener("message", () => resolve(), { once: true });
    });

    // Send INCREMENT with negative amount (Zod rejects)
    ws.send(JSON.stringify({ type: "INCREMENT", amount: -5 }));

    const errorMsg = await new Promise<string>((resolve) => {
      ws.addEventListener(
        "message",
        (event) => {
          if (typeof event.data === "string") resolve(event.data);
          else resolve("");
        },
        { once: true },
      );
    });

    const parsed = JSON.parse(errorMsg);
    expect(parsed.type).toBe("__error");
    expect(parsed.code).toBe("invalid_payload");

    ws.close(1000);
    await new Promise((r) => setTimeout(r, 50));
  });
});
