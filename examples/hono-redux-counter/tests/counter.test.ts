/**
 * Workers integration tests for redux-counter example.
 * Uses SELF.fetch against the Hono app with JWT auth.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createAccessToken } from "../../../packages/core/src/auth";

const SECRET = "test-secret-for-redux-counter";

async function getClientToken(actorId: string, callerId = "user-1") {
  return createAccessToken({
    signingKey: SECRET,
    actorId,
    actorType: "counter",
    callerId,
    callerType: "client",
  });
}

async function getServiceToken(actorId: string, callerId = "admin") {
  return createAccessToken({
    signingKey: SECRET,
    actorId,
    actorType: "counter",
    callerId,
    callerType: "service",
  });
}

describe("redux-counter: routes", () => {
  it("GET / returns 200 with API description", async () => {
    const res = await SELF.fetch("http://localhost/");
    expect(res.status).toBe(200);
    const body = await res.json<{ name: string }>();
    expect(body.name).toBe("hono-redux-counter");
  });

  it("POST /token returns a JWT", async () => {
    const res = await SELF.fetch("http://localhost/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: "t1", callerId: "user-1", callerType: "client" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ token: string }>();
    expect(body.token).toBeTruthy();
    expect(body.token.split(".")).toHaveLength(3);
  });
});

describe("redux-counter: auth", () => {
  it("GET /counter/:id returns 401 without auth", async () => {
    const res = await SELF.fetch("http://localhost/counter/auth-1");
    expect(res.status).toBe(401);
  });

  it("POST /counter/:id/increment returns 401 without auth", async () => {
    const res = await SELF.fetch("http://localhost/counter/auth-2/increment", { method: "POST" });
    expect(res.status).toBe(401);
  });
});

describe("redux-counter: counter operations", () => {
  it("GET /counter/:id returns initial snapshot", async () => {
    const token = await getClientToken("op-1");
    const res = await SELF.fetch("http://localhost/counter/op-1", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ snapshot: { count: number; myAccessCount: number }; checksum: string }>();
    expect(body.snapshot.count).toBe(0);
    expect(body.snapshot.myAccessCount).toBe(0);
    expect(body.checksum).toBeTruthy();
  });

  it("POST increment increases count", async () => {
    const token = await getClientToken("op-2");
    await SELF.fetch("http://localhost/counter/op-2", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const res = await SELF.fetch("http://localhost/counter/op-2/increment", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ snapshot: { count: number } }>();
    expect(body.snapshot.count).toBe(1);
  });

  it("POST decrement decreases count", async () => {
    const token = await getClientToken("op-3");
    await SELF.fetch("http://localhost/counter/op-3", {
      headers: { Authorization: `Bearer ${token}` },
    });
    await SELF.fetch("http://localhost/counter/op-3/increment", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const res = await SELF.fetch("http://localhost/counter/op-3/decrement", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ snapshot: { count: number } }>();
    expect(body.snapshot.count).toBe(0);
  });

  it("RESET requires service caller", async () => {
    const clientToken = await getClientToken("op-4");
    const serviceToken = await getServiceToken("op-4");

    await SELF.fetch("http://localhost/counter/op-4", {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    await SELF.fetch("http://localhost/counter/op-4/increment", {
      method: "POST",
      headers: { Authorization: `Bearer ${clientToken}` },
    });

    // Client reset — should be rejected with 403
    const clientResetRes = await SELF.fetch("http://localhost/counter/op-4/reset", {
      method: "POST",
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    expect(clientResetRes.status).toBe(403);

    // Service reset — should reset
    const serviceResetRes = await SELF.fetch("http://localhost/counter/op-4/reset", {
      method: "POST",
      headers: { Authorization: `Bearer ${serviceToken}` },
    });
    const afterServiceReset = await serviceResetRes.json<{ snapshot: { count: number } }>();
    expect(afterServiceReset.snapshot.count).toBe(0);
  });

  it("tracks per-caller access counts", async () => {
    const token1 = await getClientToken("op-5", "user-1");
    const token2 = await getClientToken("op-5", "user-2");

    await SELF.fetch("http://localhost/counter/op-5", {
      headers: { Authorization: `Bearer ${token1}` },
    });
    await SELF.fetch("http://localhost/counter/op-5/increment", {
      method: "POST",
      headers: { Authorization: `Bearer ${token1}` },
    });
    await SELF.fetch("http://localhost/counter/op-5/increment", {
      method: "POST",
      headers: { Authorization: `Bearer ${token1}` },
    });
    await SELF.fetch("http://localhost/counter/op-5/increment", {
      method: "POST",
      headers: { Authorization: `Bearer ${token2}` },
    });

    const res1 = await SELF.fetch("http://localhost/counter/op-5", {
      headers: { Authorization: `Bearer ${token1}` },
    });
    const body1 = await res1.json<{ snapshot: { count: number; myAccessCount: number } }>();
    expect(body1.snapshot.count).toBe(3);
    expect(body1.snapshot.myAccessCount).toBe(2);

    const res2 = await SELF.fetch("http://localhost/counter/op-5", {
      headers: { Authorization: `Bearer ${token2}` },
    });
    const body2 = await res2.json<{ snapshot: { count: number; myAccessCount: number } }>();
    expect(body2.snapshot.count).toBe(3);
    expect(body2.snapshot.myAccessCount).toBe(1);
  });
});
