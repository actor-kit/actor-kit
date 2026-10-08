/**
 * Durations for ctx.schedule (ADR-015 D2): milliseconds as a number, or a number with a unit,
 * e.g. "500ms", "30s", "5m", "2h", "1d".
 */

export type Duration = number | `${number}${"ms" | "s" | "m" | "h" | "d"}`;

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;

/** The duration in ms, or NaN when it is neither a number nor a "<number><unit>" string. */
function millisecondsOf(duration: unknown): number {
  if (typeof duration === "number") return duration;
  if (typeof duration !== "string") return Number.NaN;
  const match = DURATION.exec(duration);
  return match === null ? Number.NaN : Number(match[1]) * (UNIT_MS[match[2] ?? ""] ?? Number.NaN);
}

/** A duration in milliseconds. Throws on anything that is not a finite, non-negative duration. */
export function parseDuration(duration: unknown): number {
  const ms = millisecondsOf(duration);
  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error(
      `Invalid duration ${JSON.stringify(duration)}: use milliseconds or e.g. "500ms", "30s", "5m", "2h", "1d"`,
    );
  }
  return ms;
}
