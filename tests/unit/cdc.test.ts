import { describe, it, expect } from "vitest";
import { createChangeEntry, type ChangeEntry } from "../../packages/actor-kit/src/runtime/cdc";

describe("CDC (Change Data Capture)", () => {
  it("creates a change entry with event metadata", () => {
    const entry = createChangeEntry({
      eventType: "ADD_TODO",
      caller: "alice",
      role: "owner",
      prevChecksum: "abc123",
      nextChecksum: "def456",
    });

    expect(entry.eventType).toBe("ADD_TODO");
    expect(entry.caller).toBe("alice");
    expect(entry.role).toBe("owner");
    expect(entry.prevChecksum).toBe("abc123");
    expect(entry.nextChecksum).toBe("def456");
    expect(typeof entry.id).toBe("string");
    expect(typeof entry.timestamp).toBe("number");
  });

  it("generates unique IDs", () => {
    const a = createChangeEntry({ eventType: "A", caller: "x", role: "r", prevChecksum: "", nextChecksum: "" });
    const b = createChangeEntry({ eventType: "B", caller: "x", role: "r", prevChecksum: "", nextChecksum: "" });
    expect(a.id).not.toBe(b.id);
  });
});
