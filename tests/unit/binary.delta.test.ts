import { applyDelta, boolean, encode, encodeDelta, float32, schema, string, uint32 } from "@actor-kit/core";
import { describe, expect, it } from "vitest";

/** The value, or a failed test when it is null or undefined. */
function defined<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected a value");
  return value;
}

describe("binary delta encoding", () => {
  const PlayerView = schema({
    x: float32,
    y: float32,
    z: float32,
    health: uint32,
    name: string,
    alive: boolean,
  });

  it("returns null when nothing changed", () => {
    const data = { x: 1, y: 2, z: 3, health: 100, name: "player", alive: true };
    const delta = encodeDelta(PlayerView, data, data);
    expect(delta).toBeNull();
  });

  it("encodes only changed fields", () => {
    const prev = { x: 1, y: 2, z: 3, health: 100, name: "player", alive: true };
    const next = { x: 1, y: 5, z: 3, health: 100, name: "player", alive: true };

    const delta = encodeDelta(PlayerView, prev, next);
    expect(delta).not.toBeNull();

    // Delta should be smaller than full encode
    const full = encode(PlayerView, next);
    expect(delta?.byteLength).toBeLessThan(full.byteLength);
  });

  it("applyDelta reconstructs the correct state", () => {
    const prev = { x: 1, y: 2, z: 3, health: 100, name: "player", alive: true };
    const next = { x: 1, y: 5, z: 3, health: 80, name: "player", alive: true };

    const delta = encodeDelta(PlayerView, prev, next);
    expect(delta).not.toBeNull();

    const result = applyDelta(PlayerView, prev, defined(delta));
    expect(result.y).toBeCloseTo(5, 0);
    expect(result.health).toBe(80);
    expect(result.x).toBeCloseTo(1, 0);
    expect(result.name).toBe("player");
  });

  it("handles all fields changed", () => {
    const prev = { x: 1, y: 2, z: 3, health: 100, name: "a", alive: true };
    const next = { x: 10, y: 20, z: 30, health: 50, name: "b", alive: false };

    const delta = encodeDelta(PlayerView, prev, next);
    expect(delta).not.toBeNull();

    const result = applyDelta(PlayerView, prev, defined(delta));
    expect(result.health).toBe(50);
    expect(result.name).toBe("b");
    expect(result.alive).toBe(false);
  });

  it("handles single field changed", () => {
    const prev = { x: 1, y: 2, z: 3, health: 100, name: "player", alive: true };
    const next = { x: 1, y: 2, z: 3, health: 99, name: "player", alive: true };

    const delta = encodeDelta(PlayerView, prev, next);
    expect(delta).not.toBeNull();

    // Bitmask (1 byte for 6 fields) + uint32 health (4 bytes) = 5 bytes
    expect(delta?.byteLength).toBe(5);

    const result = applyDelta(PlayerView, prev, defined(delta));
    expect(result.health).toBe(99);
  });

  it("position update delta is compact", () => {
    const PosView = schema({ x: float32, y: float32, z: float32 });
    const prev = { x: 0, y: 0, z: 0 };
    const next = { x: 1.5, y: 2.5, z: 3.5 };

    const delta = encodeDelta(PosView, prev, next);
    expect(delta).not.toBeNull();
    // Bitmask (1 byte) + 3 floats (12 bytes) = 13 bytes
    expect(delta?.byteLength).toBe(13);
  });
});
