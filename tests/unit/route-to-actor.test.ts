import { parseActorRoute } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";

describe("parseActorRoute()", () => {
  it("parses /api/:actorType/:actorId", () => {
    const result = parseActorRoute("/api/counter/my-counter");
    expect(result).toEqual({ actorType: "counter", actorId: "my-counter" });
  });

  it("parses /api/:actorType/:actorId with trailing path", () => {
    const result = parseActorRoute("/api/zone/forest-north/ws");
    expect(result).toEqual({ actorType: "zone", actorId: "forest-north" });
  });

  it("returns null for non-matching paths", () => {
    expect(parseActorRoute("/health")).toBeNull();
    expect(parseActorRoute("/api")).toBeNull();
    expect(parseActorRoute("/api/counter")).toBeNull();
    expect(parseActorRoute("")).toBeNull();
  });

  it("handles URL-encoded actor IDs", () => {
    const result = parseActorRoute("/api/todo-list/my%20list");
    expect(result).toEqual({ actorType: "todo-list", actorId: "my list" });
  });
});
