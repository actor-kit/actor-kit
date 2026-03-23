import { describe, it, expect } from "vitest";
import {
  createSnapshotFrame,
  createDeltaFrame,
  createControlFrame,
  parseFrame,
  FrameType,
  ControlType,
} from "../../packages/actor-kit/src/schema/frame";

describe("frame format", () => {
  describe("createSnapshotFrame", () => {
    it("creates a frame with correct header", () => {
      const payload = new Uint8Array([1, 2, 3, 4]);
      const frame = createSnapshotFrame(1, 42, payload);

      expect(frame[0]).toBe(1); // version
      expect(frame[1]).toBe(FrameType.SNAPSHOT); // type
      // Bytes 2-5: payload length (uint32 big-endian)
      const view = new DataView(frame.buffer, frame.byteOffset);
      expect(view.getUint32(2, false)).toBe(payload.byteLength);
      // Role byte
      expect(frame[6]).toBe(42); // role index
      // Payload follows
      expect(frame[7]).toBe(1);
      expect(frame[8]).toBe(2);
    });
  });

  describe("createDeltaFrame", () => {
    it("creates a delta frame", () => {
      const payload = new Uint8Array([10, 20, 30]);
      const frame = createDeltaFrame(1, payload);

      expect(frame[0]).toBe(1); // version
      expect(frame[1]).toBe(FrameType.DELTA);
      const view = new DataView(frame.buffer, frame.byteOffset);
      expect(view.getUint32(2, false)).toBe(payload.byteLength);
    });
  });

  describe("createControlFrame", () => {
    it("creates a redirect control frame", () => {
      const payload = new TextEncoder().encode(JSON.stringify({ actorType: "zone", actorId: "north" }));
      const frame = createControlFrame(ControlType.REDIRECT, payload);

      expect(frame[0]).toBe(0); // version 0 for control
      expect(frame[1]).toBe(FrameType.CONTROL);
      expect(frame[6]).toBe(ControlType.REDIRECT);
    });

    it("creates an error control frame", () => {
      const payload = new TextEncoder().encode("guard failed");
      const frame = createControlFrame(ControlType.ERROR, payload);

      expect(frame[6]).toBe(ControlType.ERROR);
    });
  });

  describe("parseFrame", () => {
    it("round-trips a snapshot frame", () => {
      const payload = new Uint8Array([1, 2, 3, 4, 5]);
      const frame = createSnapshotFrame(2, 0, payload);
      const parsed = parseFrame(frame);

      expect(parsed.version).toBe(2);
      expect(parsed.type).toBe(FrameType.SNAPSHOT);
      expect(parsed.roleIndex).toBe(0);
      expect(new Uint8Array(parsed.payload)).toEqual(payload);
    });

    it("round-trips a delta frame", () => {
      const payload = new Uint8Array([10, 20]);
      const frame = createDeltaFrame(1, payload);
      const parsed = parseFrame(frame);

      expect(parsed.type).toBe(FrameType.DELTA);
      expect(new Uint8Array(parsed.payload)).toEqual(payload);
    });

    it("round-trips a control frame", () => {
      const payload = new TextEncoder().encode("test");
      const frame = createControlFrame(ControlType.SCHEMA_CHANGED, payload);
      const parsed = parseFrame(frame);

      expect(parsed.type).toBe(FrameType.CONTROL);
      expect(parsed.controlType).toBe(ControlType.SCHEMA_CHANGED);
    });
  });
});
