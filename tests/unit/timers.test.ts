import { parseDuration } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";

describe("parseDuration()", () => {
  it("parses seconds", () => {
    expect(parseDuration("30 seconds")).toBe(30_000);
    expect(parseDuration("1 second")).toBe(1_000);
  });

  it("parses minutes", () => {
    expect(parseDuration("5 minutes")).toBe(300_000);
    expect(parseDuration("1 minute")).toBe(60_000);
  });

  it("parses hours", () => {
    expect(parseDuration("1 hour")).toBe(3_600_000);
    expect(parseDuration("24 hours")).toBe(86_400_000);
  });

  it("parses days", () => {
    expect(parseDuration("1 day")).toBe(86_400_000);
    expect(parseDuration("7 days")).toBe(604_800_000);
  });

  it("throws on invalid format", () => {
    expect(() => parseDuration("foo")).toThrow();
    expect(() => parseDuration("")).toThrow();
    expect(() => parseDuration("5 bananas")).toThrow();
  });

  it("handles extra whitespace", () => {
    expect(parseDuration("  5   minutes  ")).toBe(300_000);
  });
});
