/**
 * Shared types used across multiple @actor-kit packages.
 *
 * These types are extracted from message.ts so that both @actor-kit/worker
 * and @actor-kit/client can depend on them without circular dependencies.
 */

import type { z } from "zod";
import type { Infer, SchemaDefinition } from "./schema";

// --- Service execution types for execute() ---

/** Recorded execution from execute() — captured in outbox for durable replay. */
export interface Execution {
  readonly service: string;
  readonly input: unknown;
}

/** execute() triggers a named service with a typed input. */
export type ExecuteFn = (service: string, input: unknown) => void;

// --- Message context ---

/** link() records a subscription intent. Fire-and-forget in message handlers. */
export type LinkFn = (name: string, id: string) => void;

/** unlink() removes a subscription. If id is omitted, removes all for that link name. */
export type UnlinkFn = (name: string, id?: string) => void;

/** A forwarded message — preserves original caller identity when delivered. */
export interface ForwardCall {
  readonly linkName: string;
  readonly targetId: string;
  readonly message: { type: string; [key: string]: unknown };
}

/** forward() delivers a message to another actor with the original caller identity preserved. */
export type ForwardFn = (linkName: string, targetId: string, message: { type: string; [key: string]: unknown }) => void;

/**
 * Time and randomness for handlers (ADR-013). Live, they read the real clock and RNG
 * and record what they returned in the journal; on replay they return the recorded values.
 * Handlers must use these instead of Date.now(), Math.random() or crypto.randomUUID().
 */
export interface DeterministicContext {
  /** Current time in ms. One value per transition: every call in a handler returns the same number. */
  readonly now: () => number;
  /** A fresh unique ID (UUID v4 when live). */
  readonly id: () => string;
  /** A random number in [0, 1). */
  readonly random: () => number;
}

// --- Timers (ADR-015 D2) ---

/** Milliseconds, or a number with a unit: "500ms", "30s", "5m", "2h", "1d". */
export type Duration = number | `${number}${"ms" | "s" | "m" | "h" | "d"}`;

export interface ScheduleOptions {
  /** Fire this long after the transition (from ctx.now(), so replay computes the same deadline). */
  readonly in?: Duration;
  /** Or fire at this time (ms since the epoch). Exactly one of `in` and `at`. */
  readonly at?: number;
  /** Unique per actor: scheduling an existing key replaces that timer. Default: the timer's effect id. */
  readonly key?: string;
  /** Validated by the timer's schema when scheduled. */
  readonly payload?: unknown;
}

/** schedule() starts a durable timer declared in the actor's `timers` block. */
export type ScheduleFn = (timer: string, options: ScheduleOptions) => void;

/** cancel() removes a pending timer by key. Cancelling a key that is not pending does nothing. */
export type CancelFn = (key: string) => void;

export interface MessageContext<TEnv = unknown> extends DeterministicContext {
  readonly caller: string;
  readonly callerType: "user" | "service";
  readonly role: string;
  readonly env: TEnv;
  readonly execute: ExecuteFn;
  readonly link: LinkFn;
  readonly unlink: UnlinkFn;
  readonly forward: ForwardFn;
  readonly schedule: ScheduleFn;
  readonly cancel: CancelFn;
}

/** What a timer's handler gets. A timer has no caller and no role. */
export interface TimerContext<TEnv = unknown> extends DeterministicContext {
  readonly env: TEnv;
  /** The timer's key. */
  readonly key: string;
  /** How late it fired, in ms (0 when on time or fired early from Studio). */
  readonly lateBy: number;
  readonly execute: ExecuteFn;
  readonly forward: ForwardFn;
  readonly schedule: ScheduleFn;
  readonly cancel: CancelFn;
}

export interface TimerDef<TState = unknown, TPayload = unknown, TEnv = unknown> {
  readonly schema: z.ZodType<TPayload>;
  readonly handler: (state: TState, payload: TPayload, ctx: TimerContext<TEnv>) => TState;
}

