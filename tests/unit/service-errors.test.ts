/**
 * Typed, tagged service errors (ADR-016 §2).
 *
 * - `fail(error)` marks a declared failure; the runtime parses it against the service's `errors`
 *   (a `z.discriminatedUnion("_tag", ...)`). A value that doesn't parse, or anything else thrown, is a
 *   `{ _tag: "Defect", message }`. A try that runs out of time is `{ _tag: "Timeout", ms }`.
 * - Default retry rule: the built-ins (Timeout, Defect) are retried, declared errors are not.
 *   `retry.while(error)` overrides it.
 */

import {
  classifyFailure,
  DEFAULT_RETRY_POLICY,
  describeRecordedError,
  describeServiceError,
  fail,
  isBuiltInError,
  resolveRetryPolicy,
  resolveRetryRule,
  settleAttempt,
  settleTry,
  shouldRetry,
  timeoutError,
} from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const Errors = z.discriminatedUnion("_tag", [
  z.object({ _tag: z.literal("CardDeclined"), reason: z.string() }),
  z.object({ _tag: z.literal("RateLimited"), retryAfterMs: z.number() }),
]);

describe("fail()", () => {
  it("is an Error that carries the declared failure", () => {
    const failure = fail({ _tag: "CardDeclined", reason: "insufficient funds" });
    expect(failure).toBeInstanceOf(Error);
    expect(failure.error).toEqual({ _tag: "CardDeclined", reason: "insufficient funds" });
    expect(failure.message).toBe("CardDeclined");
    expect(failure.name).toBe("ServiceFailure");
  });
});

describe("classifyFailure", () => {
  it("a fail() that parses against `errors` is the parsed error", () => {
    expect(classifyFailure(fail({ _tag: "CardDeclined", reason: "stolen" }), Errors)).toEqual({
      _tag: "CardDeclined",
      reason: "stolen",
    });
  });

  it("parsing strips what the schema does not declare", () => {
    expect(classifyFailure(fail({ _tag: "RateLimited", retryAfterMs: 5, extra: 1 }), Errors)).toEqual({
      _tag: "RateLimited",
      retryAfterMs: 5,
    });
  });

  it("a fail() that does not parse is a Defect naming the tag and the problem", () => {
    const error = classifyFailure(fail({ _tag: "CardDeclined", reason: 7 }), Errors);
    expect(error._tag).toBe("Defect");
    expect(error).toEqual({ _tag: "Defect", message: expect.stringContaining('fail({ _tag: "CardDeclined" })') });
    expect(classifyFailure(fail({ _tag: "Unknown" }), Errors)).toEqual({
      _tag: "Defect",
      message: expect.stringContaining('fail({ _tag: "Unknown" }) does not match the service\'s errors'),
    });
  });

  it("a fail() from a service that declares no errors is a Defect", () => {
    expect(classifyFailure(fail({ _tag: "CardDeclined", reason: "x" }), undefined)).toEqual({
      _tag: "Defect",
      message: 'fail({ _tag: "CardDeclined" }): this service declares no errors',
    });
  });

  it("anything else thrown is a Defect with its message", () => {
    expect(classifyFailure(new Error("socket hang up"), Errors)).toEqual({ _tag: "Defect", message: "socket hang up" });
    expect(classifyFailure("plain string", undefined)).toEqual({ _tag: "Defect", message: "plain string" });
    expect(classifyFailure({ _tag: "CardDeclined", reason: "thrown raw" }, Errors)).toEqual({
      _tag: "Defect",
      message: "[object Object]",
    });
  });
});

describe("built-in errors", () => {
  it("Timeout and Defect are built in; declared tags are not", () => {
    expect(isBuiltInError(timeoutError(30_000))).toBe(true);
    expect(isBuiltInError({ _tag: "Defect", message: "x" })).toBe(true);
    expect(isBuiltInError({ _tag: "CardDeclined", reason: "x" })).toBe(false);
    expect(timeoutError(250)).toEqual({ _tag: "Timeout", ms: 250 });
  });

  it("describeServiceError: what the outbox's Last error shows", () => {
    expect(describeServiceError({ _tag: "Defect", message: "boom" })).toBe("boom");
    expect(describeServiceError(timeoutError(1500))).toBe("timed out after 1500ms");
    expect(describeServiceError({ _tag: "CardDeclined", reason: "stolen" })).toBe(
      '{"_tag":"CardDeclined","reason":"stolen"}',
    );
  });
});

describe("the default retry rule", () => {
  const rule = resolveRetryRule(undefined);

  it("retries the built-ins", () => {
    expect(rule({ _tag: "Defect", message: "x" })).toBe(true);
    expect(rule(timeoutError(10))).toBe(true);
  });

  it("does not retry a declared error: it is a domain answer", () => {
    expect(rule({ _tag: "CardDeclined", reason: "x" })).toBe(false);
    expect(resolveRetryRule({ attempts: 5 })({ _tag: "RateLimited" })).toBe(false);
  });
});

