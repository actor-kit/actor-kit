import { compareEffectIds, formatEffectId, parseEffectId } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";

describe("effect ids (ADR-015 D1)", () => {
  it("formats seq:index", () => {
    expect(formatEffectId(12, 0)).toBe("12:0");
    expect(formatEffectId(3, 7)).toBe("3:7");
  });

  it("parses seq:index back into integers", () => {
    expect(parseEffectId("12:3")).toEqual({ seq: 12, index: 3 });
    expect(parseEffectId("0:0")).toEqual({ seq: 0, index: 0 });
  });

  it.each(["", "12", "12:", ":3", "a:b", "1:2:3", "-1:0", "1:-2", "1.5:0", "01:0x", " 1:0"])(
    "rejects malformed id %j",
    (id) => {
      expect(parseEffectId(id)).toBeNull();
    },
  );

  it("orders by (seq, index) as integers, not as strings", () => {
    const ids = ["10:0", "9:1", "9:10", "9:2", "100:0", "2:0"];
    expect([...ids].sort(compareEffectIds)).toEqual(["2:0", "9:1", "9:2", "9:10", "10:0", "100:0"]);
  });

  it("compares equal ids as 0 and sorts malformed ids last", () => {
    expect(compareEffectIds("4:2", "4:2")).toBe(0);
    expect(compareEffectIds("4:2", "4:3")).toBeLessThan(0);
    expect(compareEffectIds("5:0", "4:3")).toBeGreaterThan(0);
    expect(compareEffectIds("outbox-1-1", "4:3")).toBeGreaterThan(0);
    expect(compareEffectIds("4:3", "outbox-1-1")).toBeLessThan(0);
    expect(compareEffectIds("outbox-a", "outbox-b")).toBeLessThan(0);
  });
});
