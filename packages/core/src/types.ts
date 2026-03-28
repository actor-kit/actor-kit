/**
 * Shared types used across multiple @actor-kit packages.
 *
 * These types are extracted from message.ts so that both @actor-kit/worker
 * and @actor-kit/client can depend on them without circular dependencies.
 */

import type { z } from "zod";

// --- Effect types for emit() ---

export type Effect =
  | { queue: string; body: unknown }
  | { fetch: string; method?: string; body?: unknown; headers?: Record<string, string> }
  | { actor: string; id: string; message: string; payload: unknown };

export type EmitFn = (effect: Effect) => void;

// --- Message context ---

export interface MessageContext<TEnv = unknown> {
  readonly caller: string;
  readonly callerType: "user" | "service";
  readonly role: string;
  readonly env: TEnv;
  readonly emit: EmitFn;
}

// --- Guard context ---

/** Context available to guards — same as MessageContext (guards are pure predicates). */
export interface GuardContext<TEnv = unknown> {
  readonly role: string;
  readonly caller: string;
  readonly callerType: "user" | "service";
  readonly env: TEnv;
  readonly emit: EmitFn;
}

// --- MessageDef ---

export interface MessageDef<TState = unknown, TPayload = unknown, TEnv = unknown> {
  readonly schema: z.ZodType<TPayload>;
  readonly handler: (state: TState, payload: TPayload, ctx: MessageContext<TEnv>) => TState | Promise<TState>;
  readonly guard?: (state: TState, payload: TPayload, ctx: GuardContext<TEnv>) => boolean;
}
