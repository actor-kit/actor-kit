import { formatEffectId, parseEffectId } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";

describe("effect ids (ADR-015 D1)", () => {
  it("formats seq:index", () => {
    expect(formatEffectId(12, 0)).toBe("12:0");
    expect(formatEffectId(3, 7)).toBe("3:7");
  });

  it("parses seq:index back into integers", () => {
    expect(parseEffectId("12:3")).toEqual({ seq: 12, index: 3 });
    expect(parseEffectId("0:0")).toEqual({ seq: 0, index: 0 });
    expect(parseEffectId("7:0")).toEqual({ seq: 7, index: 0 });
    expect(parseEffectId("123:45")).toEqual({ seq: 123, index: 45 });
    expect(parseEffectId("5:678")).toEqual({ seq: 5, index: 678 });
  });

  it.each(["", "12", "12:", ":3", "a:b", "1:2:3", "-1:0", "1:-2", "1.5:0", "01:0x", " 1:0"])(
    "rejects malformed id %j",
    (id) => {
      expect(parseEffectId(id)).toBeNull();
    },
  );
});
