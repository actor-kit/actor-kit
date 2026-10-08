import { DEFAULT_RETRY_POLICY, resolveRetryPolicy, retryDelay, settleAttempt } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";

describe("resolveRetryPolicy", () => {
  it("defaults to ADR-003: 3 attempts, 1s then 5s, capped at 60s, ±20% jitter", () => {
    expect(resolveRetryPolicy(undefined)).toEqual({ attempts: 3, baseMs: 1000, factor: 5, maxMs: 60_000, jitter: 0.2 });
    expect(DEFAULT_RETRY_POLICY).toEqual(resolveRetryPolicy(undefined));
  });

  it("fills unset fields from the defaults", () => {
    expect(resolveRetryPolicy({ attempts: 1 })).toEqual({ ...DEFAULT_RETRY_POLICY, attempts: 1 });
    expect(resolveRetryPolicy({ backoff: { baseMs: 10, jitter: 0 } })).toEqual({
      ...DEFAULT_RETRY_POLICY,
      baseMs: 10,
      jitter: 0,
    });
    expect(resolveRetryPolicy({ attempts: 5, backoff: { factor: 2, maxMs: 500 } })).toEqual({
      ...DEFAULT_RETRY_POLICY,
      attempts: 5,
      factor: 2,
      maxMs: 500,
    });
  });

  it.each([
    [{ attempts: 0 }],
    [{ attempts: 1.5 }],
    [{ attempts: -1 }],
    [{ backoff: { baseMs: -1 } }],
    [{ backoff: { factor: 0.5 } }],
    [{ backoff: { maxMs: -5 } }],
    [{ backoff: { jitter: 1 } }],
    [{ backoff: { jitter: -0.1 } }],
  ])("rejects %j", (option) => {
    expect(() => resolveRetryPolicy(option)).toThrow(/retry/);
  });

  it("accepts the edges: baseMs 0, factor 1, jitter 0", () => {
    expect(resolveRetryPolicy({ backoff: { baseMs: 0, factor: 1, jitter: 0, maxMs: 0 } })).toMatchObject({
      baseMs: 0,
      factor: 1,
      jitter: 0,
      maxMs: 0,
    });
  });
});

describe("retryDelay", () => {
  const noJitter = { ...DEFAULT_RETRY_POLICY, jitter: 0 };

  it("grows by factor per failed attempt: 1s, 5s, 25s", () => {
    expect(retryDelay(1, noJitter, () => 0.5)).toBe(1000);
    expect(retryDelay(2, noJitter, () => 0.5)).toBe(5000);
    expect(retryDelay(3, noJitter, () => 0.5)).toBe(25_000);
  });

  it("caps at maxMs", () => {
    expect(retryDelay(4, noJitter, () => 0.5)).toBe(60_000);
    expect(retryDelay(3, { ...noJitter, maxMs: 25_000 }, () => 0.5)).toBe(25_000);
    expect(retryDelay(3, { ...noJitter, maxMs: 24_999 }, () => 0.5)).toBe(24_999);
  });

  it("spreads by ±jitter around the delay, rounded to whole ms", () => {
    const policy = { ...DEFAULT_RETRY_POLICY, jitter: 0.2 };
    expect(retryDelay(1, policy, () => 0)).toBe(800);
    expect(retryDelay(1, policy, () => 0.5)).toBe(1000);
    expect(retryDelay(1, policy, () => 0.75)).toBe(1100);
    expect(retryDelay(2, policy, () => 0.999)).toBe(5998);
  });

  it("never returns a negative delay", () => {
    expect(retryDelay(1, { ...DEFAULT_RETRY_POLICY, baseMs: 0 }, () => 0)).toBe(0);
  });
});

describe("settleAttempt", () => {
  const policy = { ...DEFAULT_RETRY_POLICY, jitter: 0 };

  it("a success is done whatever the attempt", () => {
    expect(settleAttempt({ ok: true }, 1, policy, 100, () => 0.5)).toEqual({ status: "done" });
    expect(settleAttempt({ ok: true }, 3, policy, 100, () => 0.5)).toEqual({ status: "done" });
  });

  it("a failure before the last attempt retries after the backoff", () => {
    expect(settleAttempt({ ok: false }, 1, policy, 100, () => 0.5)).toEqual({
      status: "retrying",
      nextAttemptAt: 1100,
    });
    expect(settleAttempt({ ok: false }, 2, policy, 100, () => 0.5)).toEqual({
      status: "retrying",
      nextAttemptAt: 5100,
    });
  });

  it("a failure on the last attempt fails for good", () => {
    expect(settleAttempt({ ok: false }, 3, policy, 100, () => 0.5)).toEqual({ status: "failed" });
    expect(settleAttempt({ ok: false }, 4, policy, 100, () => 0.5)).toEqual({ status: "failed" });
    expect(settleAttempt({ ok: false }, 1, { ...policy, attempts: 1 }, 100, () => 0.5)).toEqual({ status: "failed" });
  });
});
