/**
 * Binary encoder/decoder for schema-defined views.
 *
 * Encodes typed data into compact binary format.
 * Field order is deterministic (from schema definition order).
 * Strings are length-prefixed (uint16 length + UTF-8 bytes).
 * Arrays are count-prefixed (uint16 count + elements).
 * All multi-byte integers are big-endian.
 */

import type { FieldDescriptor, Infer, SchemaDefinition } from "./schema";

// --- Encoder ---

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encode<TShape extends Record<string, FieldDescriptor>>(
  schemaDef: SchemaDefinition<TShape>,
  data: Infer<SchemaDefinition<TShape>>,
): Uint8Array {
  // First pass: calculate total size
  const size = calculateSize(schemaDef, data);
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // Second pass: write data
  let offset = 0;
  offset = encodeFields(schemaDef, data, view, bytes, offset);

  return bytes;
}

function calculateSize(
  schemaDef: SchemaDefinition<Record<string, FieldDescriptor>>,
  data: Record<string, unknown>,
): number {
  let size = 0;
  for (const field of schemaDef.fields) {
    size += calculateFieldSize(field, data[field.name]);
  }
  return size;
}

function calculateFieldSize(field: { type: string; element?: unknown; schema?: unknown }, value: unknown): number {
  switch (field.type) {
    case "uint8":
    case "boolean":
      return 1;
    case "uint16":
      return 2;
    case "uint32":
    case "float32":
      return 4;
    case "float64":
      return 8;
    case "string": {
      const encoded = textEncoder.encode(String(value ?? ""));
      return 2 + encoded.byteLength; // uint16 length prefix + UTF-8 bytes
    }
    case "array": {
      const arr = Array.isArray(value) ? value : [];
      let arrSize = 2; // uint16 count prefix
      for (const item of arr) {
        arrSize += calculateElementSize(field.element, item);
      }
      return arrSize;
    }
    case "schema": {
      const nested = field.schema as SchemaDefinition<Record<string, FieldDescriptor>>;
      return calculateSize(nested, (value ?? {}) as Record<string, unknown>);
    }
    default:
      return 0;
  }
}

function calculateElementSize(element: unknown, value: unknown): number {
  if (typeof element !== "object" || element === null) return 0;
  const el = element as { type: string; schema?: unknown };
  if (el.type === "schema" && el.schema) {
    return calculateSize(
      el.schema as SchemaDefinition<Record<string, FieldDescriptor>>,
      (value ?? {}) as Record<string, unknown>,
    );
  }
  return calculateFieldSize(el, value);
}

function encodeFields(
  schemaDef: SchemaDefinition<Record<string, FieldDescriptor>>,
  data: Record<string, unknown>,
  view: DataView,
  bytes: Uint8Array,
  offset: number,
): number {
  for (const field of schemaDef.fields) {
    offset = encodeField(field, data[field.name], view, bytes, offset);
  }
  return offset;
}

function encodeField(
  field: { name: string; type: string; element?: unknown; schema?: unknown },
  value: unknown,
  view: DataView,
  bytes: Uint8Array,
  offset: number,
): number {
  switch (field.type) {
    case "uint8":
      view.setUint8(offset, Number(value ?? 0));
      return offset + 1;
    case "uint16":
      view.setUint16(offset, Number(value ?? 0), false); // big-endian
      return offset + 2;
    case "uint32":
      view.setUint32(offset, Number(value ?? 0), false);
      return offset + 4;
    case "float32":
      view.setFloat32(offset, Number(value ?? 0), false);
      return offset + 4;
    case "float64":
      view.setFloat64(offset, Number(value ?? 0), false);
      return offset + 8;
    case "boolean":
      view.setUint8(offset, value ? 1 : 0);
      return offset + 1;
    case "string": {
      const encoded = textEncoder.encode(String(value ?? ""));
      view.setUint16(offset, encoded.byteLength, false);
      bytes.set(encoded, offset + 2);
      return offset + 2 + encoded.byteLength;
    }
    case "array": {
      const arr = Array.isArray(value) ? value : [];
      view.setUint16(offset, arr.length, false);
      offset += 2;
      for (const item of arr) {
        offset = encodeElement(field.element, item, view, bytes, offset);
      }
      return offset;
    }
    case "schema": {
      const nested = field.schema as SchemaDefinition<Record<string, FieldDescriptor>>;
      return encodeFields(nested, (value ?? {}) as Record<string, unknown>, view, bytes, offset);
    }
    default:
      return offset;
  }
}

