/**
 * Standard Schema (https://standardschema.dev) at actor-kit's boundary (ADR-024). Every schema a game
 * hands actor-kit (message and timer payloads, json() view fields, input, env, versions, events) is
 * one: zod 3.24+, zod 4, valibot and arktype all implement it. Declared here, so core has no
 * dependency for it and no validator in a browser bundle.
 */

import { ActorKitError } from "./errors";

/** One problem a validator found: what, and where (keys, or `{ key }` segments). */
export interface SchemaIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
}

type ValidateResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<SchemaIssue> };

/** Any Standard Schema, from input `I` to output `O`. */
export interface StandardSchema<I = unknown, O = I> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    validate(value: unknown): ValidateResult<O> | Promise<ValidateResult<O>>;
    readonly types?: { readonly input: I; readonly output: O } | undefined;
  };
}

/** What a schema parses to (zod's `z.output`). */
export type SchemaOutput<S> = S extends { readonly "~standard": { readonly types?: infer T } }
  ? NonNullable<T> extends { readonly output: infer O }
    ? O
    : unknown
  : never;

/** What a schema takes (zod's `z.input`). */
export type SchemaInput<S> = S extends { readonly "~standard": { readonly types?: infer T } }
  ? NonNullable<T> extends { readonly input: infer I }
    ? I
    : unknown
  : never;

/** An issue's path as plain keys (`[]` for the value itself; `{ key }` segments unwrapped). */
export function issuePath(issue: SchemaIssue): PropertyKey[] {
  return (issue.path ?? []).map((segment) => (typeof segment === "object" ? segment.key : segment));
}

/**
 * A schema the runtime can parse with: a Standard Schema, or an object with zod's `safeParse` (what
 * actor-kit's runtime accepted structurally before ADR-024). Public signatures take StandardSchema.
 */
export type ParseableSchema<O = unknown> =
  | StandardSchema<unknown, O>
  | {
      safeParse(
        value: unknown,
      ):
        | { success: true; data: O }
        | { success: false; error: { message: string; issues?: ReadonlyArray<SchemaIssue> | undefined } };
    };

export type Parsed<O> =
  | { readonly success: true; readonly data: O }
  | { readonly success: false; readonly issues: ReadonlyArray<SchemaIssue>; readonly message: string };

/**
 * Parse `value` with any Standard Schema. A failure carries the issues and, in `message`, the issues
 * as JSON (what zod 4's `error.message` is). An async validator throws `async_schema`: actor-kit's
 * transitions are synchronous.
 */
export function parseSchema<S extends StandardSchema>(schema: S, value: unknown): Parsed<SchemaOutput<S>>;
export function parseSchema<O>(schema: ParseableSchema<O>, value: unknown): Parsed<O>;
export function parseSchema<O>(schema: ParseableSchema<O>, value: unknown): Parsed<O> {
  if (!("~standard" in schema)) {
    const parsed = schema.safeParse(value);
    if (parsed.success) return { success: true, data: parsed.data };
    return { success: false, issues: parsed.error.issues ?? [], message: parsed.error.message };
  }
  const result = schema["~standard"].validate(value);
  if (result instanceof Promise) {
    throw new ActorKitError(
      "async_schema",
      `A ${schema["~standard"].vendor} schema validated asynchronously. actor-kit parses synchronously: use a schema without async refinements.`,
    );
  }
  if (result.issues === undefined) return { success: true, data: result.value };
  return { success: false, issues: result.issues, message: JSON.stringify(result.issues, null, 2) };
}
