/**
 * Value codec shared by snapshot (binary.ts) and delta (delta.ts) encoding.
 *
 * A value is laid out by its ValueMeta: fixed-width primitives, length-prefixed
 * strings, count-prefixed arrays, or a nested record (null bitmask + fields).
 * All multi-byte numbers are big-endian. See docs/binary-protocol.md.
 */

import type { FieldDescriptor, FieldMeta, PrimitiveTypeName, SchemaDefinition, ValueMeta } from "./schema";
import { valueMetaOf } from "./schema";

export type AnySchema = SchemaDefinition<Record<string, FieldDescriptor>>;

/** Read/write position over one buffer. */
export interface Cursor {
  readonly view: DataView;
  readonly bytes: Uint8Array;
  offset: number;
}

export function cursorOver(bytes: Uint8Array, offset: number): Cursor {
  return { view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), bytes, offset };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const EMPTY: Record<string, unknown> = Object.freeze({});

/** Missing or non-object values encode as an empty record (all fields zero). */
export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : EMPTY;
}

// --- Bitmasks: bit i lives in byte floor(i / 8), at position i % 8 ---

export function bitmaskBytes(bitCount: number): number {
  return Math.ceil(bitCount / 8);
}

export function setBit(bytes: Uint8Array, start: number, index: number): void {
  const at = start + (index >> 3);
  bytes[at] = (bytes[at] ?? 0) | (1 << (index & 7));
}

export function hasBit(bytes: Uint8Array, start: number, index: number): boolean {
  return ((bytes[start + (index >> 3)] ?? 0) & (1 << (index & 7))) !== 0;
}

export function packBits(flags: readonly boolean[]): Uint8Array {
  const mask = new Uint8Array(bitmaskBytes(flags.length));
  flags.forEach((flag, i) => {
    if (flag) setBit(mask, 0, i);
  });
  return mask;
}

export function nullableCount(schemaDef: AnySchema): number {
  return schemaDef.fields.filter((f) => f.type === "nullable").length;
}

/** A field whose value is null and therefore has only its null bit, no value bytes. */
export function isNullField(field: FieldMeta, value: unknown): boolean {
  return field.type === "nullable" && value === null;
}

// --- Fixed-width primitives ---

type FixedTypeName = Exclude<PrimitiveTypeName, "string">;

interface FixedCodec {
  readonly size: number;
  write(view: DataView, offset: number, value: unknown): void;
  read(view: DataView, offset: number): number | boolean;
}

const num = (value: unknown): number => Number(value ?? 0);

const FIXED: { readonly [K in FixedTypeName]: FixedCodec } = {
  uint8: { size: 1, write: (v, o, x) => v.setUint8(o, num(x)), read: (v, o) => v.getUint8(o) },
  uint16: { size: 2, write: (v, o, x) => v.setUint16(o, num(x)), read: (v, o) => v.getUint16(o) },
  uint32: { size: 4, write: (v, o, x) => v.setUint32(o, num(x)), read: (v, o) => v.getUint32(o) },
  float32: { size: 4, write: (v, o, x) => v.setFloat32(o, num(x)), read: (v, o) => v.getFloat32(o) },
  float64: { size: 8, write: (v, o, x) => v.setFloat64(o, num(x)), read: (v, o) => v.getFloat64(o) },
  boolean: { size: 1, write: (v, o, x) => v.setUint8(o, x ? 1 : 0), read: (v, o) => v.getUint8(o) !== 0 },
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const utf8 = (value: unknown): Uint8Array => textEncoder.encode(String(value ?? ""));
const items = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

// --- Size ---

export function valueSize(meta: ValueMeta, value: unknown): number {
  switch (meta.type) {
    case "string":
      return 2 + utf8(value).byteLength;
    case "array":
      return items(value).reduce<number>((size, item) => size + valueSize(meta.element, item), 2);
    case "schema":
      return recordSize(meta.schema, asRecord(value));
    default:
      return FIXED[meta.type].size;
  }
}

export function recordSize(schemaDef: AnySchema, record: Record<string, unknown>): number {
  let size = bitmaskBytes(nullableCount(schemaDef));
  for (const field of schemaDef.fields) {
    const value = record[field.name];
    if (!isNullField(field, value)) size += valueSize(valueMetaOf(field), value);
  }
  return size;
}

// --- Write ---

export function writeValue(meta: ValueMeta, value: unknown, c: Cursor): void {
  switch (meta.type) {
    case "string": {
      const encoded = utf8(value);
      c.view.setUint16(c.offset, encoded.byteLength);
      c.bytes.set(encoded, c.offset + 2);
      c.offset += 2 + encoded.byteLength;
      return;
    }
    case "array": {
      const list = items(value);
      c.view.setUint16(c.offset, list.length);
      c.offset += 2;
      for (const item of list) writeValue(meta.element, item, c);
      return;
    }
    case "schema":
      writeRecord(meta.schema, asRecord(value), c);
      return;
    default: {
      const fixed = FIXED[meta.type];
      fixed.write(c.view, c.offset, value);
      c.offset += fixed.size;
    }
  }
}

/** Writes the null bitmask (one bit per nullable field) then each non-null field. Expects zeroed bytes. */
export function writeRecord(schemaDef: AnySchema, record: Record<string, unknown>, c: Cursor): void {
  const maskStart = c.offset;
  c.offset += bitmaskBytes(nullableCount(schemaDef));
  let nullIndex = 0;
  for (const field of schemaDef.fields) {
    const value = record[field.name];
    if (field.type === "nullable") {
      if (value === null) setBit(c.bytes, maskStart, nullIndex);
      nullIndex++;
    }
    if (!isNullField(field, value)) writeValue(valueMetaOf(field), value, c);
  }
}

// --- Read ---

export function readValue(meta: ValueMeta, c: Cursor): unknown {
  switch (meta.type) {
    case "string": {
      const length = c.view.getUint16(c.offset);
      const start = c.offset + 2;
      c.offset = start + length;
      return textDecoder.decode(c.bytes.subarray(start, start + length));
    }
    case "array": {
      const count = c.view.getUint16(c.offset);
      c.offset += 2;
      return Array.from({ length: count }, () => readValue(meta.element, c));
    }
    case "schema":
      return readRecord(meta.schema, c);
    default: {
      const fixed = FIXED[meta.type];
      const value = fixed.read(c.view, c.offset);
      c.offset += fixed.size;
      return value;
    }
  }
}

export function readRecord(schemaDef: AnySchema, c: Cursor): Record<string, unknown> {
  const maskStart = c.offset;
  c.offset += bitmaskBytes(nullableCount(schemaDef));
  const result: Record<string, unknown> = {};
  let nullIndex = 0;
  for (const field of schemaDef.fields) {
    const isNull = field.type === "nullable" && hasBit(c.bytes, maskStart, nullIndex++);
    result[field.name] = isNull ? null : readValue(valueMetaOf(field), c);
  }
  return result;
}
