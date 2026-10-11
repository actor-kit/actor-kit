import { ActorKitError } from "@actor-kit/core";
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
/** A position inside one pattern: [pattern index, pattern, segment index]. */
type Cursor = readonly [number, Pattern, number];

function parsePattern(raw: string): Pattern {
  if (raw === "") throw new ActorKitError("invalid_redact_pattern", "studio.redact patterns must not be empty");
  return raw.split(".").map((part): Segment => {
    if (part === "")
      throw new ActorKitError("invalid_redact_pattern", `studio.redact pattern "${raw}" has an empty segment`);
    if (part === "*") return { kind: "one" };
    if (part === "**") return { kind: "any" };
    if (part.includes("*")) {
      throw new ActorKitError(
        "invalid_redact_pattern",
        `studio.redact pattern "${raw}": "*" and "**" must be whole segments`,
      );
    }
    return { kind: "literal", key: part };
  });
}

/** Expand cursors sitting on `**` to also skip it (it matches zero segments). */
function closure(cursors: readonly Cursor[]): Cursor[] {
  const out: Cursor[] = [];
  const seen = new Set<string>();
  const stack = [...cursors];
  for (let cursor = stack.pop(); cursor !== undefined; cursor = stack.pop()) {
    const [p, pattern, i] = cursor;
    const id = `${p}:${i}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(cursor);
    if (pattern[i]?.kind === "any") stack.push([p, pattern, i + 1]);
  }
  return out;
}

function step(cursors: readonly Cursor[], key: string): Cursor[] {
  const next: Cursor[] = [];
  for (const [p, pattern, i] of cursors) {
    const segment = pattern[i];
    if (segment === undefined) continue;
    if (segment.kind === "any") next.push([p, pattern, i]);
    else if (segment.kind === "one" || (segment.kind === "literal" && segment.key === key))
      next.push([p, pattern, i + 1]);
  }
  return closure(next);
}

function isComplete(cursors: readonly Cursor[]): boolean {
  return cursors.some(([, pattern, i]) => i === pattern.length);
}

function walk(value: unknown, cursors: readonly Cursor[]): unknown {
  if (cursors.length === 0) return value;
  if (isComplete(cursors)) return REDACTED;
  if (typeof value !== "object" || value === null) return value;
  return walkObject(value, cursors);
}

function walkObject(value: object, cursors: readonly Cursor[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => walk(item, step(cursors, String(index))));
  }
  if (value instanceof Map) {
    const out = new Map<unknown, unknown>();
    for (const [key, item] of value) out.set(key, walk(item, step(cursors, String(key))));
    return out;
  }
  if (value instanceof Set) {
    return new Set([...value].map((item, index) => walk(item, step(cursors, String(index)))));
  }
  if (value instanceof Date) return value;

  // fromEntries defines own data properties, so a "__proto__" key stays a plain key.
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, step(cursors, key))]));
}

/** Compile `studio.redact`. Throws on a malformed pattern, so actors fail at definition time. */
export function compileRedaction(raw: readonly string[] | undefined): Redactor {
  const patterns = (raw ?? []).map(parsePattern);
  if (patterns.length === 0) return { active: false, apply: (value) => value };
  const start = closure(patterns.map((pattern, p): Cursor => [p, pattern, 0]));
  return { active: true, apply: (value) => walk(value, start) };
}
