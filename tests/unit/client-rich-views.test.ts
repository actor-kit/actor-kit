// @vitest-environment jsdom
/**
 * ADR-019 C on the client: a client holding a view schema with signed ints, enums, records, unions
 * and json decodes snapshot and delta frames into the server's view, keeps the last good view when
 * a json value fails its schema, and reports the server's checksum on reconnect (so key order
 * survives deltas). Seam: a hand-driven fake socket.
 */

import { createActorClient } from "@actor-kit/client";
import {
  createDeltaFrame,
  createSnapshotFrame,
  encode,
  encodeDelta,
  enumOf,
  type Infer,
  int16,
  json,
  record,
  schema,
  uint8,
  union,
  xxh64,
} from "@actor-kit/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

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

  receiveFrame(bytes: Uint8Array): void {
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    this.emit("message", { data: copy });
  }
}

function latest(): ManualSocket {
  const socket = ManualSocket.created.at(-1);
  if (!socket) throw new Error("no socket created");
  return socket;
}

const Board = schema({
  phase: enumOf(["lobby", "playing", "done"]),
  delta: int16,
  scores: record(int16),
  turn: union("kind", {
    waiting: schema({}),
    acting: schema({ player: uint8, seconds: uint8 }),
  }),
  meta: json(z.object({ tags: z.array(z.string()) })),
});
type BoardView = Infer<typeof Board>;

const first: BoardView = {
  phase: "lobby",
  delta: -3,
  scores: { ann: -2, bo: 5 },
  turn: { kind: "waiting" },
  meta: { tags: ["new"] },
};
const second: BoardView = {
  phase: "playing",
  delta: -3,
  scores: { bo: 7, cy: -1 },
  turn: { kind: "acting", player: 1, seconds: 30 },
  meta: { tags: ["new"] },
};
const third: BoardView = { ...second, turn: { kind: "acting", player: 1, seconds: 29 } };

const clients: Array<{ disconnect(): void }> = [];

async function connectedClient() {
  const client = createActorClient({
    path: "/api/board/b1",
    host: "example.com",
    initialView: first,
    viewSchema: Board,
    WebSocketImpl: ManualSocket,
  });
  clients.push(client);
  client.connect();
  await vi.advanceTimersByTimeAsync(0);
  const socket = latest();
  socket.serverOpens();
  return { client, socket };
}

function deltaFrame(prev: BoardView, next: BoardView): Uint8Array {
  const payload = encodeDelta(Board, prev, next);
  if (payload === null) throw new Error("expected a delta");
  return createDeltaFrame(1, payload);
}

beforeEach(() => {
  ManualSocket.created = [];
  vi.useFakeTimers();
});

afterEach(() => {
  for (const client of clients.splice(0)) client.disconnect();
  vi.useRealTimers();
});

describe("client decoding of the richer view schemas", () => {
  it("decodes a snapshot, then deltas that change records and unions", async () => {
    const { client, socket } = await connectedClient();

    socket.receiveFrame(createSnapshotFrame(1, 0, encode(Board, first)));
    expect(client.view).toEqual(first);

    socket.receiveFrame(deltaFrame(first, second));
    expect(client.view).toEqual(second);

    socket.receiveFrame(deltaFrame(second, third));
    expect(client.view).toEqual(third);
  });

  it("reports the server's checksum on reconnect after deltas", async () => {
    const { socket } = await connectedClient();
    socket.receiveFrame(createSnapshotFrame(1, 0, encode(Board, first)));
    socket.receiveFrame(deltaFrame(first, second));

    socket.serverCloses();
    await vi.advanceTimersByTimeAsync(60_000);
    latest().serverOpens();

    expect(latest().sent.map((raw): unknown => JSON.parse(raw))).toContainEqual({
      type: "__reconnect",
      lastChecksum: xxh64(JSON.stringify(second)),
    });
  });

  it("keeps the last good view when a json value fails its schema", async () => {
    const { client, socket } = await connectedClient();
    socket.receiveFrame(createSnapshotFrame(1, 0, encode(Board, first)));

    // The same layout with an unchecked json field, so the frame carries tags the client rejects.
    const Loose = schema({ ...Board.shape, meta: json(z.unknown()) });
    const bad = encode(Loose, { ...first, meta: { tags: [1] } });
    socket.receiveFrame(createSnapshotFrame(1, 0, bad));

    expect(client.view).toEqual(first);
  });
});
