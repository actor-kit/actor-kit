import { describe, expect, it } from "vitest";
import { parseDuration } from "../../packages/actor-kit/src/runtime/timers";

describe("parseDuration — kill survivors", () => {
  it("0 seconds = 0ms", () => {
    expect(parseDuration("0 seconds")).toBe(0);
  });

  it("1 second = 1000ms", () => {
    expect(parseDuration("1 second")).toBe(1000);
  });

  it("60 seconds = 60000ms", () => {
    expect(parseDuration("60 seconds")).toBe(60000);
  });

  it("0 minutes = 0ms", () => {
    expect(parseDuration("0 minutes")).toBe(0);
  });

  it("1 minute = 60000ms", () => {
    expect(parseDuration("1 minute")).toBe(60000);
  });

  it("0 hours = 0ms", () => {
    expect(parseDuration("0 hours")).toBe(0);
  });

  it("2 hours = 7200000ms", () => {
    expect(parseDuration("2 hours")).toBe(7200000);
  });

  it("0 days = 0ms", () => {
    expect(parseDuration("0 days")).toBe(0);
  });

  it("365 days", () => {
    expect(parseDuration("365 days")).toBe(365 * 86400000);
  });

  it("rejects non-numeric value", () => {
    expect(() => parseDuration("abc seconds")).toThrow();
  });

  it("rejects missing unit", () => {
    expect(() => parseDuration("5")).toThrow();
  });

  it("rejects empty unit", () => {
    expect(() => parseDuration("5 ")).toThrow();
  });
});