// --- Guard context ---

/** Context available to guards — pure predicates, no side effects. */
export interface GuardContext<TEnv = unknown> {
  readonly role: string;
  readonly caller: string;
  readonly callerType: "user" | "service";
  readonly env: TEnv;
}

// --- MessageDef ---

export interface MessageDef<TState = unknown, TPayload = unknown, TEnv = unknown> {
  readonly schema: z.ZodType<TPayload>;
  readonly handler: (state: TState, payload: TPayload, ctx: MessageContext<TEnv>) => TState;
  readonly guard?: (state: TState, payload: TPayload, ctx: GuardContext<TEnv>) => boolean;
}

// --- Contract message union ---

/**
 * One message as sent over the wire: `{ type: K }` plus its payload fields.
 * An empty payload schema (`z.object({})`) infers as `Record<string, never>`
 * in Zod 4 — intersecting that would make `type` itself `never`, so a payload
 * whose keys are an index signature collapses to just `{ type: K }`.
 */
export type MessageEvent<K extends string, P> = string extends keyof P ? { type: K } : { type: K } & P;

/** Discriminated union of every message a contract accepts. */
export type ContractMessages<T> = T extends {
  def: { messages: Record<string, { schema: { _output: unknown } }> };
}
  ? {
      [K in keyof T["def"]["messages"] & string]: T["def"]["messages"][K] extends {
        schema: { _output: infer P };
      }
        ? MessageEvent<K, P>
        : { type: K };
    }[keyof T["def"]["messages"] & string]
  : { type: string; [key: string]: unknown };

// --- Timeline types (studio instrumentation) ---

/** Discriminated union of all mutation causes for the timeline. */
export type MutationCause =
  | { readonly type: "init" }
  | { readonly type: "migrate"; readonly fromVersion: number; readonly toVersion: number }
  | {
      readonly type: "message";
      readonly messageType: string;
      readonly caller: string;
      readonly callerType: "user" | "service";
      readonly role: string;
      readonly payload: unknown;
    }
  | {
      readonly type: "lifecycle.connect";
      readonly caller: string;
      readonly callerType: "user" | "service";
      readonly role: string;
    }
  | {
      readonly type: "lifecycle.disconnect";
      readonly caller: string;
      readonly callerType: "user" | "service";
      readonly role: string;
    }
  | { readonly type: "service.onDone"; readonly service: string; readonly input: unknown; readonly result: unknown }
  | { readonly type: "service.onError"; readonly service: string; readonly input: unknown; readonly error: string }
  | {
      readonly type: "link.onUpdate";
      readonly sourceType: string;
      readonly sourceId: string;
      readonly viewData: unknown;
    }
  | { readonly type: "link.onError"; readonly sourceType: string; readonly sourceId: string; readonly error: string }
  | { readonly type: "link.onUnlink"; readonly sourceType: string; readonly sourceId: string }
  | {
      readonly type: "timer";
      readonly name: string;
      readonly key: string;
      readonly payload: unknown;
      readonly fireAt: number;
      readonly lateBy: number;
    };

/** A single entry in the actor's timeline — records a state mutation and its cause. */
export interface TimelineEntry {
  readonly cause: MutationCause;
  readonly stateSnapshot: unknown;
  readonly checksum: string;
  readonly createdAt: number;
}

// --- LinkedView ---

/**
 * Discriminated union of all views from a contract, with `role` as discriminant.
 * Used by links (actor-to-actor) and React hooks for type-safe view narrowing.
 */
export type LinkedView<T> = T extends {
  def: { views: Record<string, unknown> };
}
  ? {
      [K in keyof T["def"]["views"] & string]: T["def"]["views"][K] extends {
        schema: SchemaDefinition<infer TShape>;
      }
        ? { role: K } & Infer<SchemaDefinition<TShape>>
        : never;
    }[keyof T["def"]["views"] & string]
  : never;