describe("retry.while", () => {
  it("overrides the default rule per error", () => {
    const seen: string[] = [];
    const rule = resolveRetryRule({
      attempts: 3,
      while: (error: { _tag: string }) => {
        seen.push(error._tag);
        return error._tag === "RateLimited";
      },
    });
    expect(rule({ _tag: "RateLimited", retryAfterMs: 1 })).toBe(true);
    expect(rule({ _tag: "Defect", message: "x" })).toBe(false);
    expect(seen).toEqual(["RateLimited", "Defect"]);
  });

  it("must be a function, and does not change the backoff policy", () => {
    expect(() => resolveRetryPolicy({ while: true })).toThrow("Invalid service retry option");
    expect(() => resolveRetryRule({ while: "RateLimited" })).toThrow("Invalid service retry option");
    expect(resolveRetryPolicy({ attempts: 2, while: () => true })).toEqual({ ...DEFAULT_RETRY_POLICY, attempts: 2 });
  });
});

describe("settleAttempt with a try that must not be retried", () => {
  const policy = { ...DEFAULT_RETRY_POLICY, attempts: 5, jitter: 0 };
  const random = () => 0.5;

  it("fails for good at once when the error is not retryable", () => {
    expect(settleAttempt({ ok: false, retryable: false }, 1, policy, 0, random)).toEqual({ status: "failed" });
  });

  it("retries when it is (or when nothing is said, as before)", () => {
    expect(settleAttempt({ ok: false, retryable: true }, 1, policy, 0, random)).toEqual({
      status: "retrying",
      nextAttemptAt: 1000,
    });
    expect(settleAttempt({ ok: false }, 1, policy, 0, random).status).toBe("retrying");
    expect(settleAttempt({ ok: false, retryable: true }, 5, policy, 0, random)).toEqual({ status: "failed" });
  });
});

describe("settleTry", () => {
  const retry = { policy: { ...DEFAULT_RETRY_POLICY, attempts: 3, jitter: 0 }, rule: resolveRetryRule(undefined) };
  const random = () => 0.5;

  it("a success is done with no error", () => {
    expect(settleTry({ ok: true, result: 1 }, 1, retry, 0, random)).toEqual({
      settlement: { status: "done" },
      lastError: null,
      lastErrorTag: null,
    });
  });

  it("a Defect is retried and stored with its tag", () => {
    expect(settleTry({ ok: false, error: { _tag: "Defect", message: "boom" } }, 1, retry, 0, random)).toEqual({
      settlement: { status: "retrying", nextAttemptAt: 1000 },
      lastError: "boom",
      lastErrorTag: "Defect",
    });
  });

  it("a declared error fails at once, stored as JSON with its tag", () => {
    expect(settleTry({ ok: false, error: { _tag: "CardDeclined", reason: "x" } }, 1, retry, 0, random)).toEqual({
      settlement: { status: "failed" },
      lastError: '{"_tag":"CardDeclined","reason":"x"}',
      lastErrorTag: "CardDeclined",
    });
  });

  it("a retry rule that throws does not retry", () => {
    const throwing = {
      ...retry,
      rule: () => {
        throw new Error("bad rule");
      },
    };
    expect(shouldRetry(throwing.rule, { _tag: "Defect" })).toBe(false);
    expect(
      settleTry({ ok: false, error: { _tag: "Defect", message: "x" } }, 1, throwing, 0, random).settlement,
    ).toEqual({
      status: "failed",
    });
  });

  it("a rule that returns something other than true does not retry", () => {
    expect(shouldRetry(() => true, { _tag: "X" })).toBe(true);
    expect(shouldRetry(() => false, { _tag: "X" })).toBe(false);
  });
});

describe("classifyFailure with an errors schema that is not tagged", () => {
  it("is a Defect: a parsed error must have a _tag", () => {
    const untagged = { safeParse: () => ({ success: true as const, data: 5 }) };
    expect(classifyFailure(fail({ _tag: "X" }), untagged)).toEqual({
      _tag: "Defect",
      message: `fail({ _tag: "X" }): the service's errors schema has no _tag`,
    });
  });
});

describe("describeRecordedError", () => {
  it("describes a journaled error: tagged like describeServiceError, else its message, else JSON", () => {
    expect(describeRecordedError({ _tag: "Defect", message: "boom" })).toBe("boom");
    expect(describeRecordedError({ _tag: "Timeout", ms: 5 })).toBe("timed out after 5ms");
    expect(describeRecordedError({ _tag: "CardDeclined", reason: "r" })).toBe('{"_tag":"CardDeclined","reason":"r"}');
    expect(describeRecordedError({ message: "old shape" })).toBe("old shape");
    expect(describeRecordedError({ code: 7 })).toBe('{"code":7}');
  });

  it("a Defect or Timeout without its field is shown as JSON", () => {
    expect(describeServiceError({ _tag: "Defect" })).toBe('{"_tag":"Defect"}');
    expect(describeServiceError({ _tag: "Timeout" })).toBe('{"_tag":"Timeout"}');
  });
});
