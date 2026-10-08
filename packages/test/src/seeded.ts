/**
 * Seeded randomness for simulate(): mulberry32, a small 32-bit PRNG. Its whole state is one
 * number, so a simulation (and every branch of it) can carry and copy it.
 */

/** Advance the generator: the next state and a number in [0, 1). */
export function nextRandom(state: number): { state: number; value: number } {
  const next = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(next ^ (next >>> 15), next | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { state: next, value: ((t ^ (t >>> 14)) >>> 0) / 4294967296 };
}

/** A UUID v4 string drawn from `random` (version 4, variant 10xx). */
export function uuidFrom(random: () => number): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const n = Math.floor(random() * 16);
    return (c === "x" ? n : 8 + (n % 4)).toString(16);
  });
}
