/** Forward retries are configured per link, with the services' `retry` shape and defaults. */
import { DEFAULT_RETRY_POLICY, link, linkRetryPolicies, outboxFailedEvent } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";

const contract = { name: "room", def: {} };
const keep = <S>(s: S) => s;

describe("link retry", () => {
  it("link() keeps the retry option", () => {
    const retry = { attempts: 5, backoff: { baseMs: 10 } };
    expect(link(contract, { onUpdate: keep, retry }).retry).toBe(retry);
    expect(link(contract, { onUpdate: keep }).retry).toBeUndefined();
  });

  it("every declared link gets its policy, defaults filled in", () => {
    const policies = linkRetryPolicies({
      fast: { retry: { attempts: 2, backoff: { baseMs: 10, factor: 1, jitter: 0 } } },
      plain: {},
    });
    expect([...policies.entries()]).toEqual([
      ["fast", { attempts: 2, baseMs: 10, factor: 1, maxMs: DEFAULT_RETRY_POLICY.maxMs, jitter: 0 }],
      ["plain", DEFAULT_RETRY_POLICY],
    ]);
    expect(linkRetryPolicies(undefined).size).toBe(0);
  });

  it("refuses a bad retry option at definition time, naming the link", () => {
    expect(() => linkRetryPolicies({ room: { retry: { attempts: 0 } } })).toThrow(
      /^Invalid link "room" retry option: /,
    );
  });
});

describe("outboxFailedEvent", () => {
  it("is an execution unless told it is a forward", () => {
    const fields = { actorType: "a", actorId: "1", effectId: "2:0", service: "room", attempts: 3, error: "e" };
    expect(outboxFailedEvent(fields).kind).toBe("execution");
    expect(outboxFailedEvent({ ...fields, kind: "forward" })).toEqual({
      event: "actor_kit.outbox.failed",
      actorType: "a",
      actorId: "1",
      kind: "forward",
      service: "room",
      effectId: "2:0",
      attempts: 3,
      error: "e",
    });
  });
});

describe("resolveRetryPolicy", () => {
  it("names the service in its error", async () => {
    const { resolveRetryPolicy } = await import("@actor-kit/worker/testing");
    expect(() => resolveRetryPolicy({ attempts: 0 })).toThrow(/^Invalid service retry option: /);
  });
});
