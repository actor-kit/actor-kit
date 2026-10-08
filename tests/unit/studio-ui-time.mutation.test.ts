/**
 * Relative timestamps shown in the dashboard ("Last Active") and on the actor
 * detail page (timeline rows, connection times).
 */
import { describe, expect, it } from "vitest";
import { recentTime, relativeTime } from "../../packages/studio/ui/src/relative-time";

const NOW = 1_700_000_000_000;
const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("relativeTime", () => {
  it.each([
    [0, "just now"],
    [999, "just now"],
    [SEC, "1s ago"],
    [59 * SEC + 999, "59s ago"],
    [MIN, "1m ago"],
    [59 * MIN + 59 * SEC, "59m ago"],
    [HOUR, "1h ago"],
    [23 * HOUR + 59 * MIN, "23h ago"],
    [DAY, "1d ago"],
    [45 * DAY + 5 * HOUR, "45d ago"],
  ])("an age of %i ms reads %s", (age, label) => {
    expect(relativeTime(NOW - age, NOW)).toBe(label);
  });

  it("treats a timestamp in the future (clock skew) as just now", () => {
    expect(relativeTime(NOW + 5 * SEC, NOW)).toBe("just now");
  });

  it("defaults to the current clock", () => {
    expect(relativeTime(Date.now() - 2 * MIN)).toBe("2m ago");
  });
});

describe("recentTime", () => {
  it.each([
    [500, "just now"],
    [30 * SEC, "30s ago"],
    [59 * MIN + 59 * SEC, "59m ago"],
  ])("within the last hour an age of %i ms reads %s", (age, label) => {
    expect(recentTime(NOW - age, NOW)).toBe(label);
  });

  it("shows the local clock time from one hour on", () => {
    const ts = NOW - HOUR;
    expect(recentTime(ts, NOW)).toBe(new Date(ts).toLocaleTimeString());
    expect(recentTime(NOW - 3 * DAY, NOW)).toBe(new Date(NOW - 3 * DAY).toLocaleTimeString());
  });

  it("defaults to the current clock", () => {
    expect(recentTime(Date.now() - 5 * SEC)).toBe("5s ago");
  });
});
