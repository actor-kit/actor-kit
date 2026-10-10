/**
 * Service retry policy (ADR-015 D1, defaults from ADR-003).
 *
 * A service may declare `retry: { attempts, backoff }`. `attempts` is the total number of tries
 * (default 3). Between tries the row waits as `retrying`; the delay after the n-th failed try is
 * `min(baseMs * factor^(n-1), maxMs)`, spread by ±jitter. After the last failed try the row is
 * `failed` (a dead letter) and only then does `onError` run.
 *
 * Which errors are retried (ADR-016 §2): by default the built-ins (`Timeout`, `Defect`) are, declared
 * errors are not (a declared error is a domain answer). `retry.while(error)` overrides that per error.
 */

import { z } from "zod";
import { describeServiceError, isBuiltInError, type TaggedError } from "./service-error";

export interface RetryPolicy {
  /** Total number of tries, including the first. */
  readonly attempts: number;
  readonly baseMs: number;
  readonly factor: number;
  readonly maxMs: number;
  /** Fraction of the delay to spread by, in [0, 1). */
  readonly jitter: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { attempts: 3, baseMs: 1000, factor: 5, maxMs: 60_000, jitter: 0.2 };

const RetryOptionSchema = z
  .object({
    attempts: z.number().int().min(1).optional(),
    backoff: z
      .object({
        baseMs: z.number().min(0).optional(),
        factor: z.number().min(1).optional(),
        maxMs: z.number().min(0).optional(),
        jitter: z.number().min(0).lt(1).optional(),
      })
      .optional(),
    /** Retry a failed try when this returns true (default: only the built-in errors). */
    while: z
      .custom<(error: TaggedError) => boolean>((value) => typeof value === "function", "expected a function")
      .optional(),
  })
  .optional();

export type RetryOption = z.input<typeof RetryOptionSchema>;

/** Validate a service's `retry` option at definition time and fill in the defaults. */
export function resolveRetryPolicy(option: unknown): RetryPolicy {
  return policyFor(option, "service");
}

/** `owner` names what the option belongs to in the error (`service`, `link "room"`). */
function parseOption(option: unknown, owner: string) {
  const parsed = RetryOptionSchema.safeParse(option);
  if (!parsed.success) {
    throw new Error(`Invalid ${owner} retry option: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Which failed tries are retried: `retry.while`, or by default only the built-in errors (ADR-016 §2). */
export function resolveRetryRule(option: unknown, owner = "service"): (error: TaggedError) => boolean {
  return parseOption(option, owner)?.while ?? isBuiltInError;
}

function policyFor(option: unknown, owner: string): RetryPolicy {
  const data = parseOption(option, owner);
  const backoff = data?.backoff;
  return {
    attempts: data?.attempts ?? DEFAULT_RETRY_POLICY.attempts,
    baseMs: backoff?.baseMs ?? DEFAULT_RETRY_POLICY.baseMs,
    factor: backoff?.factor ?? DEFAULT_RETRY_POLICY.factor,
    maxMs: backoff?.maxMs ?? DEFAULT_RETRY_POLICY.maxMs,
    jitter: backoff?.jitter ?? DEFAULT_RETRY_POLICY.jitter,
  };
}

/** Delay before the next try, after `failedAttempts` tries have failed. `random` is in [0, 1). */
export function retryDelay(failedAttempts: number, policy: RetryPolicy, random: () => number): number {
  const base = Math.min(policy.baseMs * policy.factor ** (failedAttempts - 1), policy.maxMs);
  const spread = 1 + policy.jitter * (2 * random() - 1);
  return Math.max(0, Math.round(base * spread));
}

export type AttemptSettlement =
  | { readonly status: "done" }
  | { readonly status: "retrying"; readonly nextAttemptAt: number }
  | { readonly status: "failed" };

/**
 * What a finished try leaves the row as. `attempt` counts this try (1 = first). A failure with
 * `retryable: false` (its error is not retried, ADR-016 §2) fails for good at once.
 */
export function settleAttempt(
  outcome: { readonly ok: boolean; readonly retryable?: boolean },
  attempt: number,
  policy: RetryPolicy,
  now: number,
  random: () => number,
): AttemptSettlement {
  if (outcome.ok) return { status: "done" };
  if (outcome.retryable === false || attempt >= policy.attempts) return { status: "failed" };
  return { status: "retrying", nextAttemptAt: now + retryDelay(attempt, policy, random) };
}

/** Whether to retry a failed try: the rule's answer, or false when the rule itself throws. */
export function shouldRetry(rule: (error: TaggedError) => boolean, error: TaggedError): boolean {
  try {
    return rule(error) === true;
  } catch {
    return false;
  }
}

/** How a try of a service or a forward ended: its result, or its typed error (ADR-016 §2). */
export type TryOutcome =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: TaggedError };

/** A finished try, settled: the row's next status, and the error text and tag to store with it. */
export interface SettledTry {
  readonly settlement: AttemptSettlement;
  readonly lastError: string | null;
  readonly lastErrorTag: string | null;
}

/** Settle a try under a policy and a retry rule. */
export function settleTry(
  outcome: TryOutcome,
  attempt: number,
  retry: { readonly policy: RetryPolicy; readonly rule: (error: TaggedError) => boolean },
  now: number,
  random: () => number,
): SettledTry {
  if (outcome.ok)
    return {
      settlement: settleAttempt(outcome, attempt, retry.policy, now, random),
      lastError: null,
      lastErrorTag: null,
    };
  const retryable = shouldRetry(retry.rule, outcome.error);
  return {
    settlement: settleAttempt({ ok: false, retryable }, attempt, retry.policy, now, random),
    lastError: describeServiceError(outcome.error),
    lastErrorTag: outcome.error._tag,
  };
}

/** The retry rule of every declared link's forwards (undeclared links get the default rule). */
export function linkRetryRules(links: Readonly<Record<string, { readonly retry?: unknown }>> | undefined) {
  return new Map<string, (error: TaggedError) => boolean>(
    Object.entries(links ?? {}).map(([name, linkDef]) => [name, resolveRetryRule(linkDef.retry, `link "${name}"`)]),
  );
}

/** The forward retry policy of every declared link (forwards through undeclared links get the default). */
export function linkRetryPolicies(links: Readonly<Record<string, { readonly retry?: unknown }>> | undefined) {
  return new Map<string, RetryPolicy>(
    Object.entries(links ?? {}).map(([name, linkDef]) => [name, policyFor(linkDef.retry, `link "${name}"`)]),
  );
}
