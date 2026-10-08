/**
 * Studio redaction (ADR-014): `studio: { redact: ["players.*.name", "**.email"] }`.
 *
 * Patterns are dot-separated path globs. A segment is a literal key (or array index),
 * `*` (exactly one segment) or `**` (zero or more segments). Keys containing a dot cannot be
 * addressed individually; use `*` or `**`. A matched value is replaced whole by REDACTED.
 *
 * Applied inside the Durable Object, before anything is returned to Studio.
 */

export const REDACTED = "[redacted]";

export interface Redactor {
  /** False when no patterns are declared; apply() is then the identity. */
  readonly active: boolean;
  apply(value: unknown): unknown;
}

type Segment = { kind: "literal"; key: string } | { kind: "one" } | { kind: "any" };
type Pattern = readonly Segment[];
/** A position inside one pattern: [pattern index, segment index]. */
type Cursor = readonly [number, number];

function parsePattern(raw: string): Pattern {
  if (raw === "") throw new Error("studio.redact patterns must not be empty");
  return raw.split(".").map((part): Segment => {
    if (part === "") throw new Error(`studio.redact pattern "${raw}" has an empty segment`);
    if (part === "*") return { kind: "one" };
    if (part === "**") return { kind: "any" };
    if (part.includes("*")) {
      throw new Error(`studio.redact pattern "${raw}": "*" and "**" must be whole segments`);
    }
    return { kind: "literal", key: part };
  });
}

/** Expand cursors sitting on `**` to also skip it (it matches zero segments). */
function closure(patterns: readonly Pattern[], cursors: readonly Cursor[]): Cursor[] {
  const out: Cursor[] = [];
  const seen = new Set<string>();
  const stack = [...cursors];
  for (let cursor = stack.pop(); cursor !== undefined; cursor = stack.pop()) {
    const id = `${cursor[0]}:${cursor[1]}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(cursor);
    const segment = patterns[cursor[0]]?.[cursor[1]];
    if (segment?.kind === "any") stack.push([cursor[0], cursor[1] + 1]);
  }
  return out;
}

function step(patterns: readonly Pattern[], cursors: readonly Cursor[], key: string): Cursor[] {
  const next: Cursor[] = [];
  for (const [p, i] of cursors) {
    const segment = patterns[p]?.[i];
    if (segment === undefined) continue;
    if (segment.kind === "any") next.push([p, i]);
    else if (segment.kind === "one" || (segment.kind === "literal" && segment.key === key)) next.push([p, i + 1]);
  }
  return closure(patterns, next);
}

function isComplete(patterns: readonly Pattern[], cursors: readonly Cursor[]): boolean {
  return cursors.some(([p, i]) => i === patterns[p]?.length);
}

function walk(patterns: readonly Pattern[], value: unknown, cursors: readonly Cursor[]): unknown {
  if (cursors.length === 0) return value;
  if (isComplete(patterns, cursors)) return REDACTED;
  if (typeof value !== "object" || value === null) return value;
  return walkObject(patterns, value, cursors);
}

function walkObject(patterns: readonly Pattern[], value: object, cursors: readonly Cursor[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => walk(patterns, item, step(patterns, cursors, String(index))));
  }
  if (value instanceof Map) {
    const out = new Map<unknown, unknown>();
    for (const [key, item] of value) out.set(key, walk(patterns, item, step(patterns, cursors, String(key))));
    return out;
  }
  if (value instanceof Set) {
    return new Set([...value].map((item, index) => walk(patterns, item, step(patterns, cursors, String(index)))));
  }
  if (value instanceof Date) return value;

  // fromEntries defines own data properties, so a "__proto__" key stays a plain key.
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, walk(patterns, item, step(patterns, cursors, key))]),
  );
}

/** Compile `studio.redact`. Throws on a malformed pattern, so actors fail at definition time. */
export function compileRedaction(raw: readonly string[] | undefined): Redactor {
  const patterns = (raw ?? []).map(parsePattern);
  if (patterns.length === 0) return { active: false, apply: (value) => value };
  const start = closure(
    patterns,
    patterns.map((_, p): Cursor => [p, 0]),
  );
  return { active: true, apply: (value) => walk(patterns, value, start) };
}
