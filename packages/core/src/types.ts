/**
 * Shared types used across multiple @actor-kit packages.
 *
 * These types are extracted from message.ts and callback.ts so that
 * both @actor-kit/worker and @actor-kit/client can depend on them
 * without circular dependencies.
 */

import type { z } from "zod";

// --- CallbackDef (from callback.ts) ---

export interface CallbackDef<TKey extends string = string, TResult = unknown, TMeta = void> {
  readonly key: TKey;
  readonly resultSchema: z.ZodType<TResult>;
  readonly metaSchema: TMeta extends void ? undefined : z.ZodType<TMeta>;
}

// --- Effect types for emit() and request() ---

export type Effect =
  | { queue: string; body: unknown }
  | { fetch: string; method?: string; body?: unknown; headers?: Record<string, string> }
  | { actor: string; id: string; message: string; payload: unknown };

/** User-facing request config — accepts CallbackDef objects + typed meta. */
export type RequestConfig = Effect & {
  onDone: CallbackDef<string, unknown, unknown> | string;
  onError: CallbackDef<string, unknown, unknown> | string;
  meta?: unknown;
};

/** Normalized request config — keys extracted from CallbackDefs, stored in outbox. */
export interface NormalizedRequestConfig {
  effect: Effect;
  onDone: string;
  onError: string;
  meta?: unknown;
}

/** Normalize a RequestConfig — extract .key from CallbackDefs, separate effect from callbacks. */
export function normalizeRequest(config: RequestConfig): NormalizedRequestConfig {
  const { onDone, onError, meta, ...effect } = config;
  return {
    effect: effect as Effect,
    onDone: typeof onDone === "string" ? onDone : onDone.key,
    onError: typeof onError === "string" ? onError : onError.key,
    meta,
  };
}

export type EmitFn = (effect: Effect) => void;
export type RequestFn = (config: RequestConfig) => void;

// --- Message context ---

export interface MessageContext<TEnv = unknown> {
  readonly caller: string;
  readonly callerType: "user" | "service";
  readonly role: string;
  readonly env: TEnv;
  readonly emit: EmitFn;
  readonly request: RequestFn;
}

// --- MessageDef ---

export interface MessageDef<TState = unknown, TPayload = unknown, TEnv = unknown> {
  readonly schema: z.ZodType<TPayload>;
  readonly handler: (state: TState, payload: TPayload, ctx: MessageContext<TEnv>) => TState | Promise<TState>;
  readonly guard?: (state: TState) => boolean;
}
