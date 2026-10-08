/**
 * Service retry policy (ADR-015 D1, defaults from ADR-003).
 *
 * A service may declare `retry: { attempts, backoff }`. `attempts` is the total number of tries
 * (default 3). Between tries the row waits as `retrying`; the delay after the n-th failed try is
 * `min(baseMs * factor^(n-1), maxMs)`, spread by ±jitter. After the last failed try the row is
 * `failed` (a dead letter) and only then does `onError` run.
 */

import { z } from "zod";

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
  })
  .optional();

export type RetryOption = z.input<typeof RetryOptionSchema>;

/** Validate a service's `retry` option at definition time and fill in the defaults. */
export function resolveRetryPolicy(option: unknown): RetryPolicy {
  return policyFor(option, "service");
}

/** `owner` names what the option belongs to in the error (`service`, `link "room"`). */
function policyFor(option: unknown, owner: string): RetryPolicy {
  const parsed = RetryOptionSchema.safeParse(option);
  if (!parsed.success) {
    throw new Error(`Invalid ${owner} retry option: ${parsed.error.message}`);
  }
  const backoff = parsed.data?.backoff;
  return {
    attempts: parsed.data?.attempts ?? DEFAULT_RETRY_POLICY.attempts,
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

/** What a finished try leaves the row as. `attempt` counts this try (1 = first). */
export function settleAttempt(
  outcome: { readonly ok: boolean },
  attempt: number,
  policy: RetryPolicy,
  now: number,
  random: () => number,
): AttemptSettlement {
  if (outcome.ok) return { status: "done" };
  if (attempt >= policy.attempts) return { status: "failed" };
  return { status: "retrying", nextAttemptAt: now + retryDelay(attempt, policy, random) };
}

/** The forward retry policy of every declared link (forwards through undeclared links get the default). */
export function linkRetryPolicies(links: Readonly<Record<string, { readonly retry?: unknown }>> | undefined) {
  return new Map<string, RetryPolicy>(
    Object.entries(links ?? {}).map(([name, linkDef]) => [name, policyFor(linkDef.retry, `link "${name}"`)]),
  );
}
