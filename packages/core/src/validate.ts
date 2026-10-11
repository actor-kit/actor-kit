/**
 * Validation of decoded view values (StandardSchemaV1): every schema and field type checks a JS
 * value against its wire layout, reporting each problem with its path. Values the wire format cannot
 * hold (a string over 65535 UTF-8 bytes, an array over 65535 items) are rejected too.
 */

import { valueMetaOf } from "./meta";
import type { EnumValue, PrimitiveTypeName, ValueMeta } from "./schema";

// --- StandardSchemaV1 (https://standardschema.dev), declared here so core has no dependency for it ---

export interface StandardIssue {
  readonly message: string;
  readonly path: readonly PropertyKey[];
}

export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly StandardIssue[] };

export interface StandardProps<Output> {
  readonly version: 1;
  readonly vendor: "actor-kit";
  validate(value: unknown): StandardResult<Output>;
  readonly types?: { readonly input: Output; readonly output: Output } | undefined;
}

/** What every schema and field type exposes. */
export interface Validates<Output> {
  readonly "~standard": StandardProps<Output>;
  /** The value, typed; throws a `SchemaValidationError` listing every issue. */
  parse(value: unknown): Output;
}

export class SchemaValidationError extends Error {
  readonly issues: readonly StandardIssue[];
  constructor(issues: readonly StandardIssue[]) {
    const described = issues.map(
      (i) => `${i.path.length === 0 ? "(root)" : i.path.map(String).join(".")}: ${i.message}`,
    );
    super(`Invalid value: ${described.join("; ")}`);
    this.name = "SchemaValidationError";
    this.issues = issues;
  }
}

// --- Checks ---

const MAX_COUNT = 0xffff;
const encoder = new TextEncoder();
const show = (value: unknown): string => JSON.stringify(value) ?? String(value);
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type Path = readonly PropertyKey[];
type Issues = StandardIssue[];

const issue = (message: string, path: Path): Issues => [{ message, path }];

const integer = (min: number, max: number) => ({
  ok: (v: unknown) => Number.isInteger(v) && Number(v) >= min && Number(v) <= max,
  message: `expected an integer from ${min} to ${max}`,
});

type FixedTypeName = Exclude<PrimitiveTypeName, "string">;

const PRIMITIVES: { readonly [K in FixedTypeName]: { ok(v: unknown): boolean; message: string } } = {
  uint8: integer(0, 0xff),
  uint16: integer(0, 0xffff),
  uint32: integer(0, 0xffffffff),
  int8: integer(-0x80, 0x7f),
  int16: integer(-0x8000, 0x7fff),
  int32: integer(-0x80000000, 0x7fffffff),
  float32: { ok: (v) => typeof v === "number", message: "expected a number" },
  float64: { ok: (v) => typeof v === "number", message: "expected a number" },
  boolean: { ok: (v) => typeof v === "boolean", message: "expected a boolean" },
};

function checkFixed(type: FixedTypeName, value: unknown, path: Path): Issues {
  const check = PRIMITIVES[type];
  return check.ok(value) ? [] : issue(check.message, path);
}

function checkString(value: unknown, path: Path): Issues {
  if (typeof value !== "string") return issue("expected a string", path);
  if (encoder.encode(value).byteLength > MAX_COUNT) {
    return issue(`expected a string of at most ${MAX_COUNT} UTF-8 bytes`, path);
  }
  return [];
}

function checkEnum(values: readonly EnumValue[], value: unknown, path: Path): Issues {
  return values.some((v) => v === value) ? [] : issue(`expected one of ${values.map(show).join(", ")}`, path);
}

function checkArray(element: ValueMeta, value: unknown, path: Path): Issues {
  if (!Array.isArray(value)) return issue("expected an array", path);
  if (value.length > MAX_COUNT) return issue(`expected at most ${MAX_COUNT} items`, path);
  return value.flatMap((item, i) => checkValue(element, item, [...path, i]));
}

