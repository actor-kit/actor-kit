/**
 * Schema builder for binary-encodable view shapes with TypeScript inference.
 *
 * Usage:
 *   const MyView = schema({ count: uint32, name: string });
 *   type MyViewType = Infer<typeof MyView>;
 *   // { count: number; name: string }
 */

import type { z } from "zod";

// --- Primitive type descriptors ---

export type PrimitiveTypeName =
  | "uint8"
  | "uint16"
  | "uint32"
  | "int8"
  | "int16"
  | "int32"
  | "float32"
  | "float64"
  | "string"
  | "boolean";

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
/** Signed integers: fixed width, two's complement, big-endian. */
export const int8: PrimitiveDescriptor<"int8", number> = primitive("int8");
export const int16: PrimitiveDescriptor<"int16", number> = primitive("int16");
export const int32: PrimitiveDescriptor<"int32", number> = primitive("int32");
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

// --- Record combinator (string keys) ---

export interface RecordDescriptor<E extends BaseFieldDescriptor> {
  readonly kind: "record";
  readonly type: "record";
  readonly element: E;
}

/** A string-keyed record: a count, then each key and value. Deltas send removed, changed and added keys. */
export function record<E extends BaseFieldDescriptor>(element: E): RecordDescriptor<E> {
  return Object.freeze({ kind: "record" as const, type: "record" as const, element });
}

// --- Enums and literals ---

export type EnumValue = string | number | boolean;

export interface EnumDescriptor<V extends readonly EnumValue[]> {
  readonly kind: "enum";
  readonly type: "enum";
  readonly values: V;
}

const MAX_ENUM_VALUES = 0x10000;

/** A value as it appears in error messages. */
export const show = (value: unknown): string => JSON.stringify(value) ?? String(value);

/** One of a fixed list of values, sent as its index (0 bytes for one value, 1 up to 256, else 2). */
export function enumOf<const V extends readonly [EnumValue, ...EnumValue[]]>(values: V): EnumDescriptor<V> {
  if (values.length === 0) throw new Error("enumOf() needs at least one value");
  if (values.length > MAX_ENUM_VALUES) throw new Error(`enumOf() takes at most ${MAX_ENUM_VALUES} values`);
  const seen = new Set<EnumValue>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`enumOf() values must be distinct: ${show(value)} appears twice`);
    seen.add(value);
  }
  return Object.freeze({ kind: "enum" as const, type: "enum" as const, values });
}

/** A single value: takes no bytes on the wire. */
export function literal<const V extends EnumValue>(value: V): EnumDescriptor<readonly [V]> {
  return enumOf([value]);
}

// --- Discriminated union ---

type AnySchema = SchemaDefinition<Record<string, FieldDescriptor>>;

export interface UnionDescriptor<Tag extends string, V extends Readonly<Record<string, AnySchema>>> {
  readonly kind: "union";
  readonly type: "union";
  readonly tag: Tag;
  readonly variants: V;
}

const MAX_VARIANTS = 0x100;

/**
 * A discriminated union: `{ [tag]: variantName, ...that variant's fields }`. Sent as the variant's
 * index (one byte) then its fields; a delta sends only changed fields while the tag is unchanged.
 */
export function union<const Tag extends string, const V extends Readonly<Record<string, AnySchema>>>(
  tag: Tag,
  variants: V,
): UnionDescriptor<Tag, V> {
  const entries: [string, AnySchema][] = Object.entries(variants);
  if (entries.length === 0) throw new Error(`union "${tag}" needs at least one variant`);
  if (entries.length > MAX_VARIANTS) throw new Error(`union "${tag}" takes at most ${MAX_VARIANTS} variants`);
  for (const [name, variant] of entries) {
    if (variant.fields.some((f) => f.name === tag)) {
      throw new Error(`union "${tag}": variant "${name}" must not declare the tag field "${tag}"`);
    }
  }
  return Object.freeze({ kind: "union" as const, type: "union" as const, tag, variants });
}

// --- JSON escape hatch ---

export interface JsonDescriptor<S extends z.ZodType> {
  readonly kind: "json";
  readonly type: "json";
  readonly schema: S;
}

/** Any JSON value, sent as JSON text and parsed with `zodSchema` when decoded. Changes resend it whole. */
export function json<S extends z.ZodType>(zodSchema: S): JsonDescriptor<S> {
  return Object.freeze({ kind: "json" as const, type: "json" as const, schema: zodSchema });
}

// --- Nullable combinator ---

// A BaseFieldDescriptor is anything that can be wrapped in nullable() — excludes NullableDescriptor
// to prevent nullable(nullable(x)) and avoid infinite type recursion.
export type BaseFieldDescriptor =
  | PrimitiveDescriptor<PrimitiveTypeName, unknown>
  | ArrayDescriptor<BaseFieldDescriptor>
  | RecordDescriptor<BaseFieldDescriptor>
  | EnumDescriptor<readonly EnumValue[]>
  | UnionDescriptor<string, Readonly<Record<string, AnySchema>>>
  | JsonDescriptor<z.ZodType>
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
export type FieldDescriptor = BaseFieldDescriptor | NullableDescriptor<BaseFieldDescriptor>;

