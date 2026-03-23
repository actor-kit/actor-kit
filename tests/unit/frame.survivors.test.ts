import { describe, expect, it } from "vitest";
import {
  ControlType,
  createControlFrame,
  createDeltaFrame,
  createSnapshotFrame,
  FrameType,
  parseFrame,
} from "../../packages/actor-kit/src/schema/frame";

describe("frame — kill survivors", () => {
  it("snapshot frame version is preserved", () => {
    const frame = createSnapshotFrame(5, 0, new Uint8Array([1]));
    const parsed = parseFrame(frame);
    expect(parsed.version).toBe(5);
  });

  it("snapshot frame role index is preserved", () => {
    const frame = createSnapshotFrame(1, 3, new Uint8Array([1]));
    const parsed = parseFrame(frame);
    expect(parsed.roleIndex).toBe(3);
  });

  it("delta frame has no role index", () => {
    const frame = createDeltaFrame(1, new Uint8Array([1, 2]));
    const parsed = parseFrame(frame);
    expect(parsed.roleIndex).toBeUndefined();
  });

  it("control frame version is 0", () => {
    const frame = createControlFrame(ControlType.ERROR, new Uint8Array([1]));
    const parsed = parseFrame(frame);
    expect(parsed.version).toBe(0);
  });

  it("control frame preserves control type", () => {
    for (const ct of [ControlType.REDIRECT, ControlType.SCHEMA_CHANGED, ControlType.ERROR, ControlType.ROLE_CHANGED]) {
      const frame = createControlFrame(ct, new Uint8Array([]));
      const parsed = parseFrame(frame);
      expect(parsed.controlType).toBe(ct);
    }
  });

  it("payload length matches actual payload", () => {
    const payload = new Uint8Array([10, 20, 30, 40, 50]);
    const frame = createSnapshotFrame(1, 0, payload);
    const parsed = parseFrame(frame);
    expect(parsed.payloadLength).toBe(5);
    expect(parsed.payload.byteLength).toBe(5);
  });

  it("throws on frame shorter than header", () => {
    expect(() => parseFrame(new Uint8Array([1, 2, 3]))).toThrow(/too short/);
  });

  it("empty payload round-trips", () => {
    const frame = createSnapshotFrame(1, 0, new Uint8Array([]));
    const parsed = parseFrame(frame);
    expect(parsed.payloadLength).toBe(0);
    expect(parsed.payload.byteLength).toBe(0);
  });

  it("large payload (1000 bytes) round-trips", () => {
    const payload = new Uint8Array(1000).fill(42);
    const frame = createSnapshotFrame(1, 0, payload);
    const parsed = parseFrame(frame);
    expect(parsed.payload.byteLength).toBe(1000);
    expect(parsed.payload[0]).toBe(42);
    expect(parsed.payload[999]).toBe(42);
  });
});
