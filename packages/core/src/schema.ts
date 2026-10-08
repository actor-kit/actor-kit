/**
 * Schema builder for binary-encodable view shapes with TypeScript inference.
 *
 * Usage:
 *   const MyView = schema({ count: uint32, name: string });
 *   type MyViewType = Infer<typeof MyView>;
 *   // { count: number; name: string }
 */

// --- Primitive type descriptors ---

export type PrimitiveTypeName = "uint8" | "uint16" | "uint32" | "float32" | "float64" | "string" | "boolean";

export interface PrimitiveDescriptor<T extends PrimitiveTypeName, V> {
  readonly kind: "primitive";
  readonly type: T;
  readonly _phantom: V;
}

// `_phantom` only carries the value type for `Infer`; `declare` keeps it out of the runtime object.
class Primitive<T extends PrimitiveTypeName, V> implements PrimitiveDescriptor<T, V> {
  readonly kind = "primitive";
  declare readonly _phantom: V;
  constructor(readonly type: T) {
    Object.freeze(this);
  }
}

function primitive<T extends PrimitiveTypeName, V>(type: T): PrimitiveDescriptor<T, V> {
  return new Primitive<T, V>(type);
}

export const uint8: PrimitiveDescriptor<"uint8", number> = primitive("uint8");
export const uint16: PrimitiveDescriptor<"uint16", number> = primitive("uint16");
export const uint32: PrimitiveDescriptor<"uint32", number> = primitive("uint32");
export const float32: PrimitiveDescriptor<"float32", number> = primitive("float32");
export const float64: PrimitiveDescriptor<"float64", number> = primitive("float64");
export const string: PrimitiveDescriptor<"string", string> = primitive("string");
export const boolean: PrimitiveDescriptor<"boolean", boolean> = primitive("boolean");

// --- Array combinator ---

export interface ArrayDescriptor<E extends FieldDescriptor> {
  readonly kind: "array";
  readonly type: "array";
  readonly element: E;
}

export function array<E extends FieldDescriptor>(element: E): ArrayDescriptor<E> {
  return Object.freeze({ kind: "array" as const, type: "array" as const, element });
}

// --- Nullable combinator ---

// A BaseFieldDescriptor is anything that can be wrapped in nullable() — excludes NullableDescriptor
// to prevent nullable(nullable(x)) and avoid infinite type recursion.
export type BaseFieldDescriptor =
  | PrimitiveDescriptor<PrimitiveTypeName, unknown>
  | ArrayDescriptor<BaseFieldDescriptor>
  | SchemaDefinition<Record<string, FieldDescriptor>>;

export interface NullableDescriptor<F extends BaseFieldDescriptor> {
  readonly kind: "nullable";
  readonly type: "nullable";
  readonly field: F;
}

export function nullable<F extends BaseFieldDescriptor>(field: F): NullableDescriptor<F> {
  return Object.freeze({ kind: "nullable" as const, type: "nullable" as const, field });
}

// --- Schema (nested) descriptor ---

// A FieldDescriptor is anything that can appear as a field value in schema({})
export type FieldDescriptor =
  | PrimitiveDescriptor<PrimitiveTypeName, unknown>
  | ArrayDescriptor<BaseFieldDescriptor>
  | NullableDescriptor<BaseFieldDescriptor>
  | SchemaDefinition<Record<string, FieldDescriptor>>;

// --- Schema definition ---

type AnySchema = SchemaDefinition<Record<string, FieldDescriptor>>;

/**
 * How one non-null value is laid out on the wire: a primitive, an array of
 * values, or a nested schema. Each variant names the other variants' keys as
 * `undefined` so callers can read `meta.element?.type` without narrowing.
 */
export type ValueMeta =
  | { readonly type: PrimitiveTypeName; readonly element?: undefined; readonly schema?: undefined }
  | { readonly type: "array"; readonly element: ValueMeta; readonly schema?: undefined }
  | { readonly type: "schema"; readonly schema: AnySchema; readonly element?: undefined };

