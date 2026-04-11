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
  // Add null bitmask size if schema has nullable fields
  if (schemaDef.hasNullable) {
    const nullableCount = schemaDef.fields.filter((f) => f.type === "nullable").length;
    size += Math.ceil(nullableCount / 8);
  }
  for (const field of schemaDef.fields) {
    if (field.type === "nullable" && data[field.name] === null) {
      // Null value: zero value bytes (only the bitmask bit)
      continue;
    }
    size += calculateFieldSize(field, data[field.name]);
  }
  return size;
}

function calculateFieldSize(
  field: { type: string; innerType?: string; element?: unknown; schema?: unknown },
  value: unknown,
): number {
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
    case "nullable": {
      // Null values handled by caller (calculateSize skips them).
      // Non-null values: delegate to inner type.
      const innerField = { type: field.innerType ?? "", element: field.element, schema: field.schema };
      return calculateFieldSize(innerField, value);
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
  if (schemaDef.hasNullable) {
    // Write null bitmask: one bit per nullable field
    const nullableFields = schemaDef.fields.filter((f) => f.type === "nullable");
    const bitmaskBytes = Math.ceil(nullableFields.length / 8);
    const bitmaskStart = offset;
    // Zero out bitmask bytes
    for (let i = 0; i < bitmaskBytes; i++) {
      bytes[bitmaskStart + i] = 0;
    }
    // Set bits for null values
    let nullIdx = 0;
    for (const field of schemaDef.fields) {
      if (field.type === "nullable") {
        if (data[field.name] === null) {
          const byteIndex = Math.floor(nullIdx / 8);
          const bitIndex = nullIdx % 8;
          bytes[bitmaskStart + byteIndex] = (bytes[bitmaskStart + byteIndex] ?? 0) | (1 << bitIndex);
        }
        nullIdx++;
      }
    }
    offset += bitmaskBytes;
  }

  for (const field of schemaDef.fields) {
    if (field.type === "nullable") {
      if (data[field.name] === null) {
        continue; // Skip — null bit is set in the bitmask
      }
      // Non-null: encode the inner value
      const innerField = {
        name: field.name,
        type: field.innerType ?? "",
        element: field.element,
        schema: field.schema,
      };
      offset = encodeField(innerField, data[field.name], view, bytes, offset);
    } else {
      offset = encodeField(field, data[field.name], view, bytes, offset);
    }
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

  // Read null bitmask if schema has nullable fields
  let nullBitmask: Uint8Array | undefined;
  if (schemaDef.hasNullable) {
    const nullableCount = schemaDef.fields.filter((f) => f.type === "nullable").length;
    const bitmaskBytes = Math.ceil(nullableCount / 8);
    nullBitmask = bytes.subarray(offset, offset + bitmaskBytes);
    offset += bitmaskBytes;
  }

  let nullIdx = 0;
  for (const field of schemaDef.fields) {
    if (field.type === "nullable") {
      const byteIndex = Math.floor(nullIdx / 8);
      const bitIndex = nullIdx % 8;
      const isNull = nullBitmask !== undefined && ((nullBitmask[byteIndex] ?? 0) & (1 << bitIndex)) !== 0;
      nullIdx++;

      if (isNull) {
        result[field.name] = null;
      } else {
        // Decode the inner value
        const innerField = {
          name: field.name,
          type: field.innerType ?? "",
          element: field.element,
          schema: field.schema,
        };
        const [value, newOffset] = decodeField(innerField, view, bytes, offset);
        result[field.name] = value;
        offset = newOffset;
      }
    } else {
      const [value, newOffset] = decodeField(field, view, bytes, offset);
      result[field.name] = value;
      offset = newOffset;
    }
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
