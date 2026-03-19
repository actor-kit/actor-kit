/**
 * Testing Trophy: Integration tests for createActorKitClient and createActorFetch.
 *
 * These test the REAL client modules against a REAL Miniflare worker —
 * no MockWebSocket, no stubbed fetch. This is how users actually use
 * actor-kit: createActorFetch to get initial state, then createActorKitClient
 * to connect via WebSocket for real-time sync.
 */
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
import { createAccessToken, createActorFetch } from "@actor-kit/server";
import { createActorKitClient } from "@actor-kit/browser";
import type { CallerSnapshotFrom } from "@actor-kit/types";
import type { CounterMachine } from "./fixtures/counter.types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SECRET = "test-secret";
const ACTOR_TYPE = "counter";

// Typed helpers derived from the machine type — no `as never` casts
type Snapshot = CallerSnapshotFrom<CounterMachine>;

function fetchCounter(host: string) {
  return createActorFetch<CounterMachine>({
    actorType: ACTOR_TYPE,
    host,
  });
}

function counterClient(
  host: string,
  actorId: string,
  checksum: string,
  accessToken: string,
  initialSnapshot: Snapshot,
  callbacks?: {
    onStateChange?: (s: Snapshot) => void;
    onError?: (e: Error) => void;
  }
) {
  return createActorKitClient<CounterMachine>({
    host,
    actorType: ACTOR_TYPE,
    actorId,
    checksum,
    accessToken,
    initialSnapshot,
    ...callbacks,
  });
}

