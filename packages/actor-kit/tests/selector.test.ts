/**
 * Tests for client.select() — framework-agnostic selectors.
 *
 * Selectors subscribe to client state internally and only notify
 * their own subscribers when the selected value changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActorKitClient } from "../src/createActorKitClient";

// ---------------------------------------------------------------------------
// Minimal machine type for selector tests
// ---------------------------------------------------------------------------

type TestSnapshot = {
  value: "active";
  public: { count: number; name: string };
  private: Record<string, never>;
};

type TestMachine = {
  input: unknown;
  context: unknown;
  events: { type: "INCREMENT" } | { type: "SET_NAME"; name: string };
  value: "active";
  output: unknown;
  transition: unknown;
  config: unknown;
};

// ---------------------------------------------------------------------------
// MockWebSocket (same pattern as create-actor-kit-client.test.ts)
// ---------------------------------------------------------------------------

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  private listeners = new Map<string, Array<(event?: unknown) => void>>();

  constructor() {
    MockWebSocket.instances.push(this);
  }

  static reset() {
    MockWebSocket.instances = [];
  }

  addEventListener(type: string, listener: (event?: unknown) => void) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close");
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open");
  }

  emitMessage(data: unknown) {
    this.emit("message", { data });
  }

  emit(type: string, event?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const initialSnapshot: TestSnapshot = {
  value: "active",
  public: { count: 0, name: "Alice" },
  private: {},
};

function patchMessage(
  ops: Array<{ op: string; path: string; value?: unknown }>,
  checksum: string
) {
  return JSON.stringify({ operations: ops, checksum });
}

function createTestClient() {
  const client = createActorKitClient<TestMachine>({
    host: "localhost:8788",
    actorType: "test",
    actorId: "test-1",
    checksum: "abc123",
    accessToken: "token",
    initialSnapshot,
  });
  return client;
}

function getLatestMockWs() {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1];
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let originalWebSocket: typeof WebSocket;

beforeEach(() => {
  MockWebSocket.reset();
  originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("client.select()", () => {
  it("returns current selected value via .get()", () => {
    const client = createTestClient();

    const count = client.select((s) => s.public.count);
    expect(count.get()).toBe(0);
  });

  it("updates .get() when underlying state changes", async () => {
    const client = createTestClient();
    const count = client.select((s) => s.public.count);

    // Connect and open WebSocket
    const connectPromise = client.connect();
    const ws = getLatestMockWs();
    ws.open();
    await connectPromise;

    // Simulate a state update via server message
    ws.emitMessage(
      patchMessage(
        [{ op: "replace", path: "/public/count", value: 5 }],
        "check2"
      )
    );

    expect(count.get()).toBe(5);
    client.disconnect();
  });

  it("only notifies subscribers when selected value changes", async () => {
    const client = createTestClient();
    const count = client.select((s) => s.public.count);
    const listener = vi.fn();
    count.subscribe(listener);

    const connectPromise = client.connect();
    const ws = getLatestMockWs();
    ws.open();
    await connectPromise;

    // Change name (not count) — selector should NOT fire
    ws.emitMessage(
      patchMessage(
        [{ op: "replace", path: "/public/name", value: "Bob" }],
        "check2"
      )
    );
    expect(listener).not.toHaveBeenCalled();

    // Change count — selector SHOULD fire
    ws.emitMessage(
      patchMessage(
        [{ op: "replace", path: "/public/count", value: 1 }],
        "check3"
      )
    );
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(1);

    client.disconnect();
  });

  it("supports custom equality function", async () => {
    const client = createTestClient();

    // Select an object slice with custom shallow equality
    const stats = client.select(
      (s) => ({ count: s.public.count, name: s.public.name }),
      (a, b) => a.count === b.count && a.name === b.name
    );

    const listener = vi.fn();
    stats.subscribe(listener);

    const connectPromise = client.connect();
    const ws = getLatestMockWs();
    ws.open();
    await connectPromise;

    // Same values, different part of state changed — should NOT fire
    ws.emitMessage(
      patchMessage(
        [{ op: "replace", path: "/value", value: "still-active" }],
        "check2"
      )
    );
    expect(listener).not.toHaveBeenCalled();

    // Different count — SHOULD fire
    ws.emitMessage(
      patchMessage(
        [{ op: "replace", path: "/public/count", value: 10 }],
        "check3"
      )
    );
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ count: 10, name: "Alice" });

    client.disconnect();
  });

  it("multiple selectors on same client are independent", async () => {
    const client = createTestClient();

    const countListener = vi.fn();
    const nameListener = vi.fn();

    client.select((s) => s.public.count).subscribe(countListener);
    client.select((s) => s.public.name).subscribe(nameListener);

    const connectPromise = client.connect();
    const ws = getLatestMockWs();
    ws.open();
    await connectPromise;

    // Change count only
    ws.emitMessage(
      patchMessage(
        [{ op: "replace", path: "/public/count", value: 1 }],
        "check2"
      )
    );

    expect(countListener).toHaveBeenCalledTimes(1);
    expect(nameListener).not.toHaveBeenCalled();

    client.disconnect();
  });

  it("unsubscribe cleans up the listener", async () => {
    const client = createTestClient();
    const count = client.select((s) => s.public.count);
    const listener = vi.fn();
    const unsub = count.subscribe(listener);

    const connectPromise = client.connect();
    const ws = getLatestMockWs();
    ws.open();
    await connectPromise;

    // Fire once
    ws.emitMessage(
      patchMessage(
        [{ op: "replace", path: "/public/count", value: 1 }],
        "check2"
      )
    );
    expect(listener).toHaveBeenCalledTimes(1);

    // Unsubscribe
    unsub();

    // Should not fire again
    ws.emitMessage(
      patchMessage(
        [{ op: "replace", path: "/public/count", value: 2 }],
        "check3"
      )
    );
    expect(listener).toHaveBeenCalledTimes(1);

    client.disconnect();
  });

  it("selector works before connect (uses initial snapshot)", () => {
    const client = createTestClient();

    const name = client.select((s) => s.public.name);
    expect(name.get()).toBe("Alice");
  });

  it("cleans up internal client subscription when all selector listeners unsubscribe", async () => {
    const client = createTestClient();
    const count = client.select((s) => s.public.count);

    // Subscribe two listeners
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    const unsub1 = count.subscribe(listener1);
    const unsub2 = count.subscribe(listener2);

    const connectPromise = client.connect();
    const ws = getLatestMockWs();
    ws.open();
    await connectPromise;

    // Both receive updates
    ws.emitMessage(
      patchMessage(
        [{ op: "replace", path: "/public/count", value: 1 }],
        "check2"
      )
    );
    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledTimes(1);

    // Unsub first — second still works
    unsub1();
    ws.emitMessage(
      patchMessage(
        [{ op: "replace", path: "/public/count", value: 2 }],
        "check3"
      )
    );
    expect(listener1).toHaveBeenCalledTimes(1); // no change
    expect(listener2).toHaveBeenCalledTimes(2);

    // Unsub second — internal client subscription should be cleaned up
    unsub2();

    // Re-subscribing should work fresh
    const listener3 = vi.fn();
    count.subscribe(listener3);
    ws.emitMessage(
      patchMessage(
        [{ op: "replace", path: "/public/count", value: 3 }],
        "check4"
      )
    );
    expect(listener3).toHaveBeenCalledTimes(1);
    expect(listener3).toHaveBeenCalledWith(3);

    client.disconnect();
  });

  it("selector .get() returns latest value even without subscribers", async () => {
    const client = createTestClient();
    const count = client.select((s) => s.public.count);

    const connectPromise = client.connect();
    const ws = getLatestMockWs();
    ws.open();
    await connectPromise;

    // No subscribers, but .get() should recompute from current state
    ws.emitMessage(
      patchMessage(
        [{ op: "replace", path: "/public/count", value: 42 }],
        "check2"
      )
    );
    expect(count.get()).toBe(42);

    client.disconnect();
  });
});
