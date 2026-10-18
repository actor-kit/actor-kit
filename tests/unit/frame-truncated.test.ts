/**
 * A frame cut short (its header promises more payload than arrived) is invalid, not a frame with a
 * shorter payload: decoding the short payload can succeed and silently apply the wrong view
 * (a delta read as "nothing changed"), which kept a client behind (ADR-020 D).
 */
import {
  ControlType,
  createControlFrame,
  createDeltaFrame,
  createSnapshotFrame,
  encode,
  encodeDelta,
  parseFrame,
  schema,
  string,
  uint32,
} from "@actor-kit/core";
import { describe, expect, it } from "vitest";

const S = schema({ count: uint32, lastCaller: string });
const delta = encodeDelta(S, { count: 1, lastCaller: "a" }, { count: 2, lastCaller: "a" });
if (delta === null) throw new Error("expected a delta");

const frames: Array<[string, Uint8Array, number]> = [
  ["snapshot", createSnapshotFrame(1, 0, encode(S, { count: 1, lastCaller: "bot" })), 7],
  ["delta", createDeltaFrame(1, delta), 6],
  ["control", createControlFrame(ControlType.REDIRECT, new TextEncoder().encode('{"actorId":"x"}')), 7],
];

describe("parseFrame and a frame cut short", () => {
  it.each(frames)("a %s frame with its whole payload parses", (_name, frame, start) => {
    expect(parseFrame(frame).payload).toEqual(frame.subarray(start));
  });

  it.each(frames)("a %s frame missing its last byte is invalid_frame", (_name, frame) => {
    expect(() => parseFrame(frame.subarray(0, frame.byteLength - 1))).toThrow(
      expect.objectContaining({ code: "invalid_frame" }),
    );
  });

  it.each(frames)("a %s frame with only its header is invalid_frame, naming the lengths", (_name, frame, start) => {
    const cut = frame.subarray(0, start);
    const promised = frame.byteLength - start;
    expect(() => parseFrame(cut)).toThrow(`Frame cut short: header promises ${promised} payload bytes, got 0.`);
  });

  it("an empty payload is a whole frame", () => {
    expect(parseFrame(createDeltaFrame(1, new Uint8Array(0))).payload).toEqual(new Uint8Array(0));
  });

  it("bytes after the payload are not part of it", () => {
    const frame = createDeltaFrame(1, delta);
    const padded = new Uint8Array(frame.byteLength + 2);
    padded.set(frame);
    expect(parseFrame(padded).payload).toEqual(delta);
  });
});