// --- Schema definition ---

/** One variant of a union, in declaration order (its index is the wire tag). */
export interface VariantMeta {
  readonly name: string;
  readonly schema: AnySchema;
}

/** Everything a layout can carry besides its type. */
interface Layout {
  readonly element: ValueMeta;
  readonly schema: AnySchema;
  readonly values: readonly EnumValue[];
  readonly tag: string;
  readonly variants: readonly VariantMeta[];
  readonly json: z.ZodType;
}

/** The layout keys `K`, with every other layout key named as `undefined` so `meta.element?.type` reads without narrowing. */
type Only<K extends keyof Layout> = { readonly [P in K]: Layout[P] } & {
  readonly [P in Exclude<keyof Layout, K>]?: undefined;
};

/** How one non-null value is laid out on the wire. */
export type ValueMeta =
  | ({ readonly type: PrimitiveTypeName } & Only<never>)
  | ({ readonly type: "array" | "record" } & Only<"element">)
  | ({ readonly type: "schema" } & Only<"schema">)
  | ({ readonly type: "enum" } & Only<"values">)
  | ({ readonly type: "union" } & Only<"tag" | "variants">)
  | ({ readonly type: "json" } & Only<"json">);

/** A nullable field: the inner value's layout, flattened next to `innerType` (read it with `valueMetaOf`). */
export type NullableMeta = {
  readonly name: string;
  readonly type: "nullable";
  readonly innerType: ValueMeta["type"];
} & { readonly [P in keyof Layout]?: Layout[P] | undefined };

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
    case "array":
    case "record":
      return { type: descriptor.kind, element: buildValueMeta(descriptor.element) };
    case "schema":
      return { type: "schema", schema: descriptor };
    default:
      return buildLeafMeta(descriptor);
  }
}

function buildLeafMeta(descriptor: Exclude<BaseFieldDescriptor, { kind: "array" | "record" | "schema" }>): ValueMeta {
  switch (descriptor.kind) {
    case "primitive":
      return { type: descriptor.type };
    case "enum":
      return { type: "enum", values: descriptor.values };
    case "union":
      return { type: "union", tag: descriptor.tag, variants: variantsOf(descriptor.variants) };
    case "json":
      return { type: "json", json: descriptor.schema };
  }
}

function variantsOf(variants: Readonly<Record<string, AnySchema>>): readonly VariantMeta[] {
  return Object.entries(variants).map(([name, variantSchema]) => ({ name, schema: variantSchema }));
}

/** The inner layout of each nullable field, so `valueMetaOf` needs no per-type rebuild. */
const innerOf = new WeakMap<FieldMeta, ValueMeta>();

function buildNullableMeta(name: string, inner: ValueMeta): NullableMeta {
  const { type: innerType, ...layout } = inner;
  const meta: NullableMeta = { name, type: "nullable", innerType, ...layout };
  innerOf.set(meta, inner);
  return meta;
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
  const inner = innerOf.get(field);
  if (inner === undefined) throw new Error(`nullable field "${field.name}" was not built by schema()`);
  return inner;
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

// Infer the TypeScript type from a FieldDescriptor. NullableDescriptor<T> unwraps T, which is a
// BaseFieldDescriptor (no nested nullable), so recursion depth is bounded.
type InferField<F> = F extends NullableDescriptor<infer Inner> ? InferNonNullable<Inner> | null : InferNonNullable<F>;

type InferNonNullable<F> =
  F extends PrimitiveDescriptor<infer _T, infer V>
    ? V
    : F extends ArrayDescriptor<infer E>
      ? InferNonNullable<E>[]
      : F extends RecordDescriptor<infer E>
        ? { [key: string]: InferNonNullable<E> }
        : F extends EnumDescriptor<infer V>
          ? V[number]
          : F extends UnionDescriptor<infer Tag, infer V>
            ? InferUnion<Tag, V>
            : F extends JsonDescriptor<infer S>
              ? z.output<S>
              : F extends SchemaDefinition<infer S>
                ? { [K in keyof S]: InferField<S[K]> }
                : never;

/** Flattens an intersection into one object type (for readable unions). */
type Flat<T> = { [K in keyof T]: T[K] };

// The wide `Record<string, schema>` (a generic constraint) stops here instead of recursing forever.
type InferUnion<Tag extends string, V> = string extends keyof V
  ? Record<string, unknown>
  : { [K in keyof V & string]: Flat<{ [P in Tag]: K } & Infer<V[K]>> }[keyof V & string];

// Infer the full TypeScript type from a SchemaDefinition
export type Infer<S> =
  S extends SchemaDefinition<infer TShape> ? { [K in keyof TShape]: InferField<TShape[K]> } : never;