function checkEntry(element: ValueMeta, key: string, item: unknown, path: Path): Issues {
  if (encoder.encode(key).byteLength > MAX_COUNT) {
    return issue(`expected a key of at most ${MAX_COUNT} UTF-8 bytes`, [...path, key]);
  }
  return checkValue(element, item, [...path, key]);
}

function checkEntries(element: ValueMeta, value: unknown, path: Path): Issues {
  if (!isObject(value)) return issue("expected an object", path);
  const entries = Object.entries(value);
  if (entries.length > MAX_COUNT) return issue(`expected at most ${MAX_COUNT} entries`, path);
  return entries.flatMap(([key, item]) => checkEntry(element, key, item, path));
}

type AnySchema = Extract<ValueMeta, { type: "schema" }>["schema"];
type UnionMeta = Extract<ValueMeta, { type: "union" }>;
type JsonMeta = Extract<ValueMeta, { type: "json" }>;

/** A nullable value's own mismatch (at `path` itself) says "or null"; deeper ones are unchanged. */
function orNull(issues: Issues, path: Path): Issues {
  return issues.map((i) => (i.path.length === path.length ? { ...i, message: `${i.message} or null` } : i));
}

function checkField(field: AnySchema["fields"][number], item: unknown, path: Path): Issues {
  if (field.type !== "nullable") return checkValue(field, item, path);
  return item === null ? [] : orNull(checkValue(valueMetaOf(field), item, path), path);
}

function checkFields(schemaDef: AnySchema, value: unknown, path: Path): Issues {
  if (!isObject(value)) return issue("expected an object", path);
  return schemaDef.fields.flatMap((field) => checkField(field, value[field.name], [...path, field.name]));
}

function checkUnion(meta: UnionMeta, value: unknown, path: Path): Issues {
  if (!isObject(value)) return issue("expected an object", path);
  const variant = meta.variants.find((v) => v.name === value[meta.tag]);
  if (variant === undefined) {
    return issue(`expected one of ${meta.variants.map((v) => show(v.name)).join(", ")}`, [...path, meta.tag]);
  }
  return checkFields(variant.schema, value, path);
}

function checkJson(meta: JsonMeta, value: unknown, path: Path): Issues {
  const parsed = meta.json.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((i) => ({ message: i.message, path: [...path, ...i.path] }));
}

function checkValue(meta: ValueMeta, value: unknown, path: Path): Issues {
  switch (meta.type) {
    case "array":
      return checkArray(meta.element, value, path);
    case "record":
      return checkEntries(meta.element, value, path);
    case "schema":
      return checkFields(meta.schema, value, path);
    case "union":
      return checkUnion(meta, value, path);
    default:
      return checkLeaf(meta, value, path);
  }
}

function checkLeaf(
  meta: Extract<ValueMeta, { type: PrimitiveTypeName | "enum" | "json" }>,
  value: unknown,
  path: Path,
): Issues {
  switch (meta.type) {
    case "enum":
      return checkEnum(meta.values, value, path);
    case "json":
      return checkJson(meta, value, path);
    case "string":
      return checkString(value, path);
    default:
      return checkFixed(meta.type, value, path);
  }
}

/** Every problem with `value` as `meta`'s layout (null allowed when `nullable`). */
export function issuesOf(meta: ValueMeta, value: unknown, nullable: boolean): StandardIssue[] {
  if (!nullable) return checkValue(meta, value, []);
  return value === null ? [] : orNull(checkValue(meta, value, []), []);
}

/** `~standard` and `parse` for a layout. `meta` is read lazily (a schema builds it after itself). */
export function validates<Output>(meta: () => ValueMeta, nullable = false): Validates<Output> {
  // A type guard over the check: the value is Output exactly when it has no issues.
  const valid = (value: unknown, issues: readonly StandardIssue[]): value is Output => issues.length === 0;
  return {
    "~standard": {
      version: 1,
      vendor: "actor-kit",
      validate(value) {
        const issues = issuesOf(meta(), value, nullable);
        return valid(value, issues) ? { value } : { issues };
      },
    },
    parse(value) {
      const issues = issuesOf(meta(), value, nullable);
      if (valid(value, issues)) return value;
      throw new SchemaValidationError(issues);
    },
  };
}
