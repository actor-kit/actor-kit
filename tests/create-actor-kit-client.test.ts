import { afterEach, describe, expect, it, vi } from "vitest";
import { createActorKitClient } from "../src/createActorKitClient";

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

  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  private listeners = new Map<string, Array<(event?: unknown) => void>>();

  constructor(public readonly url: string) {}

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

describe("createActorKitClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("queues outbound events until the websocket connection opens", async () => {
    let socket: MockWebSocket | undefined;

    class MockWebSocketConstructor extends MockWebSocket {
      constructor(url: string) {
        socket = new MockWebSocket(url);
        super(url);
        return socket;
      }
    }

    vi.stubGlobal("WebSocket", MockWebSocketConstructor);

    const client = createActorKitClient<{
      input: unknown;
      context: unknown;
      events: TestEvent;
      value: "ready";
      output: unknown;
      transition: unknown;
      config: unknown;
    }>({
      accessToken: "token-123",
      actorId: "list-1",
      actorType: "todo",
      checksum: "checksum-1",
      host: "127.0.0.1:8788",
      initialSnapshot: {
        private: {},
        public: { todos: [] },
        value: "ready",
      } as TestSnapshot,
    });

    const connectionPromise = client.connect();
    client.send({ type: "ADD_TODO", text: "Buy milk" });

    expect(socket).toBeDefined();
    expect(socket?.sent).toEqual([]);

    socket?.open();
    await connectionPromise;

    expect(socket?.sent).toEqual([
      JSON.stringify({ type: "ADD_TODO", text: "Buy milk" }),
    ]);
  });
});
