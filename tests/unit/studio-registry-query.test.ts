import { describe, expect, it } from "vitest";
// Import directly: registry.ts pulls in cloudflare:workers.
import {
  buildListQuery,
  ConnectionArgs,
  DEFAULT_LIST_LIMIT,
  escapeLike,
  TouchArgs,
} from "../../packages/studio/src/registry-query";

describe("escapeLike", () => {
  it("escapes %, _ and the escape character itself", () => {
    expect(escapeLike("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
  });

  it("leaves quotes and other text untouched (they are bound parameters)", () => {
    expect(escapeLike('delta\'s "room" -- ;')).toBe('delta\'s "room" -- ;');
  });
});

describe("buildListQuery", () => {
  it("defaults to limit 50, offset 0, no filters", () => {
    const q = buildListQuery({});
    expect(q.params).toEqual([DEFAULT_LIST_LIMIT, 0]);
    expect(q.sql).not.toContain("WHERE");
  });

  it("filters by exact type and escaped search, in that order", () => {
    const q = buildListQuery({ type: "chat", search: "50%_off", limit: 10, offset: 20 });
    expect(q.sql).toContain("WHERE actor_type = ? AND actor_id LIKE ? ESCAPE '\\'");
    expect(q.params).toEqual(["chat", "%50\\%\\_off%", 10, 20]);
  });

  it("orders by recency with a deterministic tiebreaker", () => {
    expect(buildListQuery({}).sql).toContain("ORDER BY last_active_at DESC, actor_type ASC, actor_id ASC");
  });

  it("accepts limit 0 and huge limits", () => {
    expect(buildListQuery({ limit: 0 }).params).toEqual([0, 0]);
    expect(buildListQuery({ limit: Number.MAX_SAFE_INTEGER }).params).toEqual([Number.MAX_SAFE_INTEGER, 0]);
  });

  it.each([
    { limit: -1 },
    { limit: 1.5 },
    { limit: Number.NaN },
    { limit: Number.POSITIVE_INFINITY },
    { offset: -1 },
    { offset: 0.5 },
    { offset: Number.NaN },
    { type: 1 },
    { search: null },
    null,
  ])("rejects invalid options %j instead of passing them to SQLite", (opts) => {
    expect(() => buildListQuery(opts)).toThrow();
  });
});

describe("registry write arguments", () => {
  it("touch requires non-empty type and id and an integer version", () => {
    expect(TouchArgs.safeParse({ actorType: "counter", actorId: "a", version: 1 }).success).toBe(true);
    expect(TouchArgs.safeParse({ actorType: "", actorId: "a", version: 1 }).success).toBe(false);
    expect(TouchArgs.safeParse({ actorType: "counter", actorId: "", version: 1 }).success).toBe(false);
    expect(TouchArgs.safeParse({ actorType: "counter", actorId: "a", version: 1.5 }).success).toBe(false);
    expect(TouchArgs.safeParse({ actorType: "counter", actorId: "a", version: 1, previousActorId: "" }).success).toBe(
      false,
    );
  });

  it("connection counts must be non-negative integers", () => {
    const base = { actorType: "counter", actorId: "a" };
    expect(ConnectionArgs.safeParse({ ...base, count: 0 }).success).toBe(true);
    expect(ConnectionArgs.safeParse({ ...base, count: 3 }).success).toBe(true);
    expect(ConnectionArgs.safeParse({ ...base, count: -1 }).success).toBe(false);
    expect(ConnectionArgs.safeParse({ ...base, count: 1.5 }).success).toBe(false);
    expect(ConnectionArgs.safeParse({ ...base, count: Number.NaN }).success).toBe(false);
  });
});
