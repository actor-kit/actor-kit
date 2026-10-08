import { applyDelta, array, decode, encode, encodeDelta, nullable, schema, string, uint8 } from "@actor-kit/core";
import { describe, expect, it } from "vitest";

// A changed field's value in a DELTA frame is encoded exactly as in a SNAPSHOT
// (docs/binary-protocol.md), so nested schemas carry their own null bitmask.

describe("delta — nullable fields inside nested schemas", () => {
  const Player = schema({ nick: nullable(string), hp: uint8 });
  const S = schema({ player: Player, tag: uint8 });

  it("round-trips a nested nullable string value", () => {
    const prev = { player: { nick: null, hp: 1 }, tag: 7 };
    const next = { player: { nick: "ann", hp: 2 }, tag: 7 };
    const delta = encodeDelta(S, prev, next);
    if (delta === null) throw new Error("expected a delta");
    expect(applyDelta(S, prev, delta)).toEqual(next);
  });

  it("round-trips a nested value becoming null", () => {
    const prev = { player: { nick: "ann", hp: 2 }, tag: 7 };
    const next = { player: { nick: null, hp: 3 }, tag: 9 };
    const delta = encodeDelta(S, prev, next);
    if (delta === null) throw new Error("expected a delta");
    expect(applyDelta(S, prev, delta)).toEqual(next);
  });

  it("encodes a changed nested schema with the same bytes as a snapshot of it", () => {
    const prev = { player: { nick: null, hp: 1 }, tag: 7 };
    const next = { player: { nick: "ann", hp: 2 }, tag: 7 };
    const delta = encodeDelta(S, prev, next);
    // change bitmask (bit 0 = player), then player encoded as a full value
    expect(delta).toEqual(new Uint8Array([0b01, ...encode(Player, next.player)]));
  });

  it("round-trips arrays of schemas with nullable fields", () => {
    const L = schema({ items: array(Player) });
    const prev = { items: [] };
    const next = {
      items: [
        { nick: "a", hp: 1 },
        { nick: null, hp: 2 },
      ],
    };
    const delta = encodeDelta(L, prev, next);
    if (delta === null) throw new Error("expected a delta");
    expect(applyDelta(L, prev, delta)).toEqual(next);
    expect(decode(L, encode(L, next))).toEqual(next);
  });
});