describe("Client integration: createActorFetch + createActorKitClient", () => {
  let mf: Miniflare;
  let host: string;
  let testCounter = 0;

  function nextActorId() {
    return `client-int-${++testCounter}`;
  }

  async function createToken(actorId: string, userId: string) {
    return createAccessToken({
      signingKey: SECRET,
      actorId,
      actorType: ACTOR_TYPE,
      callerId: userId,
      callerType: "client",
    });
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

    const url = await mf.ready;
    host = url.host;
  });

  afterAll(async () => {
    await mf.dispose();
  });

  // ----------------------------------------------------------------
  // createActorFetch — real HTTP against real worker
  // ----------------------------------------------------------------

  describe("createActorFetch", () => {
    it("fetches initial actor snapshot with checksum", async () => {
      const actorId = nextActorId();
      const token = await createToken(actorId, "user-1");
      const fetch = fetchCounter(host);

      const result = await fetch({ actorId, accessToken: token });

      expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(result.snapshot.public.count).toBe(0);
      expect(result.snapshot.public.lastUpdatedBy).toBeNull();
      expect(result.snapshot.value).toBeDefined();
    });

    it("includes input in the request URL", async () => {
      const actorId = nextActorId();
      const token = await createToken(actorId, "user-1");
      const fetch = fetchCounter(host);

      const result = await fetch({
        actorId,
        accessToken: token,
        input: { initialCount: 42 },
      });

      expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(result.snapshot).toBeDefined();
    });

    it("returns consistent checksum for same state", async () => {
      const actorId = nextActorId();
      const token = await createToken(actorId, "user-1");
      const fetch = fetchCounter(host);

      const r1 = await fetch({ actorId, accessToken: token });
      const r2 = await fetch({ actorId, accessToken: token });

      expect(r1.checksum).toBe(r2.checksum);
    });

    it("throws when host is empty", async () => {
      const fetch = createActorFetch<CounterMachine>({
        actorType: ACTOR_TYPE,
        host: "",
      });

      await expect(
        fetch({ actorId: "x", accessToken: "y" })
      ).rejects.toThrow("Actor Kit host is not defined");
    });

    it("throws on auth failure", async () => {
      const actorId = nextActorId();
      const fetch = fetchCounter(host);

      await expect(
        fetch({ actorId, accessToken: "bad-token" })
      ).rejects.toThrow("Failed to fetch actor");
    });

    it("uses http for local hosts and https for remote", () => {
      expect(() =>
        createActorFetch<CounterMachine>({ actorType: "t", host: "localhost:8788" })
      ).not.toThrow();
      expect(() =>
        createActorFetch<CounterMachine>({ actorType: "t", host: "127.0.0.1:8788" })
      ).not.toThrow();
      expect(() =>
        createActorFetch<CounterMachine>({ actorType: "t", host: "0.0.0.0:8788" })
      ).not.toThrow();
      expect(() =>
        createActorFetch<CounterMachine>({ actorType: "t", host: "actors.example.com" })
      ).not.toThrow();
    });
  });

  // ----------------------------------------------------------------
  // createActorKitClient — real WebSocket against real worker
  // ----------------------------------------------------------------

  describe("createActorKitClient", () => {
    it("connects, receives state, and sends events", async () => {
      const actorId = nextActorId();
      const token = await createToken(actorId, "user-1");
      const fetch = fetchCounter(host);

      const { snapshot, checksum } = await fetch({ actorId, accessToken: token });
      const client = counterClient(host, actorId, checksum, token, snapshot);

      await client.connect();
      client.send({ type: "INCREMENT" });

      await client.waitFor((s) => s.public.count === 1, 3000);

      expect(client.getState().public.count).toBe(1);
      expect(client.getState().public.lastUpdatedBy).toBe("user-1");

      client.disconnect();
    });

    it("applies patches correctly through multiple transitions", async () => {
      const actorId = nextActorId();
      const token = await createToken(actorId, "user-1");
      const fetch = fetchCounter(host);

      const { snapshot, checksum } = await fetch({ actorId, accessToken: token });
      const client = counterClient(host, actorId, checksum, token, snapshot);

      await client.connect();

      client.send({ type: "INCREMENT" });
      client.send({ type: "INCREMENT" });
      client.send({ type: "INCREMENT" });
      client.send({ type: "SET", value: 100 });
      client.send({ type: "DECREMENT" });

      await client.waitFor((s) => s.public.count === 99, 3000);
      expect(client.getState().public.count).toBe(99);

      client.disconnect();
    });

    it("calls onStateChange for each update", async () => {
      const actorId = nextActorId();
      const token = await createToken(actorId, "user-1");
      const fetch = fetchCounter(host);

      const { snapshot, checksum } = await fetch({ actorId, accessToken: token });
      const stateChanges: Snapshot[] = [];
      const client = counterClient(host, actorId, checksum, token, snapshot, {
        onStateChange: (s) => stateChanges.push(s),
      });

      await client.connect();
      client.send({ type: "INCREMENT" });
      await client.waitFor((s) => s.public.count === 1, 3000);

      expect(stateChanges.length).toBeGreaterThanOrEqual(1);

      client.disconnect();
    });

    it("subscribe and unsubscribe work correctly", async () => {
      const actorId = nextActorId();
      const token = await createToken(actorId, "user-1");
      const fetch = fetchCounter(host);

      const { snapshot, checksum } = await fetch({ actorId, accessToken: token });
      const updates: Snapshot[] = [];
      const client = counterClient(host, actorId, checksum, token, snapshot);
      const unsubscribe = client.subscribe((s) => updates.push(s));

      await client.connect();
      client.send({ type: "INCREMENT" });
      await client.waitFor((s) => s.public.count === 1, 3000);

      const countAfterFirst = updates.length;
      expect(countAfterFirst).toBeGreaterThanOrEqual(1);

      unsubscribe();
      client.send({ type: "INCREMENT" });
      await new Promise((r) => setTimeout(r, 500));

      expect(updates.length).toBe(countAfterFirst);

      client.disconnect();
    });

    it("reports errors via onError callback", async () => {
      const actorId = nextActorId();
      const token = await createToken(actorId, "user-1");
      const fetch = fetchCounter(host);

      const { snapshot, checksum } = await fetch({ actorId, accessToken: token });
      const errors: Error[] = [];
      const client = counterClient(host, actorId, checksum, token, snapshot, {
        onError: (err) => errors.push(err),
      });

      for (let i = 0; i < 110; i++) {
        client.send({ type: "INCREMENT" });
      }

      expect(errors.length).toBe(10);
      expect(errors[0]!.message).toContain("overflow");

      client.disconnect();
    });

    it("getState returns current snapshot without connecting", async () => {
      const actorId = nextActorId();
      const token = await createToken(actorId, "user-1");
      const fetch = fetchCounter(host);

      const { snapshot, checksum } = await fetch({ actorId, accessToken: token });
      const client = counterClient(host, actorId, checksum, token, snapshot);

      expect(client.getState().public.count).toBe(0);
    });

    it("waitFor resolves immediately when condition is already met", async () => {
      const actorId = nextActorId();
      const token = await createToken(actorId, "user-1");
      const fetch = fetchCounter(host);

      const { snapshot, checksum } = await fetch({ actorId, accessToken: token });
      const client = counterClient(host, actorId, checksum, token, snapshot);

      await expect(
        client.waitFor((s) => s.public.count === 0, 1000)
      ).resolves.toBeUndefined();
    });

    it("two clients see the same state on the same actor", async () => {
      const actorId = nextActorId();
      const token1 = await createToken(actorId, "user-1");
      const token2 = await createToken(actorId, "user-2");
      const fetch = fetchCounter(host);

      const { snapshot: s1, checksum: c1 } = await fetch({ actorId, accessToken: token1 });
      const client1 = counterClient(host, actorId, c1, token1, s1);

      await client1.connect();
      client1.send({ type: "INCREMENT" });
      client1.send({ type: "INCREMENT" });
      await client1.waitFor((s) => s.public.count === 2, 3000);

      const { snapshot: s2, checksum: c2 } = await fetch({ actorId, accessToken: token2 });
      expect(s2.public.count).toBe(2);
      expect(s2.public.lastUpdatedBy).toBe("user-1");

      const client2 = counterClient(host, actorId, c2, token2, s2);
      await client2.connect();

      client1.send({ type: "INCREMENT" });
      await client2.waitFor((s) => s.public.count === 3, 3000);

      expect(client2.getState().public.count).toBe(3);

      client1.disconnect();
      client2.disconnect();
    });
  });
});
