/**
 * Value codec shared by snapshot (binary.ts) and delta (delta.ts) encoding.
 *
 * A value is laid out by its ValueMeta: fixed-width primitives, length-prefixed
 * strings, count-prefixed arrays, or a nested record (null bitmask + fields).
 * Every length and count is an unsigned LEB128 varint; fixed-width numbers are
 * big-endian. See docs/binary-protocol.md.
 */

import { ActorKitError } from "./errors";
import type {
  EnumValue,
  FieldDescriptor,
  FieldMeta,
  PrimitiveTypeName,
  SchemaDefinition,
  ValueMeta,
  VariantMeta,
} from "./schema";
import { show, valueMetaOf } from "./schema";

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
type UintTypeName = "uint8" | "uint16";

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
  int8: { size: 1, write: (v, o, x) => v.setInt8(o, num(x)), read: (v, o) => v.getInt8(o) },
  int16: { size: 2, write: (v, o, x) => v.setInt16(o, num(x)), read: (v, o) => v.getInt16(o) },
  int32: { size: 4, write: (v, o, x) => v.setInt32(o, num(x)), read: (v, o) => v.getInt32(o) },
  float32: { size: 4, write: (v, o, x) => v.setFloat32(o, num(x)), read: (v, o) => v.getFloat32(o) },
  float64: { size: 8, write: (v, o, x) => v.setFloat64(o, num(x)), read: (v, o) => v.getFloat64(o) },
  boolean: { size: 1, write: (v, o, x) => v.setUint8(o, x ? 1 : 0), read: (v, o) => v.getUint8(o) !== 0 },
};

function writeFixed(c: Cursor, type: FixedTypeName, value: unknown): void {
  FIXED[type].write(c.view, c.offset, value);
  c.offset += FIXED[type].size;
}

function readFixed(c: Cursor, type: FixedTypeName): number | boolean {
  const value = FIXED[type].read(c.view, c.offset);
  c.offset += FIXED[type].size;
  return value;
}

