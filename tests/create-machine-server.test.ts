import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAccessToken } from "../src/createAccessToken";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class DurableObject {
    constructor(
      public readonly state: unknown,
      public readonly env: unknown
    ) {}
  },
}));

type TodoServerClass = new (
  state: FakeDurableObjectState,
  env: {
    ACTOR_KIT_SECRET: string;
    EMAIL_SERVICE_API_KEY: string;
  }
) => {
  attachments: Map<FakeWebSocket, { caller: { id: string; type: "client" | "service" | "system" } }>;
  fetch(request: Request): Promise<Response>;
  getSnapshot(
    caller: { id: string; type: "client" | "service" | "system" }
  ): Promise<{
    checksum: string;
    snapshot: {
      public: {
        ownerId: string;
        todos: Array<{ id: string; text: string; completed: boolean }>;
      };
      private: Record<string, unknown>;
      value: unknown;
    };
  }>;
  send(event: { type: string; text?: string; id?: string; caller: { id: string; type: "client" | "service" | "system" } }): void;
  spawn(props: {
    actorType: string;
    actorId: string;
    caller: { id: string; type: "client" | "service" | "system" };
    input: { foo: string };
  }): Promise<void>;
  webSocketMessage(socket: FakeWebSocket, message: string): Promise<void>;
};

let TodoServer: TodoServerClass;

class FakeStorage {
  private values = new Map<string, unknown>();

  async get(key: string) {
    return this.values.get(key);
  }

  async put(key: string, value: unknown) {
    this.values.set(key, value);
  }
}

class FakeDurableObjectState {
  readonly storage = new FakeStorage();
  private readonly sockets: FakeWebSocket[] = [];
  private readonly pending: Promise<unknown>[] = [];

  blockConcurrencyWhile<T>(fn: () => Promise<T>) {
    const pendingPromise = fn();
    this.pending.push(pendingPromise);
    return pendingPromise;
  }

  getWebSockets() {
    return this.sockets;
  }

  acceptWebSocket(socket: FakeWebSocket) {
    this.sockets.push(socket);
  }

  async idle() {
    await Promise.all(this.pending);
  }
}

class FakeWebSocket {
  sent: string[] = [];
  closeCalls: Array<{ code: number; reason: string }> = [];
  private attachment: unknown;

  send(payload: string) {
    this.sent.push(payload);
  }

  close(code: number, reason: string) {
    this.closeCalls.push({ code, reason });
  }

  serializeAttachment(value: unknown) {
    this.attachment = value;
  }

  deserializeAttachment() {
    return this.attachment;
  }
}

class FakeWebSocketPair {
  0: FakeWebSocket;
  1: FakeWebSocket;

  constructor() {
    this[0] = new FakeWebSocket();
    this[1] = new FakeWebSocket();
  }
}

class FakeResponse {
  static json(data: unknown, init?: ResponseInit) {
    return new FakeResponse(JSON.stringify(data), init);
  }

  readonly status: number;
  readonly webSocket: unknown;
  private readonly bodyText: string;

  constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
    this.status = init?.status ?? 200;
    this.webSocket = init?.webSocket;
    if (typeof body === "string") {
      this.bodyText = body;
    } else if (body == null) {
      this.bodyText = "";
    } else {
      this.bodyText = String(body);
    }
  }

  async text() {
    return this.bodyText;
  }

  async json() {
    return JSON.parse(this.bodyText);
  }
}

beforeAll(async () => {
  const module = await import("../examples/nextjs-actorkit-todo/src/todo.server");
  TodoServer = module.Todo as unknown as TodoServerClass;
});

beforeEach(() => {
  vi.stubGlobal("WebSocketPair", FakeWebSocketPair);
  vi.stubGlobal("Response", FakeResponse);
});

