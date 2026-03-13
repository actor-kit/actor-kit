import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActorKitClient } from "../src/createActorKitClient";

type TestEvent = { type: "ADD_TODO"; text: string };
type TestSnapshot = {
  value: "ready";
  public: {
    todos: Array<{ id: string; text: string; completed: boolean }>;
  };
  private: {};
};

type TestMachine = {
  input: unknown;
  context: unknown;
  events: TestEvent;
  value: "ready";
  output: unknown;
  transition: unknown;
  config: unknown;
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
  return createActorKitClient<TestMachine>({
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

  it("reports an error when sending while disconnected", () => {
    const onError = vi.fn();
    const client = createTestClient({ onError });

    client.send({ type: "ADD_TODO", text: "Buy milk" });

    expect(onError).toHaveBeenCalledWith(
      new Error("Cannot send event: WebSocket is not connected")
    );
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
});
