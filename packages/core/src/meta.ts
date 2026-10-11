/**
 * The inner layout of each nullable field (schema.ts builds them), so readers get a nullable
 * field's value layout without a per-type rebuild. Its own module so validate.ts and codec.ts can
 * read layouts without importing schema.ts.
 */

import { ActorKitError } from "./errors";
import type { FieldMeta, NullableMeta, ValueMeta } from "./schema";

const innerOf = new WeakMap<FieldMeta, ValueMeta>();

export function registerInner(field: NullableMeta, inner: ValueMeta): void {
  innerOf.set(field, inner);
}

/** The layout of a field's non-null value (a nullable field's inner type). */
export function valueMetaOf(field: FieldMeta): ValueMeta {
  if (field.type !== "nullable") return field;
  const inner = innerOf.get(field);
  if (inner === undefined)
    throw new ActorKitError("invalid_schema", `nullable field "${field.name}" was not built by schema()`);
  return inner;
}
