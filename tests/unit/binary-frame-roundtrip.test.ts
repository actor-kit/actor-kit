import {
  applyDelta,
  array,
  boolean,
  createDeltaFrame,
  createSnapshotFrame,
  decode,
  encode,
  encodeDelta,
  FrameType,
  float32,
  parseFrame,
  schema,
  string,
  uint32,
} from "@actor-kit/core";
import { describe, expect, it } from "vitest";

describe("binary frame round-trip (encode → frame → parse → decode)", () => {
  const PlayerView = schema({
    x: float32,
    y: float32,
    health: uint32,
    name: string,
    alive: boolean,
  });

  it("snapshot frame round-trips correctly", () => {
    const data = { x: 1.5, y: 2.5, health: 100, name: "player1", alive: true };

    // Encode → Frame → Parse → Decode
    const payload = encode(PlayerView, data);
    const frame = createSnapshotFrame(1, 0, payload);
    const parsed = parseFrame(frame);
    const decoded = decode(PlayerView, parsed.payload);

    expect(parsed.type).toBe(FrameType.SNAPSHOT);
    expect(parsed.version).toBe(1);
    expect(parsed.roleIndex).toBe(0);
    expect((decoded as { health: number }).health).toBe(100);
    expect((decoded as { name: string }).name).toBe("player1");
    expect((decoded as { alive: boolean }).alive).toBe(true);
  });

  it("delta frame round-trips correctly", () => {
    const prev = { x: 1, y: 2, health: 100, name: "player1", alive: true };
    const next = { x: 1, y: 5, health: 80, name: "player1", alive: true };

    const deltaPayload = encodeDelta(PlayerView, prev, next);
    expect(deltaPayload).not.toBeNull();

    const frame = createDeltaFrame(1, deltaPayload!);
    const parsed = parseFrame(frame);

    expect(parsed.type).toBe(FrameType.DELTA);

    const result = applyDelta(PlayerView, prev, parsed.payload);
    expect(result.health).toBe(80);
    expect(result.name).toBe("player1");
  });

  it("todo list view round-trips through frame", () => {
    const TodoItem = schema({ id: uint32, text: string, done: boolean });
    const TodoView = schema({ items: array(TodoItem), count: uint32 });

    const data = {
      items: [
        { id: 1, text: "Buy milk", done: false },
        { id: 2, text: "Walk dog", done: true },
        { id: 3, text: "Code", done: false },
      ],
      count: 3,
    };

    const payload = encode(TodoView, data);
    const frame = createSnapshotFrame(2, 1, payload);
    const parsed = parseFrame(frame);
    const decoded = decode(TodoView, parsed.payload);

    expect(decoded).toEqual(data);
    expect(parsed.version).toBe(2);
    expect(parsed.roleIndex).toBe(1);
  });

  it("empty arrays encode and decode correctly through frame", () => {
    const ListView = schema({ items: array(uint32), label: string });
    const data = { items: [], label: "empty" };

    const payload = encode(ListView, data);
    const frame = createSnapshotFrame(1, 0, payload);
    const parsed = parseFrame(frame);
    const decoded = decode(ListView, parsed.payload);

    expect(decoded).toEqual(data);
  });

  it("frame size is compact for position updates", () => {
    const PosView = schema({ x: float32, y: float32, z: float32 });
    const payload = encode(PosView, { x: 1, y: 2, z: 3 });
    const frame = createSnapshotFrame(1, 0, payload);

    // Header(6) + role(1) + 3×float32(12) = 19 bytes
    expect(frame.byteLength).toBe(19);
  });

  it("delta frame size is compact for single field change", () => {
    const prev = { x: 1, y: 2, health: 100, name: "p", alive: true };
    const next = { x: 1, y: 2, health: 99, name: "p", alive: true };

    const deltaPayload = encodeDelta(PlayerView, prev, next);
    expect(deltaPayload).not.toBeNull();

    const frame = createDeltaFrame(1, deltaPayload!);
    // Header(6) + bitmask(1) + uint32(4) = 11 bytes
    expect(frame.byteLength).toBe(11);
  });
});
