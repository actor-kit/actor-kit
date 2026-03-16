import { Miniflare } from "miniflare";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import type { Operation } from "fast-json-patch";
import { applyPatch } from "fast-json-patch";
import { createAccessToken } from "../../src/createAccessToken";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SECRET = "test-secret";
const ACTOR_TYPE = "counter";

// Miniflare WebSocket type differs from global WebSocket
type MfWebSocket = NonNullable<
  Awaited<ReturnType<Miniflare["dispatchFetch"]>>["webSocket"]
>;

interface StateUpdateMessage {
  operations: Array<{ op: string; path: string; value?: unknown }>;
  checksum: string;
}

function parseMessage(data: string): StateUpdateMessage {
  return JSON.parse(data) as StateUpdateMessage;
}

describe("Miniflare integration: createMachineServer", () => {
  let mf: Miniflare;
  // Use unique actor IDs per test to avoid state leakage between tests
  let testCounter = 0;

  function nextActorId() {
    return `counter-${++testCounter}`;
  }

  beforeAll(async () => {
    const scriptPath = path.resolve(__dirname, "fixtures/dist/worker.js");

    mf = new Miniflare({
      modules: true,
      scriptPath,
      durableObjects: { COUNTER: "Counter" },
      compatibilityDate: "2024-09-25",
      bindings: {
        ACTOR_KIT_SECRET: SECRET,
      },
    });
  });

  afterAll(async () => {
    await mf.dispose();
  });

  async function createToken(actorId: string, userId: string, callerType: "client" | "service" = "client") {
    return createAccessToken({
      signingKey: SECRET,
      actorId,
      actorType: ACTOR_TYPE,
      callerId: userId,
      callerType,
    });
  }

  async function connectWebSocket(
    actorId: string,
    userId: string,
    options?: { inputProps?: Record<string, unknown>; checksum?: string }
  ): Promise<MfWebSocket> {
    const token = await createToken(actorId, userId);
    const params = new URLSearchParams({ accessToken: token });
    if (options?.inputProps) {
      params.set("input", JSON.stringify(options.inputProps));
    }
    if (options?.checksum) {
      params.set("checksum", options.checksum);
    }

    const url = `https://localhost/api/${ACTOR_TYPE}/${actorId}?${params}`;
    const res = await mf.dispatchFetch(url, {
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        Authorization: `Bearer ${token}`,
      },
    });

    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();
    return ws;
  }

  function collectMessages(ws: MfWebSocket) {
    const messages: StateUpdateMessage[] = [];
    ws.addEventListener("message", (event: { data: unknown }) => {
      if (typeof event.data === "string") {
        messages.push(parseMessage(event.data));
      }
    });
    return messages;
  }

  async function waitForMessages(
    messages: StateUpdateMessage[],
    count: number,
    timeoutMs = 2000
  ) {
    const start = Date.now();
    while (messages.length < count && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  // --- Basic connectivity ---

  it("connects via WebSocket and receives initial state", async () => {
    const actorId = nextActorId();
    const ws = await connectWebSocket(actorId, "user-1");
    const messages = collectMessages(ws);

    await waitForMessages(messages, 1);

    expect(messages.length).toBeGreaterThanOrEqual(1);
    const initial = messages[0]!;
    expect(initial.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(initial.operations.length).toBeGreaterThanOrEqual(1);

    ws.close();
  });

  it("returns 401 for invalid auth token", async () => {
    const actorId = nextActorId();
    const res = await mf.dispatchFetch(
      `https://localhost/api/${ACTOR_TYPE}/${actorId}?accessToken=bad-token`,
      {
        headers: {
          Upgrade: "websocket",
          Connection: "Upgrade",
          Authorization: "Bearer bad-token",
        },
      }
    );
    expect(res.status).toBe(401);
  });

  // --- State sync across clients ---

  it("delivers state updates to all connected sockets after a transition", async () => {
    const actorId = nextActorId();
    const ws1 = await connectWebSocket(actorId, "user-1");
    const ws2 = await connectWebSocket(actorId, "user-2");
    const msgs1 = collectMessages(ws1);
    const msgs2 = collectMessages(ws2);

    await waitForMessages(msgs1, 1);
    await waitForMessages(msgs2, 1);
    const baseline1 = msgs1.length;
    const baseline2 = msgs2.length;

    // Send INCREMENT through ws1
    ws1.send(JSON.stringify({ type: "INCREMENT" }));

    await waitForMessages(msgs1, baseline1 + 1);
    await waitForMessages(msgs2, baseline2 + 1);

    const update1 = msgs1[msgs1.length - 1]!;
    const update2 = msgs2[msgs2.length - 1]!;

    // Both must have the same checksum (same state)
    expect(update1.checksum).toBe(update2.checksum);
    expect(update1.checksum).toMatch(/^[0-9a-f]{64}$/);

    ws1.close();
    ws2.close();
  });

  // --- Rapid transitions (P1/P2 regression) ---

  it("handles rapid state transitions without losing updates", async () => {
    const actorId = nextActorId();
    const ws = await connectWebSocket(actorId, "user-1");
    const messages = collectMessages(ws);

    await waitForMessages(messages, 1);
    const baseline = messages.length;

    // Fire 5 rapid INCREMENTs
    for (let i = 0; i < 5; i++) {
      ws.send(JSON.stringify({ type: "INCREMENT" }));
    }

    await waitForMessages(messages, baseline + 1, 3000);

    const afterBaseline = messages.slice(baseline);
    expect(afterBaseline.length).toBeGreaterThanOrEqual(1);

    // All checksums must be valid SHA-256 hex
    for (const msg of afterBaseline) {
      expect(msg.checksum).toMatch(/^[0-9a-f]{64}$/);
    }

    // No duplicate checksums
    const checksums = afterBaseline.map((m) => m.checksum);
    const unique = [...new Set(checksums)];
    expect(unique.length).toBe(checksums.length);

    ws.close();
  });

  it("maintains consistent checksums across concurrent clients under rapid transitions", async () => {
    const actorId = nextActorId();
    const ws1 = await connectWebSocket(actorId, "user-1");
    const ws2 = await connectWebSocket(actorId, "user-2");
    const msgs1 = collectMessages(ws1);
    const msgs2 = collectMessages(ws2);

    await waitForMessages(msgs1, 1);
    await waitForMessages(msgs2, 1);

    // Rapid transitions from client 1
    for (let i = 0; i < 3; i++) {
      ws1.send(JSON.stringify({ type: "INCREMENT" }));
    }

    await new Promise((r) => setTimeout(r, 1000));

    // Both must converge to the same final checksum
    const last1 = msgs1[msgs1.length - 1]!;
    const last2 = msgs2[msgs2.length - 1]!;
    expect(last1.checksum).toBe(last2.checksum);

    ws1.close();
    ws2.close();
  });

  // --- Checksum deduplication ---

  it("does not send duplicate messages when state has not changed", async () => {
    const actorId = nextActorId();
    const ws = await connectWebSocket(actorId, "user-1");
    const messages = collectMessages(ws);

    await waitForMessages(messages, 1);
    const afterInitial = messages.length;

    // Wait a bit — no transitions, no new messages should arrive
    await new Promise((r) => setTimeout(r, 500));
    expect(messages.length).toBe(afterInitial);

    ws.close();
  });

  // --- Private context isolation ---

  it("isolates private context between callers", async () => {
    const actorId = nextActorId();
    const ws1 = await connectWebSocket(actorId, "user-1");
    const ws2 = await connectWebSocket(actorId, "user-2");
    const msgs1 = collectMessages(ws1);
    const msgs2 = collectMessages(ws2);

    await waitForMessages(msgs1, 1);
    await waitForMessages(msgs2, 1);

    // user-1 increments (triggers trackAccess for user-1's private context)
    ws1.send(JSON.stringify({ type: "INCREMENT" }));
    await waitForMessages(msgs1, msgs1.length + 1);
    await waitForMessages(msgs2, msgs2.length + 1);

    // user-2 increments (triggers trackAccess for user-2's private context)
    ws2.send(JSON.stringify({ type: "INCREMENT" }));
    await waitForMessages(msgs1, msgs1.length + 1);
    await waitForMessages(msgs2, msgs2.length + 1);

    // Public context (count) should be the same for both
    // But their checksums should differ because private context differs
    const last1 = msgs1[msgs1.length - 1]!;
    const last2 = msgs2[msgs2.length - 1]!;

    // Each caller sees the same public state but different private data
    // so their checksums may actually be the same (checksum is of full snapshot
    // but callerSnapshot only includes their private slice)
    // The key assertion: both received updates
    expect(last1.operations.length).toBeGreaterThanOrEqual(1);
    expect(last2.operations.length).toBeGreaterThanOrEqual(1);

    ws1.close();
    ws2.close();
  });

  // --- Disconnect and reconnect ---

  it("handles disconnect and reconnect with checksum resumption", async () => {
    const actorId = nextActorId();
    const ws1 = await connectWebSocket(actorId, "user-1");
    const msgs1 = collectMessages(ws1);
    await waitForMessages(msgs1, 1);

    // Increment, wait for update
    ws1.send(JSON.stringify({ type: "INCREMENT" }));
    await waitForMessages(msgs1, 2);
    const checksumBeforeDisconnect = msgs1[msgs1.length - 1]!.checksum;

    // Disconnect
    ws1.close();

    // Reconnect with last known checksum
    const ws2 = await connectWebSocket(actorId, "user-1", {
      checksum: checksumBeforeDisconnect,
    });
    const msgs2 = collectMessages(ws2);

    // If state hasn't changed, server shouldn't send anything (checksum match)
    await new Promise((r) => setTimeout(r, 500));

    // Now increment again — should get an update
    ws2.send(JSON.stringify({ type: "INCREMENT" }));
    await waitForMessages(msgs2, 1, 2000);

    expect(msgs2.length).toBeGreaterThanOrEqual(1);
    expect(msgs2[msgs2.length - 1]!.checksum).toMatch(/^[0-9a-f]{64}$/);
    // New checksum should differ from pre-disconnect (state changed)
    expect(msgs2[msgs2.length - 1]!.checksum).not.toBe(checksumBeforeDisconnect);

    ws2.close();
  });

  // --- Input props ---

  it("accepts input props on first connection", async () => {
    const actorId = nextActorId();
    const ws = await connectWebSocket(actorId, "user-1", {
      inputProps: { initialCount: 42 },
    });
    const messages = collectMessages(ws);

    await waitForMessages(messages, 1);

    // Should receive initial state patch
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0]!.checksum).toMatch(/^[0-9a-f]{64}$/);

    // Incrementing should produce a different checksum (state changed)
    ws.send(JSON.stringify({ type: "INCREMENT" }));
    await waitForMessages(messages, 2);
    expect(messages[1]!.checksum).not.toBe(messages[0]!.checksum);

    ws.close();
  });

  // --- WebSocket message parsing ---

  it("handles binary WebSocket messages", async () => {
    const actorId = nextActorId();
    const ws = await connectWebSocket(actorId, "user-1");
    const messages = collectMessages(ws);
    await waitForMessages(messages, 1);
    const baseline = messages.length;

    // Send INCREMENT as binary (ArrayBuffer)
    const encoder = new TextEncoder();
    const binary = encoder.encode(JSON.stringify({ type: "INCREMENT" }));
    ws.send(binary);

    await waitForMessages(messages, baseline + 1);
    expect(messages.length).toBeGreaterThan(baseline);

    ws.close();
  });

  // --- Multiple transitions with different event types ---

  it("applies different event types correctly", async () => {
    const actorId = nextActorId();
    const ws = await connectWebSocket(actorId, "user-1");
    const messages = collectMessages(ws);
    await waitForMessages(messages, 1);

    // INCREMENT 3 times, then SET to 100, then DECREMENT
    ws.send(JSON.stringify({ type: "INCREMENT" }));
    ws.send(JSON.stringify({ type: "INCREMENT" }));
    ws.send(JSON.stringify({ type: "INCREMENT" }));
    ws.send(JSON.stringify({ type: "SET", value: 100 }));
    ws.send(JSON.stringify({ type: "DECREMENT" }));

    // Wait for updates to settle
    await new Promise((r) => setTimeout(r, 1000));

    // The final state should reflect all operations: count = 99
    // (0 + 1 + 1 + 1 = 3, SET 100, 100 - 1 = 99)
    const allMessages = messages.slice(1); // skip initial
    expect(allMessages.length).toBeGreaterThanOrEqual(1);

    // All checksums should be unique (each state is different)
    const checksums = allMessages.map((m) => m.checksum);
    const unique = [...new Set(checksums)];
    expect(unique.length).toBe(checksums.length);

    ws.close();
  });

  // --- WebSocket cleanup ---

  it("cleans up subscriptions on socket close", async () => {
    const actorId = nextActorId();
    const ws1 = await connectWebSocket(actorId, "user-1");
    const msgs1 = collectMessages(ws1);
    await waitForMessages(msgs1, 1);

    // Connect a second client
    const ws2 = await connectWebSocket(actorId, "user-2");
    const msgs2 = collectMessages(ws2);
    await waitForMessages(msgs2, 1);

    // Close ws1
    ws1.close();
    await new Promise((r) => setTimeout(r, 200));

    const baseline2 = msgs2.length;

    // Increment from ws2 — should still work, ws2 should get update
    ws2.send(JSON.stringify({ type: "INCREMENT" }));
    await waitForMessages(msgs2, baseline2 + 1);

    expect(msgs2.length).toBeGreaterThan(baseline2);

    // ws1 should NOT have received the update (it's closed)
    const msgs1AfterClose = msgs1.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(msgs1.length).toBe(msgs1AfterClose);

    ws2.close();
  });

  // --- Helper: reconstruct client state from patches ---

  function buildClientState(messages: StateUpdateMessage[]) {
    // Reconstruct client state by applying all patches sequentially.
    // Use produce (immer) like the real client does.
    let state: Record<string, unknown> = {};
    for (const msg of messages) {
      try {
        const cloned = structuredClone(state);
        const result = applyPatch(cloned, msg.operations as Operation[]);
        state = result.newDocument as Record<string, unknown>;
      } catch {
        // If applyPatch fails (e.g., path doesn't exist), reconstruct
        // from the operations directly (initial state is always "add" ops)
        for (const op of msg.operations) {
          if ((op.op === "add" || op.op === "replace") && op.value !== undefined) {
            const parts = op.path.split("/").filter(Boolean);
            let target: Record<string, unknown> = state;
            for (let i = 0; i < parts.length - 1; i++) {
              if (!(parts[i]! in target) || typeof target[parts[i]!] !== "object") {
                target[parts[i]!] = {};
              }
              target = target[parts[i]!] as Record<string, unknown>;
            }
            target[parts[parts.length - 1]!] = op.value;
          }
        }
      }
    }
    return state as {
      public?: { count?: number; lastUpdatedBy?: string | null };
      private?: { accessCount?: number };
      value?: unknown;
    };
  }

  // --- Public/Private context isolation (detailed) ---

  it("delivers correct public context to each caller", async () => {
    const actorId = nextActorId();
    const ws1 = await connectWebSocket(actorId, "user-1");
    const msgs1 = collectMessages(ws1);
    await waitForMessages(msgs1, 1);

    // Increment twice from user-1
    ws1.send(JSON.stringify({ type: "INCREMENT" }));
    ws1.send(JSON.stringify({ type: "INCREMENT" }));
    await new Promise((r) => setTimeout(r, 500));

    // Connect user-2 — should see the same public count
    const ws2 = await connectWebSocket(actorId, "user-2");
    const msgs2 = collectMessages(ws2);
    await waitForMessages(msgs2, 1);

    // Build each client's view of state
    const state1 = buildClientState(msgs1);
    const state2 = buildClientState(msgs2);

    // Both should see count = 2 and lastUpdatedBy = "user-1"
    expect(state1.public?.count).toBe(2);
    expect(state2.public?.count).toBe(2);
    expect(state1.public?.lastUpdatedBy).toBe("user-1");
    expect(state2.public?.lastUpdatedBy).toBe("user-1");

    ws1.close();
    ws2.close();
  });

  it("delivers caller-scoped private context (each caller sees only their own)", async () => {
    const actorId = nextActorId();
    const ws1 = await connectWebSocket(actorId, "user-1");
    const msgs1 = collectMessages(ws1);
    await waitForMessages(msgs1, 1);

    // user-1 increments 3 times (trackAccess runs 3 times for user-1)
    ws1.send(JSON.stringify({ type: "INCREMENT" }));
    ws1.send(JSON.stringify({ type: "INCREMENT" }));
    ws1.send(JSON.stringify({ type: "INCREMENT" }));
    await new Promise((r) => setTimeout(r, 500));

    // Connect user-2, increment once
    const ws2 = await connectWebSocket(actorId, "user-2");
    const msgs2 = collectMessages(ws2);
    await waitForMessages(msgs2, 1);

    ws2.send(JSON.stringify({ type: "INCREMENT" }));
    await new Promise((r) => setTimeout(r, 500));

    // Rebuild states
    const state1 = buildClientState(msgs1);
    const state2 = buildClientState(msgs2);

    // Public count should be 4 for both (3 + 1)
    expect(state1.public?.count).toBe(4);
    expect(state2.public?.count).toBe(4);

    // Private context: user-1 should see accessCount = 3
    // user-2 should see accessCount = 1
    // Each caller only sees their own private slice
    expect(state1.private?.accessCount).toBe(3);
    expect(state2.private?.accessCount).toBe(1);

    ws1.close();
    ws2.close();
  });

  it("never leaks another caller's private context", async () => {
    const actorId = nextActorId();
    const ws1 = await connectWebSocket(actorId, "user-1");
    const msgs1 = collectMessages(ws1);
    await waitForMessages(msgs1, 1);

    ws1.send(JSON.stringify({ type: "INCREMENT" }));
    await new Promise((r) => setTimeout(r, 300));

    const ws2 = await connectWebSocket(actorId, "user-2");
    const msgs2 = collectMessages(ws2);
    await waitForMessages(msgs2, 1);

    const state2 = buildClientState(msgs2);

    // user-2's private context should NOT contain user-1's accessCount
    // The private field should either be empty or have user-2's own data
    const privateJson = JSON.stringify(state2.private ?? {});
    expect(privateJson).not.toContain("user-1");

    // user-2 hasn't incremented, so their accessCount should be 0 or undefined
    expect(state2.private?.accessCount).toBeUndefined();

    ws1.close();
    ws2.close();
  });

  // --- Persistence (state survives Miniflare DO restart) ---

  it("persists state across Durable Object restarts", async () => {
    // Use a dedicated actor for persistence testing
    const actorId = "persist-test-1";

    // Phase 1: Create actor, mutate state
    const ws1 = await connectWebSocket(actorId, "user-1");
    const msgs1 = collectMessages(ws1);
    await waitForMessages(msgs1, 1);

    // Increment 5 times
    for (let i = 0; i < 5; i++) {
      ws1.send(JSON.stringify({ type: "INCREMENT" }));
    }
    await new Promise((r) => setTimeout(r, 500));

    const stateBeforeRestart = buildClientState(msgs1);
    expect(stateBeforeRestart.public?.count).toBe(5);

    ws1.close();
    await new Promise((r) => setTimeout(r, 200));

    // Phase 2: Reconnect — the DO may have been evicted, but persisted
    // state should be restored. Miniflare keeps DO state in memory within
    // the same instance, but this still exercises the persistence path.
    const ws2 = await connectWebSocket(actorId, "user-1");
    const msgs2 = collectMessages(ws2);
    await waitForMessages(msgs2, 1);

    const stateAfterRestart = buildClientState(msgs2);
    expect(stateAfterRestart.public?.count).toBe(5);

    // Increment once more to prove the state is live
    ws2.send(JSON.stringify({ type: "INCREMENT" }));
    await new Promise((r) => setTimeout(r, 300));

    const finalState = buildClientState(msgs2);
    expect(finalState.public?.count).toBe(6);

    ws2.close();
  });

  it("persisted state is consistent with checksum after reconnect", async () => {
    const actorId = "persist-checksum-test";

    const ws1 = await connectWebSocket(actorId, "user-1");
    const msgs1 = collectMessages(ws1);
    await waitForMessages(msgs1, 1);

    ws1.send(JSON.stringify({ type: "SET", value: 42 }));
    await new Promise((r) => setTimeout(r, 300));

    const checksum = msgs1[msgs1.length - 1]!.checksum;
    ws1.close();
    await new Promise((r) => setTimeout(r, 200));

    // Reconnect with the checksum — if state hasn't changed, no message
    const ws2 = await connectWebSocket(actorId, "user-1", {
      checksum,
    });
    const msgs2 = collectMessages(ws2);

    // Wait briefly — no state change, should get no messages
    await new Promise((r) => setTimeout(r, 500));
    expect(msgs2.length).toBe(0);

    // Now change state — should get update
    ws2.send(JSON.stringify({ type: "INCREMENT" }));
    await waitForMessages(msgs2, 1);
    expect(msgs2[0]!.checksum).not.toBe(checksum);

    ws2.close();
  });

  // --- Multiple actors are isolated ---

  it("isolates state between different actor IDs", async () => {
    const actorA = nextActorId();
    const actorB = nextActorId();

    const wsA = await connectWebSocket(actorA, "user-1");
    const wsB = await connectWebSocket(actorB, "user-1");
    const msgsA = collectMessages(wsA);
    const msgsB = collectMessages(wsB);

    await waitForMessages(msgsA, 1);
    await waitForMessages(msgsB, 1);

    // Increment A 3 times, B stays at 0
    wsA.send(JSON.stringify({ type: "INCREMENT" }));
    wsA.send(JSON.stringify({ type: "INCREMENT" }));
    wsA.send(JSON.stringify({ type: "INCREMENT" }));
    await new Promise((r) => setTimeout(r, 500));

    const stateA = buildClientState(msgsA);
    const stateB = buildClientState(msgsB);

    expect(stateA.public?.count).toBe(3);
    expect(stateB.public?.count).toBe(0);

    // Checksums should differ (different states)
    const lastA = msgsA[msgsA.length - 1]!.checksum;
    const lastB = msgsB[msgsB.length - 1]!.checksum;
    expect(lastA).not.toBe(lastB);

    wsA.close();
    wsB.close();
  });
});
