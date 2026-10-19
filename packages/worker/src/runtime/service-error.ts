/**
 * Typed, tagged service errors (ADR-016 §2).
 *
 * A service fails with `throw fail({ _tag: "CardDeclined", reason })`. The runtime parses the value
 * against the service's `errors` schema (a `z.discriminatedUnion("_tag", ...)`). Every service's error
 * union also has two built-ins:
 *
 * - `{ _tag: "Timeout", ms }`: the try ran out of time (ADR-016 §3);
 * - `{ _tag: "Defect", message }`: anything thrown that isn't `fail(...)`, or a `fail(...)` value that
 *   doesn't parse against `errors`.
 *
 * The parsed error is what onError receives and what the journal stores, so replay and restore deliver
 * the same typed value.
 */

import { type ParseableSchema, parseSchema } from "@actor-kit/core";
import { z } from "zod";

/** A value with a `_tag` naming the kind of failure. */
export type TaggedError = {
  readonly _tag: string;
};

export type TimeoutError = {
  readonly _tag: "Timeout";
  /** The try's time limit, in ms. */
  readonly ms: number;
};

export type DefectError = {
  readonly _tag: "Defect";
  readonly message: string;
};

/** A try cut off by an eviction (ADR-018 G): counted as an attempt; onError gets it after the last one. */
export type EvictedError = {
  readonly _tag: "Evicted";
};

export type BuiltInError = TimeoutError | DefectError | EvictedError;

/** What onError (and `retry.while`) receives: the service's declared errors plus the built-ins. */
export type ServiceError<TDeclared = never> = TDeclared | BuiltInError;

const FAILURE = Symbol.for("actor-kit.service-failure");

/** The built-in errors, as a schema (a plain union: it cannot throw while the module loads). */
const BuiltInErrorSchema = z.union([
  z.object({ _tag: z.literal("Timeout"), ms: z.number() }),
  z.object({ _tag: z.literal("Defect"), message: z.string() }),
  z.object({ _tag: z.literal("Evicted") }),
]);

/** What `fail(error)` returns: throw it from a service's `fn`. */
export class ServiceFailure<TError extends TaggedError = TaggedError> extends Error {
  override name = "ServiceFailure";
  readonly [FAILURE]: TError;
  constructor(readonly error: TError) {
    super(error._tag);
    this[FAILURE] = error;
  }
}

/**
 * Mark a declared failure: `throw fail({ _tag: "CardDeclined", reason })`. The runtime parses the value
 * against the service's `errors`; one that doesn't parse becomes a `Defect`. Declared errors are not
 * retried unless `retry.while` says so.
 */
export function fail<const TError extends TaggedError>(error: TError): ServiceFailure<TError> {
  return new ServiceFailure(error);
}

/** Recognises a fail() value, also one made by another copy of this module (bundled twice). */
function failureOf(thrown: unknown): TaggedError | null {
  if (!(thrown instanceof Error) || !(FAILURE in thrown)) return null;
  const error: unknown = thrown[FAILURE];
  return isTaggedError(error) ? error : null;
}

export function isTaggedError(value: unknown): value is TaggedError {
  return typeof value === "object" && value !== null && "_tag" in value && typeof value._tag === "string";
}

export function timeoutError(ms: number): TimeoutError {
  return { _tag: "Timeout", ms };
}

export function defectError(message: string): DefectError {
  return { _tag: "Defect", message };
}

export function isBuiltInError(error: TaggedError): boolean {
  return error._tag === "Timeout" || error._tag === "Defect" || error._tag === "Evicted";
}

/** The structural slice of a Zod schema the runtime needs to parse `errors`. */
/** The schema a service's declared errors parse with (any Standard Schema, ADR-024). */
export type ErrorsParser = ParseableSchema;

/** What a thrown value means: the declared error it parses to, or a Defect. */
export function classifyFailure(thrown: unknown, errors: ErrorsParser | undefined): TaggedError {
  const failure = failureOf(thrown);
  if (failure === null) return defectError(thrown instanceof Error ? thrown.message : String(thrown));
  const what = `fail({ _tag: ${JSON.stringify(failure._tag)} })`;
  if (errors === undefined) return defectError(`${what}: this service declares no errors`);
  const parsed = parseSchema(errors, failure);
  if (!parsed.success) return defectError(`${what} does not match the service's errors: ${parsed.message}`);
  return isTaggedError(parsed.data) ? parsed.data : defectError(`${what}: the service's errors schema has no _tag`);
}

/** The outbox's "Last error" text: a Defect's message, a Timeout's limit, a declared error as JSON. */
export function describeServiceError(error: TaggedError): string {
  const builtIn = BuiltInErrorSchema.safeParse(error);
  if (!builtIn.success) return JSON.stringify(error);
  const known = builtIn.data;
  if (known._tag === "Defect") return known.message;
  return known._tag === "Timeout" ? `timed out after ${known.ms}ms` : "evicted while the try ran";
}

/** A service error read back from the journal (any object): described like describeServiceError. */
export function describeRecordedError(error: Readonly<Record<string, unknown>>): string {
  const tag = error["_tag"];
  if (typeof tag === "string") return describeServiceError({ ...error, _tag: tag });
  const message = error["message"];
  return typeof message === "string" ? message : JSON.stringify(error);
}
