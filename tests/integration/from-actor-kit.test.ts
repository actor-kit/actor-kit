/**
 * Integration test: fromActorKit — DO-to-DO communication
 *
 * Tests that an Aggregator DO can invoke a Counter DO via fromActorKit,
 * receive snapshot updates, and forward events bidirectionally.
 *
 * Uses Miniflare with a pre-built worker fixture containing both DOs.
 */
import { Miniflare } from "miniflare";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccessToken } from "../../src/createAccessToken";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET = "test-secret";

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

describe("fromActorKit: DO-to-DO communication", () => {
  let mf: Miniflare;
  let testCounter = 0;

  function nextId(prefix = "test") {
    return `${prefix}-${++testCounter}`;
  }

  beforeAll(async () => {
    const scriptPath = path.resolve(
      __dirname,
      "fixtures/dist/from-actor-kit-worker.js"
    );

    mf = new Miniflare({
      modules: true,
      scriptPath,
      durableObjects: {
        COUNTER: "Counter",
        AGGREGATOR: "Aggregator",
      },
      compatibilityDate: "2024-09-25",
      compatibilityFlags: ["nodejs_compat"],
      bindings: {
        ACTOR_KIT_SECRET: SECRET,
      },
    });
  });

  afterAll(async () => {
    await mf.dispose();
  });

  async function connectWebSocket(
    actorType: string,
    actorId: string,
    userId: string
  ): Promise<MfWebSocket> {
    const token = await createAccessToken({
      signingKey: SECRET,
      actorId,
      actorType,
      callerId: userId,
      callerType: "client",
    });
    const params = new URLSearchParams({ accessToken: token });
    const url = `https://localhost/api/${actorType}/${actorId}?${params}`;
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
    timeoutMs = 3000
  ) {
    const start = Date.now();
    while (messages.length < count && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  function buildClientState(messages: StateUpdateMessage[]) {
    const state: Record<string, unknown> = {};
    for (const msg of messages) {
      for (const op of msg.operations) {
        if (
          (op.op === "add" || op.op === "replace") &&
          op.value !== undefined
        ) {
          const parts = op.path.split("/").filter(Boolean);
          let target: Record<string, unknown> = state;
          for (let i = 0; i < parts.length - 1; i++) {
            if (
              !(parts[i]! in target) ||
              typeof target[parts[i]!] !== "object"
            ) {
              target[parts[i]!] = {};
            }
            target = target[parts[i]!] as Record<string, unknown>;
          }
          target[parts[parts.length - 1]!] = op.value;
        }
      }
    }
    return state as {
      public?: Record<string, unknown>;
      private?: Record<string, unknown>;
      value?: unknown;
    };
  }

  // --- Tests ---

  it("aggregator receives counter updates via fromActorKit", async () => {
    const aggregatorId = nextId("agg");

    // Connect to aggregator — this should trigger it to connect to the counter
    // via fromActorKit
    const aggWs = await connectWebSocket("aggregator", aggregatorId, "user-1");
    const aggMsgs = collectMessages(aggWs);
    await waitForMessages(aggMsgs, 1);

    // The aggregator should have an initial state
    const initialState = buildClientState(aggMsgs);
    expect(initialState.public).toBeDefined();

    aggWs.close();
  });

  it("aggregator forwards INCREMENT to counter and receives updated count", async () => {
    const aggregatorId = nextId("agg");

    // Connect to aggregator
    const aggWs = await connectWebSocket("aggregator", aggregatorId, "user-1");
    const aggMsgs = collectMessages(aggWs);
    await waitForMessages(aggMsgs, 1);

    // Send INCREMENT_COUNTER to aggregator — it should forward to counter
    aggWs.send(JSON.stringify({ type: "INCREMENT_COUNTER" }));

    // Wait for the aggregator to receive the counter update
    await waitForMessages(aggMsgs, 2, 5000);

    // The aggregator's state should reflect the counter's count
    const state = buildClientState(aggMsgs);
    expect(state.public).toHaveProperty("counterCount");
    expect((state.public as Record<string, unknown>).counterCount).toBe(1);

    aggWs.close();
  });

  it("multiple increments flow through and accumulate", async () => {
    const aggregatorId = nextId("agg");

    const aggWs = await connectWebSocket("aggregator", aggregatorId, "user-1");
    const aggMsgs = collectMessages(aggWs);
    await waitForMessages(aggMsgs, 1);

    // Send 3 increments
    aggWs.send(JSON.stringify({ type: "INCREMENT_COUNTER" }));
    aggWs.send(JSON.stringify({ type: "INCREMENT_COUNTER" }));
    aggWs.send(JSON.stringify({ type: "INCREMENT_COUNTER" }));

    // Wait for updates to propagate
    await new Promise((r) => setTimeout(r, 2000));

    const state = buildClientState(aggMsgs);
    expect((state.public as Record<string, unknown>).counterCount).toBe(3);

    aggWs.close();
  });
});
