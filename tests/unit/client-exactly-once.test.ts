// @vitest-environment jsdom
/** ADR-021 spike: the client keeps each message until the actor acks it and resends it on the next socket. */
import { createActorClient } from "@actor-kit/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (event: { data?: unknown }) => void;
class ManualSocket {
  static created: ManualSocket[] = [];
  readonly listeners = new Map<string, Set<Listener>>();
  readonly sent: string[] = [];
  readyState = 0;
  binaryType = "blob";
  constructor(readonly url: string) {
    ManualSocket.created.push(this);
  }
  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 2;
  }
  emit(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  serverOpens(): void {
    this.readyState = 1;
    this.emit("open");
  }
  serverCloses(): void {
    this.readyState = 3;
    this.emit("close");
  }
  messages(): Array<{ type: string; __id?: string; n?: number }> {
    return this.sent.map((raw) => JSON.parse(raw));
  }
}
const latest = () => {
  const socket = ManualSocket.created.at(-1);
  if (socket === undefined) throw new Error("no socket");
  return socket;
};

const clients: Array<{ disconnect(): void }> = [];
function makeClient(exactlyOnce = true) {
  const client = createActorClient({
    path: "/api/c/1",
    host: "example.com",
    initialView: { n: 0 },
    getToken: () => "t",
    WebSocketImpl: ManualSocket,
    heartbeat: false,
    exactlyOnce,
  });
  clients.push(client);
  return client;
}

beforeEach(() => {
  ManualSocket.created = [];
  vi.useFakeTimers();
});
afterEach(() => {
  for (const client of clients.splice(0)) client.disconnect();
  vi.useRealTimers();
});

describe("exactlyOnce sends", () => {
  it("each message carries a fresh id from one client id", async () => {
    const client = makeClient();
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    latest().serverOpens();
    client.send({ type: "A" });
    client.send({ type: "B" });
    const [a, b] = latest().messages();
    expect(a?.type).toBe("A");
    expect(a?.__id).toMatch(/^.+:1$/);
    expect(b?.__id).toBe(a?.__id?.replace(/:1$/, ":2"));
  });

  it("unacked messages are resent, in order, after __reconnect on the next socket; acked ones are not", async () => {
    const client = makeClient();
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    latest().serverOpens();
    latest().emit("message", { data: JSON.stringify({ type: "snapshot", data: { n: 1 } }) });
    client.send({ type: "A", n: 1 });
    client.send({ type: "B", n: 2 });
    client.send({ type: "C", n: 3 });
    const ids = latest()
      .messages()
      .map((m) => m.__id);
    latest().emit("message", { data: JSON.stringify({ type: "__ack", id: ids[1] }) });

    latest().serverCloses();
    await vi.advanceTimersByTimeAsync(1000);
    latest().serverOpens();
    expect(
      latest()
        .messages()
        .map((m) => m.type),
    ).toEqual(["A", "C"]);
    expect(
      latest()
        .messages()
        .map((m) => m.__id),
    ).toEqual([ids[0], ids[2]]);
  });

  it("a send while reconnecting goes out once the socket opens", async () => {
    const client = makeClient();
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    latest().serverOpens();
    latest().serverCloses();
    client.send({ type: "LATE" });
    await vi.advanceTimersByTimeAsync(1000);
    latest().serverOpens();
    expect(
      latest()
        .messages()
        .map((m) => m.type),
    ).toEqual(["LATE"]);
  });

  it("disconnect() forgets unacked messages; a send before connect() is dropped", async () => {
    const client = makeClient();
    client.send({ type: "EARLY" });
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    latest().serverOpens();
    client.send({ type: "A" });
    client.disconnect();
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    latest().serverOpens();
    expect(latest().messages()).toEqual([]);
  });

  it("off by default: no ids", async () => {
    const client = makeClient(false);
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    latest().serverOpens();
    client.send({ type: "A" });
    expect(latest().messages()).toEqual([{ type: "A" }]);
  });
});
