import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActorKitClient } from "@actor-kit/browser";

type TestEvent = { type: "ADD_TODO"; text: string };
type TestSnapshot = {
  value: "ready";
  public: {
    todos: Array<{ id: string; text: string; completed: boolean }>;
  };
  private: {};
};

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  private listeners = new Map<string, Array<(event?: unknown) => void>>();

  constructor(public readonly url: string) {
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

  emitError(type = "error") {
    this.emit("error", { type });
  }

  emit(type: string, event?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function createTestClient(props?: {
  onStateChange?: (state: TestSnapshot) => void;
  onError?: (error: Error) => void;
  initialSnapshot?: TestSnapshot;
}) {
  return createActorKitClient<TestSnapshot, TestEvent>({
    accessToken: "token-123",
    actorId: "list-1",
    actorType: "todo",
    checksum: "checksum-1",
    host: "127.0.0.1:8788",
    initialSnapshot:
      props?.initialSnapshot ?? {
        private: {},
        public: { todos: [] },
        value: "ready",
      },
    onError: props?.onError,
    onStateChange: props?.onStateChange,
  });
}

describe("createActorKitClient", () => {
  beforeEach(() => {
    MockWebSocket.reset();
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("queues outbound events until the websocket connection opens", async () => {
    const client = createTestClient();

    const connectionPromise = client.connect();
    const socket = MockWebSocket.instances[0];

    client.send({ type: "ADD_TODO", text: "Buy milk" });

    expect(socket.sent).toEqual([]);

    socket.open();
    await connectionPromise;

    expect(socket.sent).toEqual([
      JSON.stringify({ type: "ADD_TODO", text: "Buy milk" }),
    ]);
  });

  it("builds websocket URLs for local and remote hosts", async () => {
    const localClient = createActorKitClient<TestSnapshot, TestEvent>({
      accessToken: "token-123",
      actorId: "list-1",
      actorType: "todo",
      checksum: "",
      host: "192.168.1.25:8788",
      initialSnapshot: {
        private: {},
        public: { todos: [] },
        value: "ready",
      },
    });

    const localConnection = localClient.connect();
    expect(MockWebSocket.instances[0]?.url).toBe(
      "ws://192.168.1.25:8788/api/todo/list-1?accessToken=token-123"
    );
    MockWebSocket.instances[0]?.open();
    await localConnection;

    const remoteClient = createActorKitClient<TestSnapshot, TestEvent>({
      accessToken: "token-remote",
      actorId: "list-2",
      actorType: "todo",
      checksum: "checksum-2",
      host: "actors.example.com",
      initialSnapshot: {
        private: {},
        public: { todos: [] },
        value: "ready",
      },
    });
    const remoteConnection = remoteClient.connect();
    expect(MockWebSocket.instances[1]?.url).toBe(
      "wss://actors.example.com/api/todo/list-2?accessToken=token-remote&checksum=checksum-2"
    );
    MockWebSocket.instances[1]?.open();
    await remoteConnection;
  });

  it("applies incoming patches and notifies subscribers", async () => {
    const onStateChange = vi.fn();
    const subscriber = vi.fn();
    const client = createTestClient({ onStateChange });
    const unsubscribe = client.subscribe(subscriber);

    const connectionPromise = client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    await connectionPromise;

    socket.emitMessage(
      JSON.stringify({
        checksum: "checksum-2",
        operations: [
          {
            op: "add",
            path: "/public/todos/0",
            value: {
              id: "todo-1",
              text: "Ship feature",
              completed: false,
            },
          },
        ],
      })
    );

    expect(client.getState()).toEqual({
      private: {},
      public: {
        todos: [
          {
            id: "todo-1",
            text: "Ship feature",
            completed: false,
          },
        ],
      },
      value: "ready",
    });
    expect(onStateChange).toHaveBeenCalledOnce();
    expect(subscriber).toHaveBeenCalledOnce();

    unsubscribe();
    socket.emitMessage(
      JSON.stringify({
        checksum: "checksum-3",
        operations: [
          {
            op: "replace",
            path: "/public/todos/0/completed",
            value: true,
          },
        ],
      })
    );

    expect(subscriber).toHaveBeenCalledOnce();
    expect(client.getState().public.todos[0]?.completed).toBe(true);
  });

  it("reports malformed messages and websocket errors", async () => {
    const onError = vi.fn();
    const client = createTestClient({ onError });

    const connectionPromise = client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    await connectionPromise;

    socket.emitMessage("{not-json");
    socket.emitError("close");

    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[1]?.[0]).toEqual(
      new Error("WebSocket error: close")
    );
  });

  it("handles binary websocket messages and tolerates missing callbacks", async () => {
    const client = createTestClient();
    const subscriber = vi.fn();
    client.subscribe(subscriber);

    const connectionPromise = client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    await connectionPromise;

    socket.emitMessage(
      new TextEncoder().encode(
        JSON.stringify({
          checksum: "checksum-2",
          operations: [
            {
              op: "add",
              path: "/public/todos/0",
              value: {
                id: "todo-1",
                text: "Binary payload",
                completed: false,
              },
            },
          ],
        })
      )
    );

    expect(client.getState().public.todos[0]).toEqual({
      id: "todo-1",
      text: "Binary payload",
      completed: false,
    });
    expect(subscriber).toHaveBeenCalledOnce();
  });

  it("queues events sent before connect and flushes them on open", async () => {
    const client = createTestClient();

    // Send BEFORE calling connect — should queue, not error
    client.send({ type: "ADD_TODO", text: "Before connect" });
    client.send({ type: "ADD_TODO", text: "Also before" });

    const connectionPromise = client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    await connectionPromise;

    expect(socket.sent).toEqual([
      JSON.stringify({ type: "ADD_TODO", text: "Before connect" }),
      JSON.stringify({ type: "ADD_TODO", text: "Also before" }),
    ]);
  });

  it("queues events during reconnection and flushes on reconnect", async () => {
    vi.useFakeTimers();

    const client = createTestClient();
    const connectionPromise = client.connect();
    const firstSocket = MockWebSocket.instances[0];
    firstSocket.open();
    await connectionPromise;

    // Disconnect
    firstSocket.close();

    // Send during disconnection — should queue
    client.send({ type: "ADD_TODO", text: "During disconnect" });

    // Reconnect
    await vi.advanceTimersByTimeAsync(2000);
    const secondSocket = MockWebSocket.instances[1];
    secondSocket.open();

    expect(secondSocket.sent).toEqual([
      JSON.stringify({ type: "ADD_TODO", text: "During disconnect" }),
    ]);
  });

  it("respects max queue size and drops oldest events", async () => {
    const client = createTestClient();

    // Queue more events than default max (100)
    for (let i = 0; i < 105; i++) {
      client.send({ type: "ADD_TODO", text: `Event ${i}` });
    }

    const connectionPromise = client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    await connectionPromise;

    // Should have dropped the oldest 5
    expect(socket.sent).toHaveLength(100);
    expect(JSON.parse(socket.sent[0])).toEqual({
      type: "ADD_TODO",
      text: "Event 5",
    });
    expect(JSON.parse(socket.sent[99])).toEqual({
      type: "ADD_TODO",
      text: "Event 104",
    });
  });

  it("preserves queue order across multiple send calls", async () => {
    const client = createTestClient();

    client.send({ type: "ADD_TODO", text: "A" });
    client.send({ type: "ADD_TODO", text: "B" });
    client.send({ type: "ADD_TODO", text: "C" });

    const connectionPromise = client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    await connectionPromise;

    const sentTexts = socket.sent.map(
      (s) => (JSON.parse(s) as TestEvent).text
    );
    expect(sentTexts).toEqual(["A", "B", "C"]);
  });

  it("does not throw when optional error callbacks are omitted", async () => {
    const client = createTestClient();
    const connectionPromise = client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    await connectionPromise;

    expect(() => socket.emitMessage("{not-json")).not.toThrow();
    expect(() => socket.emitError("socket")).not.toThrow();
    // Sending while disconnected now queues — should not throw
    client.disconnect();
    expect(() =>
      client.send({ type: "ADD_TODO", text: "No callback installed" })
    ).not.toThrow();
  });

  it("waits for state changes and times out when the predicate is not met", async () => {
    vi.useFakeTimers();

    const client = createTestClient();
    const connectionPromise = client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    await connectionPromise;

    const resolvedWait = client.waitFor(
      (state) => state.public.todos.some((todo) => todo.id === "todo-1"),
      1000
    );

    socket.emitMessage(
      JSON.stringify({
        checksum: "checksum-2",
        operations: [
          {
            op: "add",
            path: "/public/todos/0",
            value: {
              id: "todo-1",
              text: "Learn Actor Kit",
              completed: false,
            },
          },
        ],
      })
    );

    await expect(resolvedWait).resolves.toBeUndefined();
    await expect(client.waitFor((state) => state.public.todos.length > 0)).resolves
      .toBeUndefined();

    const timedOutWaitExpectation = expect(
      client.waitFor((state) => state.public.todos.length > 10, 100)
    ).rejects.toThrow("Timeout waiting for condition after 100ms");
    await vi.advanceTimersByTimeAsync(100);
    await timedOutWaitExpectation;
  });

  it("reconnects after unexpected closes but not after manual disconnect", async () => {
    vi.useFakeTimers();

    const client = createTestClient();
    const connectionPromise = client.connect();
    const firstSocket = MockWebSocket.instances[0];
    firstSocket.open();
    await connectionPromise;

    firstSocket.close();
    await vi.advanceTimersByTimeAsync(2000);

    expect(MockWebSocket.instances).toHaveLength(2);

    client.disconnect();
    await vi.advanceTimersByTimeAsync(2000);

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1]?.readyState).toBe(MockWebSocket.CLOSED);
  });

  it("uses exponential backoff and stops after the max reconnect attempts", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const client = createTestClient();
    const connectionPromise = client.connect();
    const firstSocket = MockWebSocket.instances[0];
    firstSocket.open();
    await connectionPromise;

    firstSocket.close();
    await vi.advanceTimersByTimeAsync(1999);
    expect(MockWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(MockWebSocket.instances).toHaveLength(2);

    MockWebSocket.instances[1]?.close();
    await vi.advanceTimersByTimeAsync(4000);
    expect(MockWebSocket.instances).toHaveLength(3);

    MockWebSocket.instances[2]?.close();
    await vi.advanceTimersByTimeAsync(8000);
    expect(MockWebSocket.instances).toHaveLength(4);

    MockWebSocket.instances[3]?.close();
    await vi.advanceTimersByTimeAsync(16000);
    expect(MockWebSocket.instances).toHaveLength(5);

    MockWebSocket.instances[4]?.close();
    await vi.advanceTimersByTimeAsync(30000);
    expect(MockWebSocket.instances).toHaveLength(6);

    MockWebSocket.instances[5]?.close();
    await vi.advanceTimersByTimeAsync(30000);
    expect(MockWebSocket.instances).toHaveLength(6);
    expect(errorSpy).toHaveBeenCalledWith(
      "[ActorKitClient] Max reconnection attempts reached"
    );
  });
});
