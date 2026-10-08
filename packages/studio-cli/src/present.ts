/**
 * `obj` without its `undefined`-valued keys, typed so each key is optional and never `undefined`.
 *
 * Builds option bags under `exactOptionalPropertyTypes`, where an optional key must be absent
 * rather than present with `undefined`.
 */
// biome-ignore lint/complexity/noBannedTypes: `T & ({} | null)` is how TypeScript spells "T without undefined" for a generic T.
export type Defined<T> = { [K in keyof T]?: T[K] & ({} | null) };

export function defined<T extends object>(obj: T): Defined<T> {
  const out: Defined<T> = {};
  let key: keyof T;
  for (key in obj) {
    const value = obj[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}
