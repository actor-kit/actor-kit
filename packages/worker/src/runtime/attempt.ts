/**
 * Timeouts and cancellation of tries (ADR-016 §3).
 *
 * Every try of a service or a forward runs under a time limit (`timeoutMs`, default 30 000). When it
 * runs out, the try's AbortSignal is aborted (a service sees it as `effect.signal`) and the try ends as
 * `{ _tag: "Timeout", ms }`, which is retried by default. Redrive and restore abort tries still in
 * flight through the in-flight registry. Either way a result that arrives after its try was aborted is
 * discarded, never applied.
 */

import { ActorKitError } from "@actor-kit/core";
import { parseEffectId } from "./effect-id";
import type { TryOutcome } from "./retry";
import { classifyFailure, timeoutError } from "./service-error";

export const DEFAULT_TIMEOUT_MS = 30_000;

/** Validate a service's or link's `timeoutMs` at definition time. `owner` names it in the error. */
export function resolveTimeoutMs(option: unknown, owner: string): number {
  if (option === undefined) return DEFAULT_TIMEOUT_MS;
  if (typeof option !== "number" || !Number.isFinite(option) || option <= 0) {
    throw new ActorKitError(
      "invalid_timeout",
      `Invalid ${owner} timeoutMs: expected a positive number of ms, got ${String(option)}`,
    );
  }
  return option;
}

/** A try's end: its outcome (a timeout is a failed outcome), or aborted from outside (discard it). */
export type AttemptResult = TryOutcome | { readonly aborted: true };

/**
 * Run one try with `controller`'s signal under a `ms` time limit. The first of these wins: the try
 * settles (a throw is a Defect), the time runs out (the signal is aborted, the try is a Timeout), or the
 * controller is aborted from outside (`{ aborted: true }`). After an abort from outside, the try's own
 * outcome, when it comes, goes to `onLate` (ADR-019 B: a scoped call's late result); otherwise it is ignored.
 */
export function runAttempt(
  run: (signal: AbortSignal) => Promise<TryOutcome>,
  ms: number,
  controller: AbortController,
  onLate?: (outcome: TryOutcome) => void,
): Promise<AttemptResult> {
  if (controller.signal.aborted) return Promise.resolve({ aborted: true });
  return new Promise((resolve) => {
    let ended = false;
    let abortedFirst = false;
    // The first call settles the promise; later ones (a late result, the abort a timeout causes) do nothing.
    const finish = (result: AttemptResult) => {
      ended = true;
      clearTimeout(timer);
      resolve(result);
    };
    const settled = (outcome: TryOutcome) => {
      if (abortedFirst) onLate?.(outcome);
      finish(outcome);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, error: timeoutError(ms) });
      controller.abort(timeoutError(ms));
    }, ms);
    controller.signal.addEventListener("abort", () => {
      // An abort from outside, before the try ended (a timeout's own abort comes after it ended).
      if (!ended) abortedFirst = true;
      finish({ aborted: true });
    });
    run(controller.signal).then(settled, (error: unknown) =>
      settled({ ok: false, error: classifyFailure(error, undefined) }),
    );
  });
}

type EffectTable = "executions" | "forwards";

/** The tries in flight in one actor, by table and effect id, so redrive and restore can abort them. */
export function createInFlight() {
  const tries = new Map<string, { table: EffectTable; id: string; controller: AbortController }>();
  const keyOf = (table: EffectTable, id: string) => `${table}:${id}`;
  return {
    start(table: EffectTable, id: string, controller: AbortController): void {
      tries.set(keyOf(table, id), { table, id, controller });
    },
    /** Forget a try that ended, unless a newer try of the same effect replaced it. */
    finish(table: EffectTable, id: string, controller: AbortController): void {
      if (tries.get(keyOf(table, id))?.controller === controller) tries.delete(keyOf(table, id));
    },
    /** Abort one effect's try in flight. False when there is none. */
    abort(table: EffectTable, id: string, reason: unknown): boolean {
      const entry = tries.get(keyOf(table, id));
      if (entry === undefined) return false;
      tries.delete(keyOf(table, id));
      entry.controller.abort(reason);
      return true;
    },
    /** Restore: abort the tries of effects declared after `seq`. Returns how many. */
    abortAfter(seq: number, reason: unknown): number {
      const undone = [...tries.values()].filter((entry) => (parseEffectId(entry.id)?.seq ?? 0) > seq);
      for (const entry of undone) {
        tries.delete(keyOf(entry.table, entry.id));
        entry.controller.abort(reason);
      }
      return undone.length;
    },
  };
}

export type InFlight = ReturnType<typeof createInFlight>;
