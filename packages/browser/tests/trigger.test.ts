/**
 * Tests for client.trigger — typed event dispatch.
 *
 * trigger.EVENT_NAME(payload) is syntactic sugar for
 * send({ type: 'EVENT_NAME', ...payload }).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActorKitClient } from "@actor-kit/browser";
import { createActorKitMockClient } from "@actor-kit/test";

// ---------------------------------------------------------------------------
// Minimal machine type with multiple event types
// ---------------------------------------------------------------------------

type TodoClientEvent =
  | { type: "ADD_TODO"; text: string }
  | { type: "TOGGLE_TODO"; id: string }
  | { type: "CLEAR_COMPLETED" };

type TodoSnapshot = {
  value: "ready";
  public: {
    todos: Array<{ id: string; text: string; done: boolean }>;
  };
  private: Record<string, never>;
};

type TodoMachine = {
  input: unknown;
  context: unknown;
  events: TodoClientEvent;
  value: "ready";
  output: unknown;
  transition: unknown;
  config: unknown;
};

// ---------------------------------------------------------------------------
// MockWebSocket
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

  emit(type: string, event?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const initialSnapshot: TodoSnapshot = {
  value: "ready",
  public: { todos: [] },
  private: {},
};

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

describe("client.trigger", () => {
  it("sends correct event with payload", async () => {
    const client = createActorKitClient<TodoMachine>({
      host: "localhost:8788",
      actorType: "todo",
      actorId: "todo-1",
      checksum: "abc",
      accessToken: "token",
      initialSnapshot,
    });

    const connectPromise = client.connect();
    const ws = MockWebSocket.instances[0];
    ws.open();
    await connectPromise;

    client.trigger.ADD_TODO({ text: "Buy milk" });

    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0])).toEqual({
      type: "ADD_TODO",
      text: "Buy milk",
    });

    client.disconnect();
  });

  it("sends event with no payload", async () => {
    const client = createActorKitClient<TodoMachine>({
      host: "localhost:8788",
      actorType: "todo",
      actorId: "todo-1",
      checksum: "abc",
      accessToken: "token",
      initialSnapshot,
    });

    const connectPromise = client.connect();
    const ws = MockWebSocket.instances[0];
    ws.open();
    await connectPromise;

    client.trigger.CLEAR_COMPLETED();

    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0])).toEqual({ type: "CLEAR_COMPLETED" });

    client.disconnect();
  });

  it("queues triggers before connection (like send)", () => {
    const client = createActorKitClient<TodoMachine>({
      host: "localhost:8788",
      actorType: "todo",
      actorId: "todo-1",
      checksum: "abc",
      accessToken: "token",
      initialSnapshot,
    });

    // Trigger before connecting — should queue
    client.trigger.ADD_TODO({ text: "Queued item" });

    // No WebSocket yet, nothing sent
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("works on mock client", () => {
    const onSend = vi.fn();
    const mockClient = createActorKitMockClient<TodoMachine>({
      initialSnapshot,
      onSend,
    });

    mockClient.trigger.TOGGLE_TODO({ id: "abc" });

    expect(onSend).toHaveBeenCalledWith({ type: "TOGGLE_TODO", id: "abc" });
  });

  it("is equivalent to send()", async () => {
    const client = createActorKitClient<TodoMachine>({
      host: "localhost:8788",
      actorType: "todo",
      actorId: "todo-1",
      checksum: "abc",
      accessToken: "token",
      initialSnapshot,
    });

    const connectPromise = client.connect();
    const ws = MockWebSocket.instances[0];
    ws.open();
    await connectPromise;

    client.trigger.ADD_TODO({ text: "Via trigger" });
    client.send({ type: "ADD_TODO", text: "Via send" });

    expect(JSON.parse(ws.sent[0])).toEqual({
      type: "ADD_TODO",
      text: "Via trigger",
    });
    expect(JSON.parse(ws.sent[1])).toEqual({
      type: "ADD_TODO",
      text: "Via send",
    });

    client.disconnect();
  });
});
