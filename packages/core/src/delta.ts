/**
 * Delta encoding — bitmask-based field-level changes.
 *
 * Layout: change bitmask (one bit per top-level field), null bitmask (one bit
 * per nullable field, set when its next value is null), then each changed,
 * non-null field's value. Most values are encoded exactly as in a snapshot
 * (codec.ts); records and unions send what changed inside them:
 *   record: mode byte; 1 = removed keys, changed keys with their value deltas,
 *           added keys with their values; 0 = the whole record (when the key
 *           order would not come out as the next value's).
 *   union:  variant index; the same variant as before sends that variant's
 *           fields as a delta (same layout as the top level), another one sends
 *           the whole variant.
 * The decoder takes the same branches from the value it already holds.
 *
 * encodeDelta(schema, prev, next) → Uint8Array | null (null = no changes)
 * applyDelta(schema, current, deltaBytes) → new object with changes applied
 */

import {
  asRecord,
  bitmaskBytes,
  type Cursor,
  cursorOver,
  entriesOf,
  hasBit,
  isNullField,
  nullableCount,
  packBits,
  readKey,
  readRecord,
  readUint,
  readValue,
  readVariant,
  readVarint,
  recordSize,
  valueSize,
  variantOf,
  varintSize,
  writeRecord,
  writeValue,
  writeVarint,
} from "./codec";
import { ActorKitError } from "./errors";
import type { FieldDescriptor, Infer, SchemaDefinition, ValueMeta } from "./schema";
import { valueMetaOf } from "./schema";

type AnySchema = SchemaDefinition<Record<string, FieldDescriptor>>;
type UnionMeta = Extract<ValueMeta, { type: "union" }>;

/** Record delta modes. */
const WHOLE = 0;
const PATCH = 1;

const isFloat = (meta: ValueMeta): boolean => meta.type === "float32" || meta.type === "float64";

/**
 * Float field values within 1e-6 are equal (float32 precision loss); everything else compares
 * exactly, objects and arrays as JSON.
 */
function valuesEqual(meta: ValueMeta, a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isFloat(meta) && typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-6;
  return JSON.stringify(a) === JSON.stringify(b);
}

// --- Byte chunks, concatenated once at the end ---

function encoded(meta: ValueMeta, value: unknown): Uint8Array {
  const bytes = new Uint8Array(valueSize(meta, value));
  writeValue(meta, value, cursorOver(bytes, 0));
  return bytes;
}

function encodedRecord(schemaDef: AnySchema, value: unknown): Uint8Array {
  const record = asRecord(value);
  const bytes = new Uint8Array(recordSize(schemaDef, record));
  writeRecord(schemaDef, record, cursorOver(bytes, 0));
  return bytes;
}

const STRING: ValueMeta = { type: "string" };
function count(n: number): Uint8Array {
  const bytes = new Uint8Array(varintSize(n));
  writeVarint(cursorOver(bytes, 0), n);
  return bytes;
}

const byte = (n: number): Uint8Array => Uint8Array.of(n);

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// --- Write ---

/** Pushes the change mask, null mask and changed values of `next` against `prev`. Returns whether anything changed. */
function fieldsDelta(
  schemaDef: AnySchema,
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
  out: Uint8Array[],
): boolean {
  const fields = schemaDef.fields;
  const changed = fields.map((f) => !valuesEqual(valueMetaOf(f), prev[f.name], next[f.name]));
  out.push(packBits(changed));
  out.push(packBits(fields.filter((f) => f.type === "nullable").map((f) => next[f.name] === null)));
  fields.forEach((field, i) => {
    const value = next[field.name];
    if (changed[i] && !isNullField(field, value)) valueDelta(valueMetaOf(field), prev[field.name], value, out);
  });
  return changed.includes(true);
}

/** A changed value: records and unions send what changed, everything else is resent whole. */
function valueDelta(meta: ValueMeta, prev: unknown, next: unknown, out: Uint8Array[]): void {
  switch (meta.type) {
    case "record":
      recordDelta(meta.element, prev, next, out);
      return;
    case "union":
      unionDelta(meta, prev, next, out);
      return;
    default:
      out.push(encoded(meta, next));
  }
}

interface RecordChanges {
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  readonly added: readonly [string, unknown][];
  /** Whether patching keeps the next key order: kept keys in their old order, then added ones. */
  readonly inOrder: boolean;
}

function recordChanges(
  element: ValueMeta,
  before: Map<string, unknown>,
  nextEntries: readonly [string, unknown][],
): RecordChanges {
  const after = new Map(nextEntries);
  const keys = [...before.keys()];
  const kept = keys.filter((key) => after.has(key));
  const added = nextEntries.filter(([key]) => !before.has(key));
  const order = [...kept, ...added.map(([key]) => key)];
  return {
    removed: keys.filter((key) => !after.has(key)),
    changed: kept.filter((key) => !valuesEqual(element, before.get(key), after.get(key))),
    added,
    inOrder: nextEntries.every(([key], i) => key === order[i]),
  };
}

