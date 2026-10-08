/**
 * Delta encoding — bitmask-based field-level changes.
 *
 * Layout: change bitmask (one bit per top-level field), null bitmask (one bit
 * per nullable field, set when its next value is null), then each changed,
 * non-null field's value encoded exactly as in a snapshot (codec.ts).
 *
 * encodeDelta(schema, prev, next) → Uint8Array | null (null = no changes)
 * applyDelta(schema, current, deltaBytes) → new object with changes applied
 */

import {
  bitmaskBytes,
  cursorOver,
  hasBit,
  isNullField,
  nullableCount,
  packBits,
  readValue,
  valueSize,
  writeValue,
} from "./codec";
import type { FieldDescriptor, Infer, SchemaDefinition, ValueMeta } from "./schema";
import { valueMetaOf } from "./schema";

/** Numbers within 1e-6 are equal (float32 precision loss); objects and arrays compare as JSON. */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-6;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function encodeDelta<TShape extends Record<string, FieldDescriptor>>(
  schemaDef: SchemaDefinition<TShape>,
  prev: Infer<SchemaDefinition<TShape>>,
  next: Infer<SchemaDefinition<TShape>>,
): Uint8Array | null {
  const fields = schemaDef.fields;
  const changed = fields.map((f) => !valuesEqual(prev[f.name], next[f.name]));
  if (!changed.includes(true)) return null;

  const changeMask = packBits(changed);
  const nullMask = packBits(fields.filter((f) => f.type === "nullable").map((f) => next[f.name] === null));
  const values: [ValueMeta, unknown][] = [];
  fields.forEach((field, i) => {
    const value = next[field.name];
    if (changed[i] && !isNullField(field, value)) values.push([valueMetaOf(field), value]);
  });

  const header = changeMask.byteLength + nullMask.byteLength;
  const bytes = new Uint8Array(values.reduce((size, [meta, value]) => size + valueSize(meta, value), header));
  bytes.set(changeMask, 0);
  bytes.set(nullMask, changeMask.byteLength);
  const cursor = cursorOver(bytes, header);
  for (const [meta, value] of values) writeValue(meta, value, cursor);
  return bytes;
}

export function applyDelta<TShape extends Record<string, FieldDescriptor>>(
  schemaDef: SchemaDefinition<TShape>,
  current: Infer<SchemaDefinition<TShape>>,
  deltaBytes: Uint8Array,
): Infer<SchemaDefinition<TShape>> {
  const fields = schemaDef.fields;
  const nullMaskStart = bitmaskBytes(fields.length);
  const cursor = cursorOver(deltaBytes, nullMaskStart + bitmaskBytes(nullableCount(schemaDef)));
  const result: Record<string, unknown> = { ...current };

  let nullIndex = 0;
  fields.forEach((field, i) => {
    const isNull = field.type === "nullable" && hasBit(deltaBytes, nullMaskStart, nullIndex++);
    if (!hasBit(deltaBytes, 0, i)) return;
    result[field.name] = isNull ? null : readValue(valueMetaOf(field), cursor);
  });

  // Generic boundary cast: `current` already matches Infer<>, and every replaced entry is read
  // by that field's own descriptor; the compiler cannot relate the walk over `fields` to TShape.
  return result as Infer<SchemaDefinition<TShape>>;
}
