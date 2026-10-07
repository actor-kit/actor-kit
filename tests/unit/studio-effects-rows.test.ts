import { toActiveLink, toLinkSubscriber, toOutboxEntry } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";

describe("toOutboxEntry", () => {
  it("maps an executions row to the wire shape", () => {
    expect(
      toOutboxEntry({ id: "e1", service: "JOB", payload: '{"a":1}', status: "pending", attempts: 0, created_at: 5 }),
    ).toEqual({ id: "e1", service: "JOB", payload: '{"a":1}', status: "pending", attempts: 0, createdAt: 5 });
  });

  it("rejects a row with a missing or mistyped column", () => {
    expect(() => toOutboxEntry({ id: "e1", service: "JOB", payload: "{}", status: "done", attempts: "0" })).toThrow();
  });
});

describe("toActiveLink", () => {
  it("maps an active_links row to the wire shape", () => {
    expect(toActiveLink({ target_type: "LOBBY", target_id: "l1", link_name: "lobby", version: 3 })).toEqual({
      targetType: "LOBBY",
      targetId: "l1",
      linkName: "lobby",
      version: 3,
    });
  });

  it("rejects a row with a mistyped column", () => {
    expect(() => toActiveLink({ target_type: "LOBBY", target_id: 1, link_name: "lobby", version: 3 })).toThrow();
  });
});

describe("toLinkSubscriber", () => {
  it("maps a link_subscribers row to the wire shape", () => {
    expect(toLinkSubscriber({ subscriber_type: "DESK", subscriber_id: "d1" })).toEqual({
      subscriberType: "DESK",
      subscriberId: "d1",
    });
  });

  it("rejects a row without a subscriber id", () => {
    expect(() => toLinkSubscriber({ subscriber_type: "DESK" })).toThrow();
  });
});