function encodeElement(element: unknown, value: unknown, view: DataView, bytes: Uint8Array, offset: number): number {
  if (typeof element !== "object" || element === null) return offset;
  const el = element as { type: string; schema?: unknown };
  if (el.type === "schema" && el.schema) {
    return encodeFields(
      el.schema as SchemaDefinition<Record<string, FieldDescriptor>>,
      (value ?? {}) as Record<string, unknown>,
      view,
      bytes,
      offset,
    );
  }
  return encodeField({ name: "", ...el }, value, view, bytes, offset);
}

// --- Decoder ---

export function decode<TShape extends Record<string, FieldDescriptor>>(
  schemaDef: SchemaDefinition<TShape>,
  bytes: Uint8Array,
): Infer<SchemaDefinition<TShape>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const [result] = decodeFields(schemaDef, view, bytes, 0);
  return result as Infer<SchemaDefinition<TShape>>;
}

function decodeFields(
  schemaDef: SchemaDefinition<Record<string, FieldDescriptor>>,
  view: DataView,
  bytes: Uint8Array,
  offset: number,
): [Record<string, unknown>, number] {
  const result: Record<string, unknown> = {};
  for (const field of schemaDef.fields) {
    const [value, newOffset] = decodeField(field, view, bytes, offset);
    result[field.name] = value;
    offset = newOffset;
  }
  return [result, offset];
}

function decodeField(
  field: { name: string; type: string; element?: unknown; schema?: unknown },
  view: DataView,
  bytes: Uint8Array,
  offset: number,
): [unknown, number] {
  switch (field.type) {
    case "uint8":
      return [view.getUint8(offset), offset + 1];
    case "uint16":
      return [view.getUint16(offset, false), offset + 2];
    case "uint32":
      return [view.getUint32(offset, false), offset + 4];
    case "float32":
      return [view.getFloat32(offset, false), offset + 4];
    case "float64":
      return [view.getFloat64(offset, false), offset + 8];
    case "boolean":
      return [view.getUint8(offset) !== 0, offset + 1];
    case "string": {
      const len = view.getUint16(offset, false);
      offset += 2;
      const str = textDecoder.decode(bytes.subarray(offset, offset + len));
      return [str, offset + len];
    }
    case "array": {
      const count = view.getUint16(offset, false);
      offset += 2;
      const arr: unknown[] = [];
      for (let i = 0; i < count; i++) {
        const [item, newOffset] = decodeElement(field.element, view, bytes, offset);
        arr.push(item);
        offset = newOffset;
      }
      return [arr, offset];
    }
    case "schema": {
      const nested = field.schema as SchemaDefinition<Record<string, FieldDescriptor>>;
      return decodeFields(nested, view, bytes, offset);
    }
    default:
      return [undefined, offset];
  }
}

function decodeElement(element: unknown, view: DataView, bytes: Uint8Array, offset: number): [unknown, number] {
  if (typeof element !== "object" || element === null) return [undefined, offset];
  const el = element as { type: string; schema?: unknown };
  if (el.type === "schema" && el.schema) {
    return decodeFields(el.schema as SchemaDefinition<Record<string, FieldDescriptor>>, view, bytes, offset);
  }
  return decodeField({ name: "", ...el }, view, bytes, offset);
}
