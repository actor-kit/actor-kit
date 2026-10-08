import {
  createChangeEntry,
  nextConnectionSeq,
  parseActorRoute,
  resolveRole,
  toLiveConnections,
} from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";

describe("parseActorRoute prefix and segment guards", () => {
  it("rejects a three-segment path without the api prefix", () => {
    expect(parseActorRoute("/foo/counter/1")).toBeNull();
  });

  it("rejects a path with only a type after api", () => {
    expect(parseActorRoute("/api/counter")).toBeNull();
  });

  it("rejects an empty path", () => {
    expect(parseActorRoute("/")).toBeNull();
  });

  it("parses the minimum valid path", () => {
    expect(parseActorRoute("/api/counter/a%20b")).toEqual({ actorType: "counter", actorId: "a b" });
  });
});

describe("resolveRole with a missing predicate", () => {
  it("skips a role whose predicate is undefined", () => {
    const role: unknown = Reflect.apply(resolveRole, undefined, [
      { ghost: undefined, member: () => true },
      {},
      "u-1",
      { callerType: "user" },
    ]);
    expect(role).toBe("member");
  });
});

describe("createChangeEntry counter", () => {
  it("increments the id counter by one per entry", () => {
    const params = { eventType: "E", caller: "c", role: "r", prevChecksum: "a", nextChecksum: "b" };
    const counterOf = (id: string) => Number(/^cdc-\d+-(-?\d+)$/.exec(id)?.[1]);
    const first = counterOf(createChangeEntry(params).id);
    const second = counterOf(createChangeEntry(params).id);
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(first + 1);
  });
});

describe("toLiveConnections", () => {
  it("excludes the studio socket even when it has a valid identity and attachment", () => {
    const sockets = [
      { tags: ["caller:__studio", "callerType:service"], attachment: { connectionId: "s", connectedAt: 1 } },
      { tags: ["caller:u-1", "callerType:user"], attachment: { connectionId: "c", connectedAt: 2 } },
    ];
    expect(toLiveConnections(sockets, { any: () => true }, {})).toEqual([
      { connectionId: "c", caller: "u-1", callerType: "user", connectedAt: 2, role: "any" },
    ]);
  });

  it("passes the caller type to role predicates", () => {
    const sockets = [
      { tags: ["caller:svc", "callerType:service"], attachment: { connectionId: "a", connectedAt: 1 } },
      { tags: ["caller:u-1", "callerType:user"], attachment: { connectionId: "b", connectedAt: 2 } },
    ];
    const roles = {
      service: (_s: unknown, _c: string, claims: { callerType: string }) => claims.callerType === "service",
    };
    expect(toLiveConnections(sockets, roles, {}).map((c) => c.role)).toEqual(["service", null]);
  });
});

describe("nextConnectionSeq", () => {
  it("is one past the highest seq regardless of socket order", () => {
    const sockets = [
      { tags: [], attachment: { connectionId: "a", connectedAt: 1, seq: 5 } },
      { tags: [], attachment: { connectionId: "b", connectedAt: 2, seq: 2 } },
      { tags: [], attachment: { connectionId: "c", connectedAt: 3 } },
      { tags: [], attachment: null },
    ];
    expect(nextConnectionSeq(sockets)).toBe(6);
  });

  it("is 1 when no socket carries a seq", () => {
    expect(nextConnectionSeq([{ tags: [], attachment: null }])).toBe(1);
  });
});
