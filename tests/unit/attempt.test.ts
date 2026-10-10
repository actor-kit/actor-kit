/**
 * Timeouts and cancellation (ADR-016 §3). Every try of a service or a forward runs under a time limit
 * (`timeoutMs`, default 30 000). When it runs out the try's AbortSignal is aborted and the try ends as
 * `{ _tag: "Timeout", ms }`. Redrive and restore abort tries in flight; a result that arrives after its
 * try was aborted is discarded, never applied.
 */

import { createInFlight, DEFAULT_TIMEOUT_MS, resolveTimeoutMs, runAttempt } from "@actor-kit/worker/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A try that settles when the test says so, and remembers its signal. */
function deferredTry() {
  let settle: (value: unknown) => void = () => {};
  let fail: (error: unknown) => void = () => {};
  let signal: AbortSignal | null = null;
  const run = (s: AbortSignal) => {
    signal = s;
    return new Promise<{ ok: true; result: unknown }>((resolve, reject) => {
      settle = (value) => resolve({ ok: true, result: value });
      fail = reject;
    });
  };
  return { run, settle: (v: unknown) => settle(v), fail: (e: unknown) => fail(e), signal: () => signal };
}

describe("resolveTimeoutMs", () => {
  it("defaults to 30 seconds", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
    expect(resolveTimeoutMs(undefined, "service")).toBe(30_000);
  });

  it("refuses a non-number even before checking it is finite", () => {
    expect(() => resolveTimeoutMs("5", "service")).toThrow("Invalid service timeoutMs");
  });

  it("takes a positive number of ms", () => {
    expect(resolveTimeoutMs(250, "service")).toBe(250);
    expect(resolveTimeoutMs(0.5, "service")).toBe(0.5);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, "30s", null])("refuses %s, naming the owner", (bad) => {
    expect(() => resolveTimeoutMs(bad, 'link "room"')).toThrow('Invalid link "room" timeoutMs');
  });
});

describe("runAttempt", () => {
  it("returns the try's outcome when it settles in time, and clears its timer", async () => {
    const t = deferredTry();
    const result = runAttempt(t.run, 1000, new AbortController());
    t.settle("receipt");
    expect(await result).toEqual({ ok: true, result: "receipt" });
    expect(vi.getTimerCount()).toBe(0);
    expect(t.signal()?.aborted).toBe(false);
  });

  it("times out: aborts the signal and ends as a Timeout; a late result is discarded", async () => {
    const t = deferredTry();
    const result = runAttempt(t.run, 1000, new AbortController());
    await vi.advanceTimersByTimeAsync(999);
    expect(t.signal()?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ ok: false, error: { _tag: "Timeout", ms: 1000 } });
    expect(t.signal()?.aborted).toBe(true);
    t.settle("late");
    expect(await result).toEqual({ ok: false, error: { _tag: "Timeout", ms: 1000 } });
  });

  it("a try that throws is a Defect", async () => {
    const t = deferredTry();
    const result = runAttempt(t.run, 1000, new AbortController());
    t.fail(new Error("boom"));
    expect(await result).toEqual({ ok: false, error: { _tag: "Defect", message: "boom" } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an abort from outside (redrive, restore) ends the try as aborted; its result is discarded", async () => {
    const t = deferredTry();
    const controller = new AbortController();
    const result = runAttempt(t.run, 1000, controller);
    controller.abort("restored");
    expect(await result).toEqual({ aborted: true });
    expect(vi.getTimerCount()).toBe(0);
    t.settle("late");
    expect(await result).toEqual({ aborted: true });
  });

  it("a controller aborted before the try starts never runs it", async () => {
    const controller = new AbortController();
    controller.abort("gone");
    const run = vi.fn(async () => ({ ok: true as const, result: 1 }));
    expect(await runAttempt(run, 1000, controller)).toEqual({ aborted: true });
    expect(run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("in-flight tries", () => {
  it("aborts a registered try by key, once, with the reason", () => {
    const inFlight = createInFlight();
    const controller = new AbortController();
    inFlight.start("executions", "3:0", controller);
    expect(inFlight.abort("executions", "3:0", "redriven")).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe("redriven");
    expect(inFlight.abort("executions", "3:0", "again")).toBe(false);
  });

  it("keys executions and forwards apart", () => {
    const inFlight = createInFlight();
    const execution = new AbortController();
    inFlight.start("executions", "3:0", execution);
    expect(inFlight.abort("forwards", "3:0", "x")).toBe(false);
    expect(execution.signal.aborted).toBe(false);
  });

  it("finish forgets a try, but only the one it was given", () => {
    const inFlight = createInFlight();
    const first = new AbortController();
    const second = new AbortController();
    inFlight.start("executions", "3:0", first);
    inFlight.start("executions", "3:0", second);
    inFlight.finish("executions", "3:0", first);
    expect(inFlight.abort("executions", "3:0", "x")).toBe(true);
    expect(second.signal.aborted).toBe(true);
    const done = new AbortController();
    inFlight.start("forwards", "4:0", done);
    inFlight.finish("forwards", "4:0", done);
    expect(inFlight.abort("forwards", "4:0", "x")).toBe(false);
    expect(done.signal.aborted).toBe(false);
  });

  it("aborts every try of effects declared after a seq (restore)", () => {
    const inFlight = createInFlight();
    const kept = new AbortController();
    const undoneExecution = new AbortController();
    const undoneForward = new AbortController();
    const unparsable = new AbortController();
    inFlight.start("executions", "4:0", kept);
    inFlight.start("executions", "5:0", undoneExecution);
    inFlight.start("forwards", "7:1", undoneForward);
    inFlight.start("executions", "outbox-legacy", unparsable);
    expect(inFlight.abortAfter(4, "restored")).toBe(2);
    expect([kept, undoneExecution, undoneForward, unparsable].map((c) => c.signal.aborted)).toEqual([
      false,
      true,
      true,
      false,
    ]);
    expect(inFlight.abortAfter(4, "restored")).toBe(0);
  });
});
