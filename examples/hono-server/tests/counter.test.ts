/**
 * Workers integration tests for the Hono + actor-kit example.
 *
 * Runs inside the Workers runtime via @cloudflare/vitest-pool-workers.
 * Tests the full Hono route → DO RPC → state machine → response flow.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Helper: get an access token from the /token endpoint
async function getToken(
  counterId: string,
  userId: string,
  callerType: "client" | "service" = "client"
) {
  const res = await SELF.fetch("http://localhost/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ counterId, userId, callerType }),
  });
  const body = (await res.json()) as { token: string };
  return body.token;
}

// Helper: make an authenticated request
function authedFetch(url: string, token: string, options?: RequestInit) {
  return SELF.fetch(url, {
    ...options,
    headers: {
      ...options?.headers,
      Authorization: `Bearer ${token}`,
    },
  });
}

type SnapshotResponse = {
  snapshot: {
    public: { count: number; lastUpdatedBy: string | null };
    private: { accessCount?: number };
    value: unknown;
  };
  checksum: string;
};

describe("Hono counter API", () => {
  it("GET / returns endpoint list", async () => {
    const res = await SELF.fetch("http://localhost/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { endpoints: Record<string, string> };
    expect(body.endpoints).toHaveProperty("GET /counter/:id");
  });

  it("POST /token returns a valid JWT", async () => {
    const token = await getToken("test-1", "user-1");
    expect(token).toBeTruthy();
    expect(token.split(".")).toHaveLength(3); // JWT format
  });

  it("returns 401 without auth", async () => {
    const res = await SELF.fetch("http://localhost/counter/test-2");
    expect(res.status).toBe(401);
  });

  it("GET /counter/:id returns initial snapshot", async () => {
    const token = await getToken("test-3", "user-1");
    const res = await authedFetch("http://localhost/counter/test-3", token);
    expect(res.status).toBe(200);

    const body = (await res.json()) as SnapshotResponse;
    expect(body.snapshot.public.count).toBe(0);
    expect(body.snapshot.public.lastUpdatedBy).toBeNull();
    expect(body.checksum).toBeTruthy();
  });

  it("POST /counter/:id/increment increases count", async () => {
    const token = await getToken("test-4", "user-1");

    const res = await authedFetch(
      "http://localhost/counter/test-4/increment",
      token,
      { method: "POST" }
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as SnapshotResponse;
    expect(body.snapshot.public.count).toBe(1);
    expect(body.snapshot.public.lastUpdatedBy).toBe("user-1");
  });

  it("POST /counter/:id/decrement decreases count", async () => {
    const token = await getToken("test-5", "user-1");

    // Increment first
    await authedFetch("http://localhost/counter/test-5/increment", token, {
      method: "POST",
    });
    await authedFetch("http://localhost/counter/test-5/increment", token, {
      method: "POST",
    });

    // Then decrement
    const res = await authedFetch(
      "http://localhost/counter/test-5/decrement",
      token,
      { method: "POST" }
    );
    const body = (await res.json()) as SnapshotResponse;
    expect(body.snapshot.public.count).toBe(1);
  });

  it("tracks per-caller private context", async () => {
    const token = await getToken("test-6", "user-1");

    await authedFetch("http://localhost/counter/test-6/increment", token, {
      method: "POST",
    });
    await authedFetch("http://localhost/counter/test-6/increment", token, {
      method: "POST",
    });

    const res = await authedFetch("http://localhost/counter/test-6", token);
    const body = (await res.json()) as SnapshotResponse;
    expect(body.snapshot.private.accessCount).toBe(2);
  });

  it("different callers see their own private context", async () => {
    const token1 = await getToken("test-7", "user-1");
    const token2 = await getToken("test-7", "user-2");

    // User 1 increments 3 times
    for (let i = 0; i < 3; i++) {
      await authedFetch("http://localhost/counter/test-7/increment", token1, {
        method: "POST",
      });
    }

    // User 2 increments once
    await authedFetch("http://localhost/counter/test-7/increment", token2, {
      method: "POST",
    });

    // User 1 sees accessCount=3
    const res1 = await authedFetch("http://localhost/counter/test-7", token1);
    const body1 = (await res1.json()) as SnapshotResponse;
    expect(body1.snapshot.private.accessCount).toBe(3);
    expect(body1.snapshot.public.count).toBe(4); // shared

    // User 2 sees accessCount=1
    const res2 = await authedFetch("http://localhost/counter/test-7", token2);
    const body2 = (await res2.json()) as SnapshotResponse;
    expect(body2.snapshot.private.accessCount).toBe(1);
    expect(body2.snapshot.public.count).toBe(4); // same shared state
  });

  it("POST /counter/:id/reset requires service caller", async () => {
    const clientToken = await getToken("test-8", "user-1");
    const serviceToken = await getToken("test-8", "admin", "service");

    // Increment first
    await authedFetch("http://localhost/counter/test-8/increment", clientToken, {
      method: "POST",
    });

    // Client can't reset
    const failRes = await authedFetch(
      "http://localhost/counter/test-8/reset",
      clientToken,
      { method: "POST" }
    );
    expect(failRes.status).toBe(403);

    // Service can reset
    const okRes = await authedFetch(
      "http://localhost/counter/test-8/reset",
      serviceToken,
      { method: "POST" }
    );
    expect(okRes.status).toBe(200);
    const body = (await okRes.json()) as SnapshotResponse;
    expect(body.snapshot.public.count).toBe(0);
  });
});

describe("WebSocket", () => {
  it("upgrades to WebSocket and receives state patches", async () => {
    const token = await getToken("ws-test-1", "user-1");

    // Spawn the actor first via GET
    await authedFetch("http://localhost/counter/ws-test-1", token);

    // Connect WebSocket
    const res = await authedFetch(
      `http://localhost/counter/ws-test-1/ws?accessToken=${token}`,
      token,
      { headers: { Upgrade: "websocket" } }
    );

    expect(res.status).toBe(101);
    expect(res.webSocket).toBeTruthy();

    const ws = res.webSocket!;
    ws.accept();

    // Collect messages
    const messages: string[] = [];
    ws.addEventListener("message", (event) => {
      messages.push(typeof event.data === "string" ? event.data : "");
    });

    // Wait for initial state patch
    await new Promise((r) => setTimeout(r, 500));

    // Increment via HTTP — should trigger a WebSocket patch
    await authedFetch("http://localhost/counter/ws-test-1/increment", token, {
      method: "POST",
    });

    // Wait for the patch to arrive
    await new Promise((r) => setTimeout(r, 500));

    // Should have received at least one message with operations
    expect(messages.length).toBeGreaterThanOrEqual(1);

    const lastMessage = JSON.parse(messages[messages.length - 1]) as {
      operations: unknown[];
      checksum: string;
    };
    expect(lastMessage.operations).toBeDefined();
    expect(lastMessage.checksum).toBeTruthy();

    // Close gracefully — catch expected workerd cleanup error
    try { ws.close(); } catch { /* workerd may already have closed */ }
  });
});
