/**
 * decode() and applyDelta() read exactly the bytes they are given (ADR-020 D). A payload that ends
 * early, or has bytes left over, was written with another schema (a client bundle older than the
 * Worker) or was damaged: it is invalid_frame, never a view with a string cut short ("bot" → "bo")
 * or a delta read as "nothing changed".
 */
import {
  applyDelta,
  array,
  decode,
  encode,
  encodeDelta,
  nullable,
  record,
  schema,
  string,
  uint8,
  uint32,
} from "@actor-kit/core";
import { describe, expect, it } from "vitest";

const S = schema({ count: uint32, lastCaller: string });
const prev = { count: 1, lastCaller: "bot" };
const invalid = (message: string) => expect.objectContaining({ code: "invalid_frame", message });

describe("decode reads the whole payload", () => {
  const full = encode(S, prev);

  it("a whole payload decodes", () => {
    expect(decode(S, full)).toEqual(prev);
  });

  it("a string that runs past the end is invalid_frame, not a shorter string", () => {
    expect(() => decode(S, full.subarray(0, full.length - 1))).toThrow(
      invalid("View payload ends early: it needs 1 byte more. Use the same view schema on the client and the Worker."),
    );
  });

  it.each([0, 1, 3])("a payload cut to %i bytes is invalid_frame (ends early)", (n) => {
    expect(() => decode(S, full.subarray(0, n))).toThrow(
      expect.objectContaining({ code: "invalid_frame", message: expect.stringContaining("View payload ends early") }),
    );
  });

  it("bytes left over after the last field are invalid_frame, naming how many", () => {
    const padded = new Uint8Array(full.length + 2);
    padded.set(full);
    expect(() => decode(S, padded)).toThrow(
      invalid(
        "View payload has 2 bytes left over after its last field. Use the same view schema on the client and the Worker.",
      ),
    );
  });

  it("a payload written by a schema with an extra field is invalid_frame", () => {
    const Newer = schema({ count: uint32, lastCaller: string, round: uint8 });
    expect(() => decode(S, encode(Newer, { ...prev, round: 3 }))).toThrow(
      expect.objectContaining({ code: "invalid_frame" }),
    );
  });

  it("nested schemas, arrays, records and nullables decode whole", () => {
    const Rich = schema({
      seats: array(schema({ name: string, score: nullable(uint32) })),
      tags: record(uint8),
    });
    const value = {
      seats: [
        { name: "ana", score: null },
        { name: "juneau", score: 4 },
      ],
      tags: { a: 1 },
    };
    expect(decode(Rich, encode(Rich, value))).toEqual(value);
  });
});

describe("applyDelta reads the whole payload", () => {
  const next = { count: 2, lastCaller: "bot" };
  const delta = encodeDelta(S, prev, next);
  if (delta === null) throw new Error("expected a delta");

  it("a whole delta applies", () => {
    expect(applyDelta(S, prev, delta)).toEqual(next);
  });

  it("an empty delta is invalid_frame (it has no change bitmask), not 'nothing changed'", () => {
    expect(() => applyDelta(S, prev, new Uint8Array(0))).toThrow(
      invalid("Delta payload ends early: it needs 1 byte more. Use the same view schema on the client and the Worker."),
    );
  });

  it("a delta cut short is invalid_frame", () => {
    expect(() => applyDelta(S, prev, delta.subarray(0, delta.length - 1))).toThrow(
      expect.objectContaining({ code: "invalid_frame", message: expect.stringContaining("Delta payload ends early") }),
    );
  });

  it("bytes left over after a delta are invalid_frame", () => {
    const padded = new Uint8Array(delta.length + 1);
    padded.set(delta);
    expect(() => applyDelta(S, prev, padded)).toThrow(
      invalid(
        "Delta payload has 1 byte left over after its last field. Use the same view schema on the client and the Worker.",
      ),
    );
  });
});