describe("createMachineServer", () => {
  it("requires input when the machine input schema has required fields", async () => {
    const state = new FakeDurableObjectState();
    const server = new TodoServer(state, {
      ACTOR_KIT_SECRET: "super-secret",
      EMAIL_SERVICE_API_KEY: "key",
    });
    await state.idle();

    const token = await createAccessToken({
      signingKey: "super-secret",
      actorId: "list-1",
      actorType: "todo",
      callerId: "user-1",
      callerType: "client",
    });

    const response = await server.fetch(
      new Request("https://example.com/api/todo/list-1", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain(
      "Input parameters required"
    );
  });

  it("spawns a machine, persists actor metadata, and returns caller snapshots", async () => {
    const state = new FakeDurableObjectState();
    const server = new TodoServer(state, {
      ACTOR_KIT_SECRET: "super-secret",
      EMAIL_SERVICE_API_KEY: "key",
    });
    await state.idle();

    await server.spawn({
      actorType: "todo",
      actorId: "list-1",
      caller: { id: "user-1", type: "client" },
      input: { foo: "bar" },
    });

    const snapshot = await server.getSnapshot({
      id: "user-1",
      type: "client",
    });

    expect(await state.storage.get("actorType")).toBe("todo");
    expect(await state.storage.get("actorId")).toBe("list-1");
    expect(await state.storage.get("initialCaller")).toBe(
      JSON.stringify({ id: "user-1", type: "client" })
    );
    expect(await state.storage.get("input")).toBe(JSON.stringify({ foo: "bar" }));
    expect(snapshot.snapshot.public.ownerId).toBe("user-1");
    expect(snapshot.snapshot.public.todos).toEqual([]);
  });

  it("applies client events through send and websocket message parsing", async () => {
    const state = new FakeDurableObjectState();
    const server = new TodoServer(state, {
      ACTOR_KIT_SECRET: "super-secret",
      EMAIL_SERVICE_API_KEY: "key",
    });
    await state.idle();

    await server.spawn({
      actorType: "todo",
      actorId: "list-1",
      caller: { id: "user-1", type: "client" },
      input: { foo: "bar" },
    });

    server.send({
      type: "ADD_TODO",
      text: "Ship tests",
      caller: { id: "user-1", type: "client" },
    });

    const socket = new FakeWebSocket();
    server.attachments.set(socket, {
      caller: { id: "user-1", type: "client" },
    });
    await server.webSocketMessage(
      socket,
      JSON.stringify({ type: "ADD_TODO", text: "Ship more tests" })
    );

    const snapshot = await server.getSnapshot({
      id: "user-1",
      type: "client",
    });

    expect(snapshot.snapshot.public.todos).toHaveLength(2);
    expect(snapshot.snapshot.public.todos.map((todo) => todo.text)).toEqual([
      "Ship tests",
      "Ship more tests",
    ]);
  });

  it("restores persisted snapshots when a durable object restarts", async () => {
    const state = new FakeDurableObjectState();
    const env = {
      ACTOR_KIT_SECRET: "super-secret",
      EMAIL_SERVICE_API_KEY: "key",
    };

    const firstServer = new TodoServer(state, env);
    await state.idle();

    await firstServer.spawn({
      actorType: "todo",
      actorId: "list-1",
      caller: { id: "user-1", type: "client" },
      input: { foo: "bar" },
    });

    firstServer.send({
      type: "ADD_TODO",
      text: "Persist me",
      caller: { id: "user-1", type: "client" },
    });
    await Promise.resolve();

    const secondServer = new TodoServer(state, env);
    await state.idle();

    const snapshot = await secondServer.getSnapshot({
      id: "user-1",
      type: "client",
    });

    expect(snapshot.snapshot.public.todos.map((todo) => todo.text)).toEqual([
      "Persist me",
    ]);
  });

  it("upgrades fetch requests to websockets and sends the initial patch payload", async () => {
    const state = new FakeDurableObjectState();
    const server = new TodoServer(state, {
      ACTOR_KIT_SECRET: "super-secret",
      EMAIL_SERVICE_API_KEY: "key",
    });
    await state.idle();

    const token = await createAccessToken({
      signingKey: "super-secret",
      actorId: "list-1",
      actorType: "todo",
      callerId: "user-1",
      callerType: "client",
    });

    const response = await server.fetch(
      new Request(
        "https://example.com/api/todo/list-1?input=%7B%22foo%22%3A%22bar%22%7D",
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      )
    );

    expect(response.status).toBe(101);
    const acceptedSocket = state.getWebSockets()[0];
    expect(acceptedSocket).toBeDefined();
    expect(acceptedSocket?.sent).toHaveLength(1);
    expect(JSON.parse(acceptedSocket?.sent[0] ?? "{}")).toMatchObject({
      checksum: expect.any(String),
      operations: expect.any(Array),
    });
  });

  it("returns auth and input errors at the request boundary", async () => {
    const state = new FakeDurableObjectState();
    const server = new TodoServer(state, {
      ACTOR_KIT_SECRET: "super-secret",
      EMAIL_SERVICE_API_KEY: "key",
    });
    await state.idle();

    const unauthorized = await server.fetch(
      new Request(
        "https://example.com/api/todo/list-1?input=%7B%22foo%22%3A%22bar%22%7D",
        {
          headers: {
            Authorization: "Bearer bad-token",
          },
        }
      )
    );
    expect(unauthorized.status).toBe(401);

    const token = await createAccessToken({
      signingKey: "super-secret",
      actorId: "list-1",
      actorType: "todo",
      callerId: "user-1",
      callerType: "client",
    });

    const invalidInput = await server.fetch(
      new Request("https://example.com/api/todo/list-1?input=%7Bbad-json", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })
    );

    expect(invalidInput.status).toBe(400);
    await expect(invalidInput.text()).resolves.toContain("Invalid input");
  });

  it("supports wait-for timeouts and websocket cleanup", async () => {
    vi.useFakeTimers();
    const state = new FakeDurableObjectState();
    const server = new TodoServer(state, {
      ACTOR_KIT_SECRET: "super-secret",
      EMAIL_SERVICE_API_KEY: "key",
    });
    await state.idle();

    await server.spawn({
      actorType: "todo",
      actorId: "list-1",
      caller: { id: "user-1", type: "client" },
      input: { foo: "bar" },
    });

    const socket = new FakeWebSocket();
    server.attachments.set(socket, {
      caller: { id: "user-1", type: "client" },
    });
    await server.webSocketMessage(
      socket,
      new TextEncoder().encode(
        JSON.stringify({ type: "ADD_TODO", text: "From binary payload" })
      )
    );

    const timedSnapshot = server.getSnapshot(
      { id: "user-1", type: "client" },
      {
        waitForState: "missing" as never,
        timeout: 25,
        errorOnWaitTimeout: false,
      }
    );
    await vi.advanceTimersByTimeAsync(25);
    await expect(timedSnapshot).resolves.toMatchObject({
      checksum: expect.any(String),
    });

    const timeoutError = expect(
      server.getSnapshot(
        { id: "user-1", type: "client" },
        {
          waitForState: "missing" as never,
          timeout: 25,
        }
      )
    ).rejects.toThrow("Timeout waiting for event or state");
    await vi.advanceTimersByTimeAsync(25);
    await timeoutError;

    await server.webSocketClose(socket, 1000, "done", true);
    expect(socket.closeCalls).toEqual([
      { code: 1000, reason: "Durable Object is closing WebSocket" },
    ]);
    expect(server.attachments.has(socket)).toBe(false);

    vi.useRealTimers();
  });
});
