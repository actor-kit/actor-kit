/**
 * Service options (ADR-018 G): delivery mode, result schema and size limit, resolved and validated once
 * per service at definition time, plus the pure parts of running a try that the Durable Object and
 * simulate() share: parsing a result, settling a try an eviction cut off, and the attempt log line.
 *
 * - `delivery: "at-least-once"` (default): a try cut off by an eviction counts as an attempt with error
 *   `{ _tag: "Evicted" }`; retry limits apply, and the last one runs onError.
 * - `delivery: "at-most-once"`: one try only. The row is marked running (committed) before `fn` runs; a
 *   row still running when the actor wakes becomes an `OutcomeUnknown` dead letter, never sent again
 *   (an operator checks the remote system and redrives it if the call did not happen).
 * - `result`: `fn`'s return is parsed; only the parsed value is journaled and passed to onDone. A result
 *   that does not parse, or whose JSON is over `maxResultBytes` (default 128 KiB), fails the try as a
 *   Defect.
 */

import { ActorKitError } from "@actor-kit/core";
import { z } from "zod";
import type { AttemptResult } from "./attempt";
import { idempotencyKey } from "./effect-info";
import { type RetryPolicy, resolveRetryPolicy, resolveRetryRule, retryDelay, type TryOutcome } from "./retry";
import { type DefectError, defectError, type TaggedError } from "./service-error";

export const DEFAULT_MAX_RESULT_BYTES = 128 * 1024;

export type Delivery = "at-least-once" | "at-most-once";

/** The structural slice of a Zod schema a result needs. */
export interface ResultParser {
  safeParse(value: unknown):
    | { success: true; data: unknown }
    | {
        success: false;
        error: { message: string; issues?: readonly { path: readonly PropertyKey[]; message: string }[] };
      };
}

export interface ServiceOptions {
  readonly delivery: Delivery;
  readonly policy: RetryPolicy;
  readonly rule: (error: TaggedError) => boolean;
  readonly maxResultBytes: number;
  readonly result: ResultParser | undefined;
}

const ParserSchema = z.custom<ResultParser>(
  (value) =>
    typeof value === "object" && value !== null && "safeParse" in value && typeof value.safeParse === "function",
  "expected a Zod schema",
);

const OptionsSchema = z.object({
  delivery: z.enum(["at-least-once", "at-most-once"]).optional(),
  maxResultBytes: z.number().int().positive().optional(),
  result: ParserSchema.optional(),
});

function invalid(name: string, why: string): ActorKitError {
  return new ActorKitError("invalid_service_option", `Service "${name}": ${why}`);
}

/** The retry policy under a delivery mode: an at-most-once service tries once, and may not ask for retries. */
function deliveryPolicy(name: string, delivery: Delivery, retry: unknown): RetryPolicy {
  const policy = resolveRetryPolicy(retry);
  if (delivery === "at-least-once") return policy;
  if (retry !== undefined && policy.attempts > 1) {
    throw invalid(
      name,
      'an at-most-once service cannot retry: remove retry, or use delivery: "at-least-once" with an idempotency key.',
    );
  }
  return { ...policy, attempts: 1 };
}

/** Validate a service's delivery, result and retry options at definition time and fill in the defaults. */
export function resolveServiceOptions(name: string, service: Readonly<Record<string, unknown>>): ServiceOptions {
  const parsed = OptionsSchema.safeParse(service);
  if (!parsed.success) {
    throw invalid(
      name,
      `${parsed.error.message}. Use delivery: "at-least-once" | "at-most-once", a positive maxResultBytes and a Zod result schema.`,
    );
  }
  const delivery = parsed.data.delivery ?? "at-least-once";
  return {
    delivery,
    policy: deliveryPolicy(name, delivery, service["retry"]),
    rule: resolveRetryRule(service["retry"]),
    maxResultBytes: parsed.data.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES,
    result: parsed.data.result,
  };
}

