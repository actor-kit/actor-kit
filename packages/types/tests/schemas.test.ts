import { describe, expect, it } from "vitest";
import { CallerStringSchema } from "@actor-kit/types";

describe("CallerStringSchema", () => {
  it("parses anonymous and hyphenated caller ids", () => {
    expect(CallerStringSchema.parse("anonymous")).toEqual({
      id: "anonymous",
      type: "client",
    });

    expect(CallerStringSchema.parse("service-user-123")).toEqual({
      id: "user-123",
      type: "service",
    });
  });

  it("rejects invalid caller strings", () => {
    const invalidType = CallerStringSchema.safeParse("unknown-user");
    expect(invalidType.success).toBe(false);

    const missingId = CallerStringSchema.safeParse("client-");
    expect(missingId.success).toBe(false);

    const malformed = CallerStringSchema.safeParse("client");
    expect(malformed.success).toBe(false);
  });
});
