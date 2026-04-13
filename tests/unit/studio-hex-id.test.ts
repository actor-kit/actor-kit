import { describe, expect, it } from "vitest";

// Test the isHexId regex from the middleware
// Duplicated here since the middleware is a CF Worker module
function isHexId(id: string): boolean {
  return /^[0-9a-f]{64}$/i.test(id);
}

describe("isHexId", () => {
  it("matches a valid 64-char lowercase hex string", () => {
    expect(isHexId("dea9a98adec073229fad46851382e3413fbc197355d236d5e3a038eb235c728f")).toBe(true);
  });

  it("matches a valid 64-char uppercase hex string", () => {
    expect(isHexId("DEA9A98ADEC073229FAD46851382E3413FBC197355D236D5E3A038EB235C728F")).toBe(true);
  });

  it("matches mixed case", () => {
    expect(isHexId("dea9A98adEC073229fad46851382e3413FBC197355d236d5e3a038eb235c728F")).toBe(true);
  });

  it("rejects 63-char hex string (too short)", () => {
    expect(isHexId("dea9a98adec073229fad46851382e3413fbc197355d236d5e3a038eb235c728")).toBe(false);
  });

  it("rejects 65-char hex string (too long)", () => {
    expect(isHexId("dea9a98adec073229fad46851382e3413fbc197355d236d5e3a038eb235c728ff")).toBe(false);
  });

  it("rejects human-readable actor name", () => {
    expect(isHexId("my-counter")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isHexId("")).toBe(false);
  });

  it("rejects string with non-hex characters", () => {
    expect(isHexId("zea9a98adec073229fad46851382e3413fbc197355d236d5e3a038eb235c728f")).toBe(false);
  });

  it("rejects string with spaces", () => {
    expect(isHexId("dea9a98adec073229fad46851382e341 fbc197355d236d5e3a038eb235c728f")).toBe(false);
  });

  it("rejects UUID format", () => {
    expect(isHexId("dea9a98a-dec0-7322-9fad-46851382e341")).toBe(false);
  });
});