function issuesText(error: {
  message: string;
  issues?: readonly { path: readonly PropertyKey[]; message: string }[];
}): string {
  if (error.issues === undefined) return error.message;
  return error.issues.map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`).join("; ");
}

/** The JSON text of a value ("" for undefined), or null when it cannot be serialized. */
function jsonOf(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return null;
  }
}

/** A try's return value as onDone gets it: parsed by `result`, within the size limit; else a Defect. */
export function parseServiceResult(
  name: string,
  options: { readonly result?: ResultParser | undefined; readonly maxResultBytes?: number | undefined },
  value: unknown,
): { ok: true; value: unknown } | { ok: false; error: DefectError } {
  let parsed = value;
  if (options.result !== undefined) {
    const result = options.result.safeParse(value);
    if (!result.success) {
      return {
        ok: false,
        error: defectError(
          `Service "${name}" returned a result that does not match its result schema (${issuesText(result.error)}). Return a value that parses with result.`,
        ),
      };
    }
    parsed = result.data;
  }
  const json = jsonOf(parsed);
  if (json === null) {
    return {
      ok: false,
      error: defectError(
        `Service "${name}" returned a result that is not JSON (it holds a BigInt, a cycle or similar). Return plain JSON data.`,
      ),
    };
  }
  const bytes = new TextEncoder().encode(json).byteLength;
  const limit = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
  if (bytes > limit) {
    return {
      ok: false,
      error: defectError(
        `Service "${name}" returned ${bytes} bytes of JSON, over its limit of ${limit}. Return a reference (an id or a URL) instead, or raise maxResultBytes.`,
      ),
    };
  }
  return { ok: true, value: parsed };
}

/** A try's outcome with its result parsed (an aborted try stays aborted, a failed one stays failed). */
export function parsedOutcome(
  name: string,
  options: { readonly result?: ResultParser | undefined; readonly maxResultBytes?: number | undefined },
  tried: AttemptResult,
): AttemptResult {
  if ("aborted" in tried || !tried.ok) return tried;
  const parsed = parseServiceResult(name, options, tried.result);
  return parsed.ok ? { ok: true, result: parsed.value } : { ok: false, error: parsed.error };
}

/** How a row a try was running for ends when the actor wakes without its result. */
export interface InterruptedSettlement {
  readonly settlement: { readonly status: "failed" } | { readonly status: "retrying"; readonly nextAttemptAt: number };
  readonly lastError: string;
  readonly lastErrorTag: "Evicted" | "OutcomeUnknown";
  /** The error onError runs with when the row fails for good after an eviction (never for OutcomeUnknown). */
  readonly onError: { readonly _tag: "Evicted" } | null;
}

/** Settle a row left running by an eviction (`attempts` already counts the try that was cut off). */
export function settleInterrupted(
  row: { readonly attempts: number },
  options: Pick<ServiceOptions, "delivery" | "policy">,
  now: number,
  random: () => number,
): InterruptedSettlement {
  if (options.delivery === "at-most-once") {
    return {
      settlement: { status: "failed" },
      lastError:
        "outcome unknown: the actor was evicted while this at-most-once call ran, so it is not sent again. Check the remote system, then redrive it if it did not happen.",
      lastErrorTag: "OutcomeUnknown",
      onError: null,
    };
  }
  const last = row.attempts >= options.policy.attempts;
  return {
    settlement: last
      ? { status: "failed" }
      : { status: "retrying", nextAttemptAt: now + retryDelay(row.attempts, options.policy, random) },
    lastError: "evicted while the try ran",
    lastErrorTag: "Evicted",
    onError: last ? { _tag: "Evicted" } : null,
  };
}

export interface ServiceAttemptEvent {
  readonly event: "actor_kit.service.attempt";
  readonly actorType: string;
  readonly actorId: string;
  readonly service: string;
  readonly effectId: string;
  readonly idempotencyKey: string;
  readonly attempt: number;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly errorTag?: string;
}

/** The structured line logged after every try (ADR-018 G). Stable fields first; never the input or result. */
export function serviceAttemptEvent(fields: {
  actorType: string;
  actorId: string;
  service: string;
  effectId: string;
  attempt: number;
  durationMs: number;
  outcome: TryOutcome;
}): ServiceAttemptEvent {
  const { actorType, actorId, service, effectId, attempt, durationMs, outcome } = fields;
  const event: ServiceAttemptEvent = {
    event: "actor_kit.service.attempt",
    actorType,
    actorId,
    service,
    effectId,
    idempotencyKey: idempotencyKey(actorType, actorId, effectId),
    attempt,
    durationMs,
    ok: outcome.ok,
  };
  return outcome.ok ? event : { ...event, errorTag: outcome.error._tag };
}