export function readUint(c: Cursor, type: UintTypeName): number {
  return Number(readFixed(c, type));
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const utf8 = (value: unknown): Uint8Array => textEncoder.encode(String(value ?? ""));
const items = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const jsonText = (value: unknown): string => JSON.stringify(value) ?? "null";

/** A record's entries in key order; anything that is not an object has none. */
export function entriesOf(value: unknown): [string, unknown][] {
  return isRecord(value) ? Object.entries(value) : [];
}

// --- Lengths and counts: unsigned LEB128 varints (7 bits per byte, low bits first) ---

/** At most 8 bytes: 56 bits, past any length a frame can hold. */
const MAX_VARINT_BYTES = 8;

export function varintSize(n: number): number {
  let size = 1;
  for (let rest = n; rest >= 0x80; rest = Math.floor(rest / 0x80)) size += 1;
  return size;
}

export function writeVarint(c: Cursor, n: number): void {
  let rest = n;
  while (rest >= 0x80) {
    c.bytes[c.offset++] = (rest % 0x80) | 0x80;
    rest = Math.floor(rest / 0x80);
  }
  c.bytes[c.offset++] = rest;
}

export function readVarint(c: Cursor): number {
  let value = 0;
  for (let i = 0; i < MAX_VARINT_BYTES; i++) {
    const byte = c.view.getUint8(c.offset++);
    value += (byte & 0x7f) * 0x80 ** i;
    if (byte < 0x80) return value;
  }
  throw new ActorKitError("invalid_frame", `malformed varint: more than ${MAX_VARINT_BYTES} bytes`);
}

/** Text: a varint byte length, then the UTF-8 bytes. */
const textSize = (encoded: Uint8Array): number => varintSize(encoded.byteLength) + encoded.byteLength;

function writeText(c: Cursor, encoded: Uint8Array): void {
  writeVarint(c, encoded.byteLength);
  c.bytes.set(encoded, c.offset);
  c.offset += encoded.byteLength;
}

function readText(c: Cursor): string {
  const length = readVarint(c);
  const start = c.offset;
  c.offset = start + length;
  return textDecoder.decode(c.bytes.subarray(start, start + length));
}

// --- Enums and unions ---

/** The index width of an enum: none for one value, one byte up to 256 values, else two. */
function enumIndexType(values: readonly EnumValue[]): UintTypeName | null {
  if (values.length === 1) return null;
  return values.length <= 0x100 ? "uint8" : "uint16";
}

function enumIndexSize(values: readonly EnumValue[]): number {
  const type = enumIndexType(values);
  return type === null ? 0 : FIXED[type].size;
}

function enumIndex(values: readonly EnumValue[], value: unknown): number {
  // biome-ignore lint/complexity/useIndexOf: indexOf takes an EnumValue and `value` is not narrowed yet
  const index = values.findIndex((v) => v === value);
  if (index < 0) {
    throw new ActorKitError("invalid_view_value", `enum: ${show(value)} is not one of ${values.map(show).join(", ")}`);
  }
  return index;
}

function readEnum(values: readonly EnumValue[], c: Cursor): EnumValue {
  const type = enumIndexType(values);
  const index = type === null ? 0 : readUint(c, type);
  const value = values[index];
  if (value === undefined) {
    throw new ActorKitError("invalid_frame", `enum index ${index} is out of range (${values.length} values)`);
  }
  return value;
}

type UnionMeta = Extract<ValueMeta, { type: "union" }>;

/** The variant a union value's tag names, and its wire index. */
export function variantOf(meta: UnionMeta, value: unknown): { readonly index: number; readonly variant: VariantMeta } {
  const tag = asRecord(value)[meta.tag];
  const index = meta.variants.findIndex((v) => v.name === tag);
  const variant = meta.variants[index];
  if (variant === undefined) {
    throw new ActorKitError(
      "invalid_view_value",
      `union "${meta.tag}": ${show(tag)} is not one of ${meta.variants.map((v) => show(v.name)).join(", ")}`,
    );
  }
  return { index, variant };
}

/** Reads a union's variant index and returns that variant. */
export function readVariant(meta: UnionMeta, c: Cursor): VariantMeta {
  const index = readUint(c, "uint8");
  const variant = meta.variants[index];
  if (variant === undefined) {
    throw new ActorKitError(
      "invalid_frame",
      `union "${meta.tag}": variant index ${index} is out of range (${meta.variants.length} variants)`,
    );
  }
  return variant;
}

// --- Size ---

type LeafMeta = Extract<ValueMeta, { type: PrimitiveTypeName | "enum" | "json" }>;

export function valueSize(meta: ValueMeta, value: unknown): number {
  switch (meta.type) {
    case "array":
      return items(value).reduce<number>(
        (size, item) => size + valueSize(meta.element, item),
        varintSize(items(value).length),
      );
    case "record": {
      const entries = entriesOf(value);
      return entries.reduce<number>(
        (size, [key, item]) => size + textSize(utf8(key)) + valueSize(meta.element, item),
        varintSize(entries.length),
      );
    }
    case "schema":
      return recordSize(meta.schema, asRecord(value));
    case "union":
      return 1 + recordSize(variantOf(meta, value).variant.schema, asRecord(value));
    default:
      return leafSize(meta, value);
  }
}

function leafSize(meta: LeafMeta, value: unknown): number {
  switch (meta.type) {
    case "string":
      return textSize(utf8(value));
    case "json":
      return textSize(utf8(jsonText(value)));
    case "enum":
      return enumIndexSize(meta.values);
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
    case "array": {
      const list = items(value);
      writeVarint(c, list.length);
      for (const item of list) writeValue(meta.element, item, c);
      return;
    }
    case "record": {
      const entries = entriesOf(value);
      writeVarint(c, entries.length);
      for (const [key, item] of entries) {
        writeText(c, utf8(key));
        writeValue(meta.element, item, c);
      }
      return;
    }
    case "schema":
      writeRecord(meta.schema, asRecord(value), c);
      return;
    case "union": {
      const { index, variant } = variantOf(meta, value);
      writeFixed(c, "uint8", index);
      writeRecord(variant.schema, asRecord(value), c);
      return;
    }
    default:
      writeLeaf(meta, value, c);
  }
}

function writeLeaf(meta: LeafMeta, value: unknown, c: Cursor): void {
  switch (meta.type) {
    case "string":
      writeText(c, utf8(value));
      return;
    case "json":
      writeText(c, utf8(jsonText(value)));
      return;
    case "enum": {
      const index = enumIndex(meta.values, value);
      const type = enumIndexType(meta.values);
      if (type !== null) writeFixed(c, type, index);
      return;
    }
    default:
      writeFixed(c, meta.type, value);
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
    case "array": {
      const count = readVarint(c);
      return Array.from({ length: count }, () => readValue(meta.element, c));
    }
    case "record": {
      const count = readVarint(c);
      // fromEntries defines own keys, so a key named "__proto__" stays a key.
      return Object.fromEntries(Array.from({ length: count }, () => [readText(c), readValue(meta.element, c)]));
    }
    case "schema":
      return readRecord(meta.schema, c);
    case "union": {
      const variant = readVariant(meta, c);
      return { [meta.tag]: variant.name, ...readRecord(variant.schema, c) };
    }
    default:
      return readLeaf(meta, c);
  }
}

function readLeaf(meta: LeafMeta, c: Cursor): unknown {
  switch (meta.type) {
    case "string":
      return readText(c);
    case "json":
      return meta.json.parse(JSON.parse(readText(c)));
    case "enum":
      return readEnum(meta.values, c);
    default:
      return readFixed(c, meta.type);
  }
}

/** Reads a string key (varint length + UTF-8), as record keys are written. */
export function readKey(c: Cursor): string {
  return readText(c);
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
