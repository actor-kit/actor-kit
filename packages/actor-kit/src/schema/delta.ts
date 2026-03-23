/**
 * Delta encoding — bitmask-based field-level changes.
 *
 * A bitmask (ceil(fieldCount / 8) bytes) indicates which fields changed.
 * Only changed fields' data follows the bitmask.
 *
 * encodeDelta(schema, prev, next) → Uint8Array | null (null = no changes)
 * applyDelta(schema, current, deltaBytes) → new object with changes applied
 */

import type { SchemaDefinition, FieldDescriptor, Infer } from "./schema";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// --- Compare two values for equality ---

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a === "number" && typeof b === "number") {
    // Float comparison with epsilon for float32 precision loss
    return Math.abs(a - b) < 1e-6;
  }
  if (typeof a === "string" || typeof a === "boolean") return a === b;
  // For objects/arrays, use JSON comparison (Phase 1 simple approach)
  return JSON.stringify(a) === JSON.stringify(b);
}

// --- Encode delta ---

export function encodeDelta<TShape extends Record<string, FieldDescriptor>>(
  schemaDef: SchemaDefinition<TShape>,
  prev: Infer<SchemaDefinition<TShape>>,
  next: Infer<SchemaDefinition<TShape>>,
): Uint8Array | null {
  const prevObj = prev as Record<string, unknown>;
  const nextObj = next as Record<string, unknown>;
  const fields = schemaDef.fields;

  // Build bitmask — which fields changed?
  const bitmaskBytes = Math.ceil(fields.length / 8);
  const bitmask = new Uint8Array(bitmaskBytes);
  let anyChanged = false;

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field === undefined) continue;
    if (!valuesEqual(prevObj[field.name], nextObj[field.name])) {
      const byteIndex = Math.floor(i / 8);
      const bitIndex = i % 8;
      bitmask[byteIndex] = (bitmask[byteIndex] ?? 0) | (1 << bitIndex);
      anyChanged = true;
    }
  }

  if (!anyChanged) return null;

  // Calculate size for changed fields
  let dataSize = bitmaskBytes;
  for (let i = 0; i < fields.length; i++) {
    const byteIndex = Math.floor(i / 8);
    const bitIndex = i % 8;
    if (((bitmask[byteIndex] ?? 0) & (1 << bitIndex)) !== 0) {
      const field = fields[i];
      if (field === undefined) continue;
      dataSize += fieldSize(field, nextObj[field.name]);
    }
  }

  // Encode
  const buffer = new ArrayBuffer(dataSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // Write bitmask
  bytes.set(bitmask, 0);
  let offset = bitmaskBytes;

  // Write changed fields
  for (let i = 0; i < fields.length; i++) {
    const byteIndex = Math.floor(i / 8);
    const bitIndex = i % 8;
    if (((bitmask[byteIndex] ?? 0) & (1 << bitIndex)) !== 0) {
      const field = fields[i];
      if (field === undefined) continue;
      offset = writeField(field, nextObj[field.name], view, bytes, offset);
    }
  }

  return bytes;
}

// --- Apply delta ---

export function applyDelta<TShape extends Record<string, FieldDescriptor>>(
  schemaDef: SchemaDefinition<TShape>,
  current: Infer<SchemaDefinition<TShape>>,
  deltaBytes: Uint8Array,
): Infer<SchemaDefinition<TShape>> {
  const currentObj = current as Record<string, unknown>;
  const fields = schemaDef.fields;
  const bitmaskBytes = Math.ceil(fields.length / 8);

  const view = new DataView(deltaBytes.buffer, deltaBytes.byteOffset, deltaBytes.byteLength);
  const bitmask = deltaBytes.subarray(0, bitmaskBytes);

  const result = { ...currentObj };
  let offset = bitmaskBytes;

  for (let i = 0; i < fields.length; i++) {
    const byteIndex = Math.floor(i / 8);
    const bitIndex = i % 8;
    if (((bitmask[byteIndex] ?? 0) & (1 << bitIndex)) !== 0) {
      const field = fields[i];
      if (field === undefined) continue;
      const [value, newOffset] = readField(field, view, deltaBytes, offset);
      result[field.name] = value;
      offset = newOffset;
    }
  }

  return result as Infer<SchemaDefinition<TShape>>;
}

