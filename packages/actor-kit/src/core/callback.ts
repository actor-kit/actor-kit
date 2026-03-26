/**
 * callback() — typed callback definition for request() onDone/onError handlers.
 *
 * Pairs a callback name with Zod schemas for the result and optional meta.
 * Used with request() to create a compile-time link between the request site
 * and the callback handler in the actor's `callbacks` block.
 *
 * Usage:
 *   const PriceReceived = callback("PRICE_RECEIVED", z.object({ total: z.number() }));
 *   const PriceFailed = callback("PRICE_FAILED", z.object({ message: z.string() }));
 *
 * With meta (per-request context):
 *   const PriceReceived = callback(
 *     "PRICE_RECEIVED",
 *     z.object({ total: z.number() }),
 *     z.object({ itemId: z.string() }),
 *   );
 */

import type { z } from "zod";

// --- CallbackDef ---

export interface CallbackDef<TKey extends string = string, TResult = unknown, TMeta = void> {
  readonly key: TKey;
  readonly resultSchema: z.ZodType<TResult>;
  readonly metaSchema: TMeta extends void ? undefined : z.ZodType<TMeta>;
}

// --- callback() function ---

// Overload 1: without meta
export function callback<TKey extends string, TResultSchema extends z.ZodTypeAny>(
  key: TKey,
  resultSchema: TResultSchema,
): CallbackDef<TKey, z.infer<TResultSchema>, void>;

// Overload 2: with meta
export function callback<TKey extends string, TResultSchema extends z.ZodTypeAny, TMetaSchema extends z.ZodTypeAny>(
  key: TKey,
  resultSchema: TResultSchema,
  metaSchema: TMetaSchema,
): CallbackDef<TKey, z.infer<TResultSchema>, z.infer<TMetaSchema>>;

// Implementation — uses a single runtime shape that satisfies both overloads
export function callback(
  key: string,
  resultSchema: z.ZodTypeAny,
  metaSchema?: z.ZodTypeAny,
): { key: string; resultSchema: z.ZodTypeAny; metaSchema: z.ZodTypeAny | undefined } {
  return {
    key,
    resultSchema,
    metaSchema,
  };
}
