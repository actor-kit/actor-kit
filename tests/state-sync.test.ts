import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAccessToken } from "@actor-kit/server";

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
  actor: {
    getSnapshot: () => unknown;
    subscribe: (fn: () => void) => { unsubscribe: () => void };
  } | undefined;
  attachments: Map<
    FakeWebSocket,
    {
      caller: { id: string; type: "client" | "service" | "system" };
      lastSentChecksum?: string;
    }
  >;
  subscriptions: Map<FakeWebSocket, { unsubscribe: () => void }>;
  fetch(request: Request): Promise<FakeResponse>;
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
  send(event: {
    type: string;
    text?: string;
    id?: string;
    caller: { id: string; type: "client" | "service" | "system" };
  }): void;
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

  constructor(
    body?: BodyInit | null,
    init?: ResponseInit & { webSocket?: unknown }
  ) {
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

const SECRET = "super-secret";
const ENV = { ACTOR_KIT_SECRET: SECRET, EMAIL_SERVICE_API_KEY: "key" };

beforeAll(async () => {
  const module = await import(
    "../../../examples/nextjs-actorkit-todo/src/todo.server"
  );
  TodoServer = module.Todo as unknown as TodoServerClass;
});

beforeEach(() => {
  vi.stubGlobal("WebSocketPair", FakeWebSocketPair);
  vi.stubGlobal("Response", FakeResponse);
});

// Helper: create a token for a given user
async function tokenFor(userId: string) {
  return createAccessToken({
    signingKey: SECRET,
    actorId: "list-1",
    actorType: "todo",
    callerId: userId,
    callerType: "client",
  });
}

// Helper: connect a WebSocket via fetch and return the server-side socket
async function connectSocket(
  server: InstanceType<typeof TodoServer>,
  state: FakeDurableObjectState,
  userId: string,
  isFirstConnection = false
) {
  const token = await tokenFor(userId);
  const inputParam = isFirstConnection
    ? `&input=${encodeURIComponent(JSON.stringify({ foo: "bar" }))}`
    : "";
  const response = await server.fetch(
    new Request(
      `https://example.com/api/todo/list-1?accessToken=${token}${inputParam}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    )
  );
  expect(response.status).toBe(101);

  // The accepted server-side socket is the last one added
  const sockets = state.getWebSockets();
  return sockets[sockets.length - 1]!;
}

// Helper: wait for async operations (checksum computation etc)
async function settle() {
  await new Promise((r) => setTimeout(r, 200));
}

// Helper: parse all messages sent to a socket
function parseSentMessages(socket: FakeWebSocket) {
  return socket.sent.map(
    (msg) =>
      JSON.parse(msg) as {
        operations: Array<{ op: string; path: string; value?: unknown }>;
        checksum: string;
      }
  );
}

describe("State sync: per-socket serialization (P1/P4)", () => {
  it("delivers state updates to subscribed sockets after transitions", async () => {
    // TLA+ counterexample: two rapid state transitions, each triggering
    // #sendStateUpdate. Without per-socket serialization, the second call
    // can race the first and patches arrive out of order or are lost.
    const state = new FakeDurableObjectState();
    const server = new TodoServer(state, ENV);
    await state.idle();

    // Connect first socket (also spawns the actor)
    const socket1 = await connectSocket(server, state, "user-1", true);
    await settle();

    // Connect second socket
    const socket2 = await connectSocket(server, state, "user-2");
    await settle();

    // Record baseline message counts
    const baseline1 = socket1.sent.length;
    const baseline2 = socket2.sent.length;

    // Rapid-fire 3 state transitions
    server.send({
      type: "ADD_TODO",
      text: "First",
      caller: { id: "user-1", type: "client" },
    });
    server.send({
      type: "ADD_TODO",
      text: "Second",
      caller: { id: "user-1", type: "client" },
    });
    server.send({
      type: "ADD_TODO",
      text: "Third",
      caller: { id: "user-1", type: "client" },
    });

    await settle();

    // CRITICAL: Both sockets must receive updates after the transitions
    const newMessages1 = socket1.sent.slice(baseline1);
    const newMessages2 = socket2.sent.slice(baseline2);

    expect(newMessages1.length).toBeGreaterThanOrEqual(1);
    expect(newMessages2.length).toBeGreaterThanOrEqual(1);

    // The final checksum on both sockets must match the server state
    const finalSnapshot = await server.getSnapshot({
      id: "user-1",
      type: "client",
    });

    const parsed1 = newMessages1.map((m) => JSON.parse(m));
    const parsed2 = newMessages2.map((m) => JSON.parse(m));

    const lastChecksum1 = parsed1[parsed1.length - 1]?.checksum;
    const lastChecksum2 = parsed2[parsed2.length - 1]?.checksum;

    expect(lastChecksum1).toBe(finalSnapshot.checksum);
    expect(lastChecksum2).toBe(finalSnapshot.checksum);
  });

  it("ensures no duplicate checksums in sequential state updates", async () => {
    // Per-socket serialization means #sendStateUpdate calls are queued.
    // Each call should produce a unique checksum because each sees a
    // different state.
    const state = new FakeDurableObjectState();
    const server = new TodoServer(state, ENV);
    await state.idle();

    const socket = await connectSocket(server, state, "user-1", true);
    await settle();

    const baseline = socket.sent.length;

    // Two synchronous transitions (before any async work)
    server.send({
      type: "ADD_TODO",
      text: "Alpha",
      caller: { id: "user-1", type: "client" },
    });
    server.send({
      type: "ADD_TODO",
      text: "Beta",
      caller: { id: "user-1", type: "client" },
    });

    await settle();

    const newMessages = socket.sent
      .slice(baseline)
      .map((m) => JSON.parse(m) as { checksum: string });

    // Each message should have a unique checksum
    const checksums = newMessages.map((m) => m.checksum);
    const uniqueChecksums = [...new Set(checksums)];
    expect(uniqueChecksums.length).toBe(checksums.length);

    // Final checksum matches server state
    const finalSnap = await server.getSnapshot({
      id: "user-1",
      type: "client",
    });
    expect(checksums[checksums.length - 1]).toBe(finalSnap.checksum);
  });
});

describe("State sync: checksum race condition (P2)", () => {
  it("maintains consistent lastSentChecksum under rapid transitions", async () => {
    // P2 bug: #calculateChecksum uses await crypto.subtle.digest("SHA-256").
    // Two concurrent #sendStateUpdate calls race on attachment.lastSentChecksum.
    // With per-socket serialization, this race is eliminated.
    const state = new FakeDurableObjectState();
    const server = new TodoServer(state, ENV);
    await state.idle();

    const socket = await connectSocket(server, state, "user-1", true);
    await settle();

    // Fire rapid transitions that create concurrent checksum computations
    server.send({
      type: "ADD_TODO",
      text: "Race 1",
      caller: { id: "user-1", type: "client" },
    });
    server.send({
      type: "ADD_TODO",
      text: "Race 2",
      caller: { id: "user-1", type: "client" },
    });
    server.send({
      type: "ADD_TODO",
      text: "Race 3",
      caller: { id: "user-1", type: "client" },
    });

    await settle();

    // The attachment's lastSentChecksum must match the server's current state
    const attachment = server.attachments.get(socket);
    const finalSnap = await server.getSnapshot({
      id: "user-1",
      type: "client",
    });

    expect(attachment?.lastSentChecksum).toBe(finalSnap.checksum);

    // All checksums in sent messages must be valid SHA-256
    const messages = parseSentMessages(socket);
    for (const msg of messages) {
      expect(msg.checksum).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("State sync: event queue overflow (P3)", () => {
  it("notifies caller when events are dropped due to queue overflow", async () => {
    // P3 bug: When WebSocket is disconnected, events queue to maxQueueSize.
    // On overflow, oldest event is silently dropped via pendingEvents.shift().
    const { createActorKitClient } = await import(
      "../src/createActorKitClient"
    );

    const errors: Error[] = [];
    const client = createActorKitClient({
      host: "localhost",
      actorType: "todo",
      actorId: "list-1",
      checksum: "abc",
      accessToken: "token",
      initialSnapshot: {
        public: { ownerId: "user-1", todos: [], lastSync: null },
        private: {},
        value: "ready",
      } as never,
      onError: (err) => errors.push(err),
    });

    // Don't connect — socket stays null, events queue up
    // Send maxQueueSize + 10 events to trigger overflow
    for (let i = 0; i < 110; i++) {
      client.send({ type: "ADD_TODO", text: `Todo ${i}` } as never);
    }

    // The client should have notified about dropped events
    expect(errors.length).toBeGreaterThan(0);
    expect(
      errors.some(
        (e) =>
          e.message.includes("dropped") || e.message.includes("overflow")
      )
    ).toBe(true);
  });
});

describe("State sync: liveness — clients eventually sync (TLA+ property)", () => {
  it("all subscribed sockets receive update after a state transition", async () => {
    // TLA+ liveness: ClientsEventuallySync
    // After a state transition, all connected sockets eventually receive
    // the update with the correct final state checksum.
    const state = new FakeDurableObjectState();
    const server = new TodoServer(state, ENV);
    await state.idle();

    const socket1 = await connectSocket(server, state, "user-1", true);
    const socket2 = await connectSocket(server, state, "user-2");
    await settle();

    const baseline1 = socket1.sent.length;
    const baseline2 = socket2.sent.length;

    // Transition: add a todo
    server.send({
      type: "ADD_TODO",
      text: "Sync test",
      caller: { id: "user-1", type: "client" },
    });

    await settle();

    // BOTH sockets must receive at least one update
    const new1 = socket1.sent.slice(baseline1);
    const new2 = socket2.sent.slice(baseline2);
    expect(new1.length).toBeGreaterThanOrEqual(1);
    expect(new2.length).toBeGreaterThanOrEqual(1);

    // Both must reference the same final checksum
    const last1 = JSON.parse(new1[new1.length - 1]!) as { checksum: string };
    const last2 = JSON.parse(new2[new2.length - 1]!) as { checksum: string };
    expect(last1.checksum).toBe(last2.checksum);

    // Checksum matches server state
    const serverSnap = await server.getSnapshot({
      id: "user-1",
      type: "client",
    });
    expect(last1.checksum).toBe(serverSnap.checksum);
  });

  it("converges to final state after multiple rapid transitions", async () => {
    // Stronger liveness: multiple transitions, all eventually delivered
    const state = new FakeDurableObjectState();
    const server = new TodoServer(state, ENV);
    await state.idle();

    const socket = await connectSocket(server, state, "user-1", true);
    await settle();
    const baseline = socket.sent.length;

    // Multiple transitions
    server.send({
      type: "ADD_TODO",
      text: "A",
      caller: { id: "user-1", type: "client" },
    });
    server.send({
      type: "ADD_TODO",
      text: "B",
      caller: { id: "user-1", type: "client" },
    });

    await settle();

    // Toggle the first todo
    const midSnap = await server.getSnapshot({
      id: "user-1",
      type: "client",
    });
    const firstTodoId = midSnap.snapshot.public.todos[0]?.id;
    if (firstTodoId) {
      server.send({
        type: "TOGGLE_TODO",
        id: firstTodoId,
        caller: { id: "user-1", type: "client" },
      });
    }

    await settle();

    // Final state should reflect ALL transitions
    const finalSnap = await server.getSnapshot({
      id: "user-1",
      type: "client",
    });
    expect(finalSnap.snapshot.public.todos).toHaveLength(2);
    if (firstTodoId) {
      expect(finalSnap.snapshot.public.todos[0]?.completed).toBe(true);
    }

    // Socket should have received updates converging to the final state
    const allMessages = socket.sent.slice(baseline);
    expect(allMessages.length).toBeGreaterThanOrEqual(1);

    const lastMsg = JSON.parse(allMessages[allMessages.length - 1]!) as {
      checksum: string;
    };
    expect(lastMsg.checksum).toBe(finalSnap.checksum);
  });
});
