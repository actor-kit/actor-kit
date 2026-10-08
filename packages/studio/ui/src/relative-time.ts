/** Short "how long ago" labels for timestamps shown in Studio tables. */

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** [below this age, count in this unit, suffix] — first match wins. */
const STEPS: ReadonlyArray<readonly [number, number, string]> = [
  [MINUTE, SECOND, "s"],
  [HOUR, MINUTE, "m"],
  [DAY, HOUR, "h"],
];

function agoText(age: number): string {
  if (age < SECOND) return "just now";
  const [, unit, suffix] = STEPS.find(([below]) => age < below) ?? [0, DAY, "d"];
  return `${Math.floor(age / unit)}${suffix} ago`;
}

/** "just now", "12s ago", "5m ago", "3h ago", "2d ago". */
export function relativeTime(ts: number, now: number = Date.now()): string {
  return agoText(now - ts);
}

/** Like relativeTime for the last hour; older timestamps show the local clock time. */
export function recentTime(ts: number, now: number = Date.now()): string {
  const age = now - ts;
  return age < HOUR ? agoText(age) : new Date(ts).toLocaleTimeString();
}
