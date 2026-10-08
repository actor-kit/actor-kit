import {
  ControlType,
  createControlFrame,
  createDeltaFrame,
  createSnapshotFrame,
  FrameType,
  parseFrame,
} from "@actor-kit/core";
import { describe, expect, it } from "vitest";

const bytes = (...b: number[]) => new Uint8Array(b);

function header(version: number, type: number, length: number): number[] {
  return [version, type, (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff];
}

/** Places `frame` inside a larger buffer so it is parsed through a non-zero byteOffset. */
function embedded(frame: Uint8Array): Uint8Array {
  const buf = new Uint8Array(frame.byteLength + 9).fill(0xaa);
  buf.set(frame, 4);
  return buf.subarray(4, 4 + frame.byteLength);
}

describe("frame layout", () => {
  it("snapshot: header, role byte, payload", () => {
    expect(createSnapshotFrame(2, 3, bytes(9, 8))).toEqual(bytes(...header(2, 0x01, 2), 3, 9, 8));
  });

  it("delta: header, payload", () => {
    expect(createDeltaFrame(4, bytes(7))).toEqual(bytes(...header(4, 0x02, 1), 7));
  });

  it("control: version 0, control type byte, payload", () => {
    expect(createControlFrame(ControlType.ROLE_CHANGED, bytes(1, 2))).toEqual(bytes(...header(0, 0x04, 2), 0x04, 1, 2));
  });

  it("writes the payload length big-endian across all four bytes", () => {
    const payload = new Uint8Array(0x0102);
    expect(createDeltaFrame(1, payload).subarray(0, 6)).toEqual(bytes(...header(1, 0x02, 0x0102)));
    expect(createControlFrame(ControlType.ERROR, payload).subarray(2, 6)).toEqual(bytes(0, 0, 1, 2));
    expect(createSnapshotFrame(1, 0, payload).subarray(2, 6)).toEqual(bytes(0, 0, 1, 2));
  });
});

describe("parseFrame", () => {
  it("parses a snapshot inside a larger buffer", () => {
    const parsed = parseFrame(embedded(createSnapshotFrame(7, 2, bytes(5, 6, 7))));
    expect(parsed).toEqual({
      version: 7,
      type: FrameType.SNAPSHOT,
      payloadLength: 3,
      payload: bytes(5, 6, 7),
      roleIndex: 2,
    });
  });

  it("parses a control frame inside a larger buffer", () => {
    const parsed = parseFrame(embedded(createControlFrame(ControlType.REDIRECT, bytes(1))));
    expect(parsed).toEqual({
      version: 0,
      type: FrameType.CONTROL,
      payloadLength: 1,
      payload: bytes(1),
      controlType: ControlType.REDIRECT,
    });
  });

  it("parses a delta frame inside a larger buffer", () => {
    const parsed = parseFrame(embedded(createDeltaFrame(3, bytes(4, 5))));
    expect(parsed).toEqual({ version: 3, type: FrameType.DELTA, payloadLength: 2, payload: bytes(4, 5) });
  });

  it("parses MESSAGE and ACK frames with the payload right after the header", () => {
    expect(parseFrame(bytes(...header(1, 0x03, 2), 0x7b, 0x7d))).toEqual({
      version: 1,
      type: FrameType.MESSAGE,
      payloadLength: 2,
      payload: bytes(0x7b, 0x7d),
    });
    expect(parseFrame(bytes(...header(1, 0x05, 0)))).toEqual({
      version: 1,
      type: FrameType.ACK,
      payloadLength: 0,
      payload: bytes(),
    });
  });

  it("accepts a header-only frame of exactly six bytes", () => {
    expect(parseFrame(bytes(...header(1, 0x02, 0))).payload).toEqual(bytes());
  });

  it("ignores bytes past the declared payload length", () => {
    expect(parseFrame(bytes(...header(1, 0x01, 1), 0, 9, 9, 9)).payload).toEqual(bytes(9));
    expect(parseFrame(bytes(...header(1, 0x04, 1), 0x03, 8, 8)).payload).toEqual(bytes(8));
    expect(parseFrame(bytes(...header(1, 0x02, 1), 6, 6)).payload).toEqual(bytes(6));
  });

  it("rejects an unknown frame type", () => {
    expect(() => parseFrame(bytes(...header(1, 0x09, 0)))).toThrow("Unknown frame type: 9");
    expect(() => parseFrame(bytes(...header(1, 0x00, 0)))).toThrow("Unknown frame type: 0");
  });

  it("rejects an unknown control type", () => {
    expect(() => parseFrame(bytes(...header(0, 0x04, 0), 0x07))).toThrow("Unknown control type: 7");
  });

  it("rejects a control frame without a control type byte", () => {
    expect(() => parseFrame(bytes(...header(0, 0x04, 0)))).toThrow();
  });
});
