/**
 * Binary encoder/decoder for schema-defined views.
 *
 * Encodes typed data into compact binary format.
 * Field order is deterministic (from schema definition order).
 * Strings are length-prefixed (varint byte length + UTF-8 bytes).
 * Arrays are count-prefixed (varint count + elements).
 * Fixed-width multi-byte numbers are big-endian.
 * The value layout lives in codec.ts, shared with delta encoding.
 */

import { cursorOver, readRecord, recordSize, writeRecord } from "./codec";
import type { FieldDescriptor, Infer, SchemaDefinition } from "./schema";

export function encode<TShape extends Record<string, FieldDescriptor>>(
  schemaDef: SchemaDefinition<TShape>,
  data: Infer<SchemaDefinition<TShape>>,
): Uint8Array {
  const bytes = new Uint8Array(recordSize(schemaDef, data));
  writeRecord(schemaDef, data, cursorOver(bytes, 0));
  return bytes;
}

export function decode<TShape extends Record<string, FieldDescriptor>>(
  schemaDef: SchemaDefinition<TShape>,
  bytes: Uint8Array,
): Infer<SchemaDefinition<TShape>> {
  const decoded = readRecord(schemaDef, cursorOver(bytes, 0));
  // Generic boundary cast: readRecord builds exactly one entry per schema field, each read by
  // that field's descriptor, which is what Infer<> describes; the compiler cannot relate a
  // runtime walk over `fields` to the mapped type over TShape.
  return decoded as Infer<SchemaDefinition<TShape>>;
}
