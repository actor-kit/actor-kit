/** Type guards for JSON-shaped values (no casts). */

/** A non-null, non-array object, narrowed so its keys can be read. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