// --- Field size calculation ---

function fieldSize(field: { type: string; element?: unknown; schema?: unknown }, value: unknown): number {
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
      return 2 + encoded.byteLength;
    }
    case "array": {
      const arr = Array.isArray(value) ? value : [];
      let size = 2; // count prefix
      for (const item of arr) {
        size += elementSize(field.element, item);
      }
      return size;
    }
    case "schema": {
      const nested = field.schema as SchemaDefinition<Record<string, FieldDescriptor>>;
      let size = 0;
      for (const f of nested.fields) {
        size += fieldSize(f, ((value ?? {}) as Record<string, unknown>)[f.name]);
      }
      return size;
    }
    default:
      return 0;
  }
}

function elementSize(element: unknown, value: unknown): number {
  if (typeof element !== "object" || element === null) return 0;
  const el = element as { type: string; schema?: unknown };
  if (el.type === "schema" && el.schema) {
    const nested = el.schema as SchemaDefinition<Record<string, FieldDescriptor>>;
    let size = 0;
    for (const f of nested.fields) {
      size += fieldSize(f, ((value ?? {}) as Record<string, unknown>)[f.name]);
    }
    return size;
  }
  return fieldSize(el, value);
}

// --- Field write/read (reuse patterns from binary.ts) ---

function writeField(
  field: { type: string; element?: unknown; schema?: unknown; name?: string },
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
      view.setUint16(offset, Number(value ?? 0), false);
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
        offset = writeElement(field.element, item, view, bytes, offset);
      }
      return offset;
    }
    case "schema": {
      const nested = field.schema as SchemaDefinition<Record<string, FieldDescriptor>>;
      const obj = (value ?? {}) as Record<string, unknown>;
      for (const f of nested.fields) {
        offset = writeField(f, obj[f.name], view, bytes, offset);
      }
      return offset;
    }
    default:
      return offset;
  }
}

function writeElement(element: unknown, value: unknown, view: DataView, bytes: Uint8Array, offset: number): number {
  if (typeof element !== "object" || element === null) return offset;
  const el = element as { type: string; schema?: unknown };
  if (el.type === "schema" && el.schema) {
    const nested = el.schema as SchemaDefinition<Record<string, FieldDescriptor>>;
    const obj = (value ?? {}) as Record<string, unknown>;
    for (const f of nested.fields) {
      offset = writeField(f, obj[f.name], view, bytes, offset);
    }
    return offset;
  }
  return writeField(el, value, view, bytes, offset);
}

function readField(
  field: { type: string; element?: unknown; schema?: unknown; name?: string },
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
        const [item, newOffset] = readElement(field.element, view, bytes, offset);
        arr.push(item);
        offset = newOffset;
      }
      return [arr, offset];
    }
    case "schema": {
      const nested = field.schema as SchemaDefinition<Record<string, FieldDescriptor>>;
      const obj: Record<string, unknown> = {};
      for (const f of nested.fields) {
        const [val, newOffset] = readField(f, view, bytes, offset);
        obj[f.name] = val;
        offset = newOffset;
      }
      return [obj, offset];
    }
    default:
      return [undefined, offset];
  }
}

function readElement(element: unknown, view: DataView, bytes: Uint8Array, offset: number): [unknown, number] {
  if (typeof element !== "object" || element === null) return [undefined, offset];
  const el = element as { type: string; schema?: unknown };
  if (el.type === "schema" && el.schema) {
    const nested = el.schema as SchemaDefinition<Record<string, FieldDescriptor>>;
    const obj: Record<string, unknown> = {};
    for (const f of nested.fields) {
      const [val, newOffset] = readField(f, view, bytes, offset);
      obj[f.name] = val;
      offset = newOffset;
    }
    return [obj, offset];
  }
  return readField(el, view, bytes, offset);
}
