/**
 * Schema builder for binary-encodable view shapes with TypeScript inference.
 *
 * Usage:
 *   const MyView = schema({ count: uint32, name: string });
 *   type MyViewType = Infer<typeof MyView>;
 *   // { count: number; name: string }
 */

// --- Primitive type descriptors ---

type PrimitiveTypeName = "uint8" | "uint16" | "uint32" | "float32" | "float64" | "string" | "boolean";

export interface PrimitiveDescriptor<T extends PrimitiveTypeName, V> {
  readonly kind: "primitive";
  readonly type: T;
  readonly _phantom: V;
}

function primitive<T extends PrimitiveTypeName, V>(type: T): PrimitiveDescriptor<T, V> {
  return Object.freeze({ kind: "primitive" as const, type, _phantom: undefined as unknown as V });
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

interface FieldMeta {
  readonly name: string;
  readonly type: string;
  readonly innerType?: string;
  readonly element?:
    | FieldMeta
    | { readonly type: string; readonly schema?: SchemaDefinition<Record<string, FieldDescriptor>> };
  readonly schema?: SchemaDefinition<Record<string, FieldDescriptor>>;
}

export interface SchemaDefinition<TShape extends Record<string, FieldDescriptor>> {
  readonly kind: "schema";
  readonly type: "schema";
  readonly shape: TShape;
  readonly fields: readonly FieldMeta[];
  readonly hasNullable: boolean;
}

function buildFieldMeta(name: string, descriptor: FieldDescriptor): FieldMeta {
  if (descriptor.kind === "primitive") {
    return { name, type: descriptor.type };
  }
  if (descriptor.kind === "array") {
    const elementMeta = buildElementMeta(descriptor.element);
    return { name, type: "array", element: elementMeta };
  }
  if (descriptor.kind === "nullable") {
    const inner = buildFieldMeta(name, descriptor.field);
    const meta: FieldMeta = { name, type: "nullable", innerType: inner.type };
    if (inner.element !== undefined) {
      return { ...meta, element: inner.element };
    }
    if (inner.schema !== undefined) {
      return { ...meta, schema: inner.schema };
    }
    return meta;
  }
  // descriptor.kind === "schema"
  return { name, type: "schema", schema: descriptor };
}

function buildElementMeta(descriptor: FieldDescriptor): FieldMeta["element"] & object {
  if (descriptor.kind === "primitive") {
    return { type: descriptor.type };
  }
  if (descriptor.kind === "schema") {
    return { type: "schema", schema: descriptor };
  }
  // Nested array — array of arrays. Preserve inner element metadata.
  if (descriptor.kind === "array") {
    return { type: "array", element: buildElementMeta(descriptor.element) };
  }
  return { type: "array" };
}

export function schema<TShape extends Record<string, FieldDescriptor>>(shape: TShape): SchemaDefinition<TShape> {
  const entries = Object.entries(shape);
  const fields: FieldMeta[] = entries.map(([name, descriptor]) => buildFieldMeta(name, descriptor as FieldDescriptor));
  const hasNullable = fields.some((f) => f.type === "nullable");

  const def: SchemaDefinition<TShape> = {
    kind: "schema" as const,
    type: "schema" as const,
    shape,
    fields: Object.freeze(fields),
    hasNullable,
  };

  return Object.freeze(def);
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
