import { env } from "cloudflare:test";
import { createAccessToken } from "@actor-kit/worker/token";
import { describe, expect, it } from "vitest";

const SECRET = "test-secret-for-integration-tests-only";

function getStub(name: string) {
  const id = env.COUNTER.idFromName(name);
  return { stub: env.COUNTER.get(id), actorId: name };
}

describe("Auth via WebSocket (integration)", () => {
  it("rejects connection without Sec-WebSocket-Protocol", async () => {
    const { stub, actorId } = getStub("auth-no-proto");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    const response = await stub.fetch(`http://localhost/api/counter/${actorId}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(401);
  });

  it("rejects connection with invalid JWT", async () => {
    const { stub, actorId } = getStub("auth-bad-jwt");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    const response = await stub.fetch(`http://localhost/api/counter/${actorId}`, {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": "token.invalid-jwt-string",
      },
    });
    expect(response.status).toBe(401);
  });

  it("rejects connection with JWT for wrong actor", async () => {
    const { stub, actorId } = getStub("auth-wrong-actor");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    // Create token for a different actorId
    const token = await createAccessToken({
      actorType: "counter",
      actorId: "different-actor",
      callerId: "u1",
      callerType: "user",
      secret: SECRET,
    });

    const response = await stub.fetch(`http://localhost/api/counter/${actorId}`, {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": `token.${token}`,
      },
    });
    expect(response.status).toBe(401);
  });

  it("accepts connection with valid JWT", async () => {
    const { stub, actorId } = getStub("auth-valid");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    const token = await createAccessToken({
      actorType: "counter",
      actorId,
      callerId: "u1",
      callerType: "user",
      secret: SECRET,
    });

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

  it("rejects non-websocket requests", async () => {
    const { stub, actorId } = getStub("auth-no-ws");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    const response = await stub.fetch(`http://localhost/api/counter/${actorId}`);
    expect(response.status).toBe(426); // Upgrade Required
  });
});