function recordDelta(element: ValueMeta, prev: unknown, next: unknown, out: Uint8Array[]): void {
  const before = new Map(entriesOf(prev));
  const nextEntries = entriesOf(next);
  const { removed, changed, added, inOrder } = recordChanges(element, before, nextEntries);
  if (!inOrder) {
    out.push(byte(WHOLE), encoded({ type: "record", element }, next));
    return;
  }
  const after = new Map(nextEntries);
  out.push(byte(PATCH), count(removed.length), ...removed.map((key) => encoded(STRING, key)));
  out.push(count(changed.length));
  for (const key of changed) {
    out.push(encoded(STRING, key));
    valueDelta(element, before.get(key), after.get(key), out);
  }
  out.push(count(added.length));
  for (const [key, value] of added) out.push(encoded(STRING, key), encoded(element, value));
}

function unionDelta(meta: UnionMeta, prev: unknown, next: unknown, out: Uint8Array[]): void {
  const { index, variant } = variantOf(meta, next);
  const before = asRecord(prev);
  out.push(byte(index));
  if (before[meta.tag] === variant.name) fieldsDelta(variant.schema, before, asRecord(next), out);
  else out.push(encodedRecord(variant.schema, next));
}

export function encodeDelta<TShape extends Record<string, FieldDescriptor>>(
  schemaDef: SchemaDefinition<TShape>,
  prev: Infer<SchemaDefinition<TShape>>,
  next: Infer<SchemaDefinition<TShape>>,
): Uint8Array | null {
  const out: Uint8Array[] = [];
  return fieldsDelta(schemaDef, prev, next, out) ? concat(out) : null;
}

// --- Read ---

/** Reads a change mask, null mask and changed values and applies them to a copy of `current`. */
function readFieldsDelta(schemaDef: AnySchema, current: Record<string, unknown>, c: Cursor): Record<string, unknown> {
  const fields = schemaDef.fields;
  const changeStart = c.offset;
  const nullStart = changeStart + bitmaskBytes(fields.length);
  c.offset = nullStart + bitmaskBytes(nullableCount(schemaDef));
  const result: Record<string, unknown> = { ...current };

  let nullIndex = 0;
  fields.forEach((field, i) => {
    const isNull = field.type === "nullable" && hasBit(c.bytes, nullStart, nullIndex++);
    if (!hasBit(c.bytes, changeStart, i)) return;
    result[field.name] = isNull ? null : readValueDelta(valueMetaOf(field), current[field.name], c);
  });
  return result;
}

function readValueDelta(meta: ValueMeta, current: unknown, c: Cursor): unknown {
  switch (meta.type) {
    case "record":
      return readRecordDelta(meta.element, current, c);
    case "union":
      return readUnionDelta(meta, current, c);
    default:
      return readValue(meta, c);
  }
}

function readKeys(c: Cursor): string[] {
  return Array.from({ length: readVarint(c) }, () => readKey(c));
}

function readRecordDelta(element: ValueMeta, current: unknown, c: Cursor): unknown {
  const mode = readUint(c, "uint8");
  if (mode === WHOLE) return readValue({ type: "record", element }, c);
  if (mode !== PATCH) throw new ActorKitError("invalid_frame", `record delta mode ${mode} is not 0 or 1`);
  // A Map keeps changed keys in place and appends added ones; fromEntries keeps "__proto__" a key.
  const entries = new Map(entriesOf(current));
  for (const key of readKeys(c)) entries.delete(key);
  const changedCount = readVarint(c);
  for (let i = 0; i < changedCount; i++) {
    const key = readKey(c);
    entries.set(key, readValueDelta(element, entries.get(key), c));
  }
  const addedCount = readVarint(c);
  for (let i = 0; i < addedCount; i++) entries.set(readKey(c), readValue(element, c));
  return Object.fromEntries(entries);
}

function readUnionDelta(meta: UnionMeta, current: unknown, c: Cursor): unknown {
  const variant = readVariant(meta, c);
  const before = asRecord(current);
  const fields =
    before[meta.tag] === variant.name ? readFieldsDelta(variant.schema, before, c) : readRecord(variant.schema, c);
  return { [meta.tag]: variant.name, ...fields };
}

export function applyDelta<TShape extends Record<string, FieldDescriptor>>(
  schemaDef: SchemaDefinition<TShape>,
  current: Infer<SchemaDefinition<TShape>>,
  deltaBytes: Uint8Array,
): Infer<SchemaDefinition<TShape>> {
  const result = readFieldsDelta(schemaDef, current, cursorOver(deltaBytes, 0));
  // Generic boundary cast: `current` already matches Infer<>, and every replaced entry is read
  // by that field's own descriptor; the compiler cannot relate the walk over `fields` to TShape.
  return result as Infer<SchemaDefinition<TShape>>;
}