/** A nullable field: the inner value's layout, flattened next to `innerType`. */
export type NullableMeta = { readonly name: string; readonly type: "nullable" } & (
  | { readonly innerType: PrimitiveTypeName; readonly element?: undefined; readonly schema?: undefined }
  | { readonly innerType: "array"; readonly element: ValueMeta; readonly schema?: undefined }
  | { readonly innerType: "schema"; readonly schema: AnySchema; readonly element?: undefined }
);

/** One top-level field of a schema, in definition order. */
export type FieldMeta = (ValueMeta & { readonly name: string; readonly innerType?: undefined }) | NullableMeta;

export interface SchemaDefinition<TShape extends Record<string, FieldDescriptor>> {
  readonly kind: "schema";
  readonly type: "schema";
  readonly shape: TShape;
  readonly fields: readonly FieldMeta[];
  readonly hasNullable: boolean;
}

function buildValueMeta(descriptor: BaseFieldDescriptor): ValueMeta {
  switch (descriptor.kind) {
    case "primitive":
      return { type: descriptor.type };
    case "array":
      return { type: "array", element: buildValueMeta(descriptor.element) };
    case "schema":
      return { type: "schema", schema: descriptor };
  }
}

function buildNullableMeta(name: string, inner: ValueMeta): NullableMeta {
  switch (inner.type) {
    case "array":
      return { name, type: "nullable", innerType: "array", element: inner.element };
    case "schema":
      return { name, type: "nullable", innerType: "schema", schema: inner.schema };
    default:
      return { name, type: "nullable", innerType: inner.type };
  }
}

function buildFieldMeta(name: string, descriptor: FieldDescriptor): FieldMeta {
  if (descriptor.kind === "nullable") {
    return buildNullableMeta(name, buildValueMeta(descriptor.field));
  }
  return { name, ...buildValueMeta(descriptor) };
}

/** The layout of a field's non-null value (a nullable field's inner type). */
export function valueMetaOf(field: FieldMeta): ValueMeta {
  if (field.type !== "nullable") return field;
  switch (field.innerType) {
    case "array":
      return { type: "array", element: field.element };
    case "schema":
      return { type: "schema", schema: field.schema };
    default:
      return { type: field.innerType };
  }
}

export function schema<TShape extends Record<string, FieldDescriptor>>(shape: TShape): SchemaDefinition<TShape> {
  const descriptors: [string, FieldDescriptor][] = Object.entries(shape);
  const fields = descriptors.map(([name, descriptor]) => buildFieldMeta(name, descriptor));
  const hasNullable = fields.some((f) => f.type === "nullable");

  return Object.freeze({
    kind: "schema" as const,
    type: "schema" as const,
    shape,
    fields: Object.freeze(fields),
    hasNullable,
  });
}

// --- Type inference ---

// Infer the TypeScript type from a FieldDescriptor
// Use a helper that avoids deep recursion by splitting nullable from non-nullable
// inference. NullableDescriptor<T> unwraps T which is BaseFieldDescriptor (no
// nested nullable), so recursion depth is bounded.
type InferField<F> =
  F extends NullableDescriptor<infer Inner>
    ? InferNonNullable<Inner> | null
    : F extends PrimitiveDescriptor<infer _T, infer V>
      ? V
      : F extends ArrayDescriptor<infer E>
        ? InferNonNullable<E>[]
        : F extends SchemaDefinition<infer S>
          ? { [K in keyof S]: InferField<S[K]> }
          : never;

type InferNonNullable<F> =
  F extends PrimitiveDescriptor<infer _T, infer V>
    ? V
    : F extends ArrayDescriptor<infer E>
      ? InferNonNullable<E>[]
      : F extends SchemaDefinition<infer S>
        ? { [K in keyof S]: InferField<S[K]> }
        : never;

// Infer the full TypeScript type from a SchemaDefinition
export type Infer<S> =
  S extends SchemaDefinition<infer TShape> ? { [K in keyof TShape]: InferField<TShape[K]> } : never;
