/**
 * Timer utilities — parse human-readable duration strings to milliseconds.
 *
 * Used by `after` (DO Alarms) and `tick` (setInterval).
 */

const UNITS: Record<string, number> = {
  second: 1_000,
  seconds: 1_000,
  minute: 60_000,
  minutes: 60_000,
  hour: 3_600_000,
  hours: 3_600_000,
  day: 86_400_000,
  days: 86_400_000,
};

export function parseDuration(input: string): number {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error(`Invalid duration: empty string`);
  }

  const match = trimmed.match(/^\s*(\d+)\s+(\w+)\s*$/);
  if (!match || match[1] === undefined || match[2] === undefined) {
    throw new Error(`Invalid duration format: "${input}". Expected "<number> <unit>" (e.g. "5 minutes")`);
  }

  const amount = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multiplier = UNITS[unit];

  if (multiplier === undefined) {
    throw new Error(`Unknown duration unit: "${unit}". Valid units: seconds, minutes, hours, days`);
  }

  return amount * multiplier;
}
