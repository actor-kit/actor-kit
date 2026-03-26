import { parseActorRoute } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";

describe("parseActorRoute — kill survivors", () => {
  it("requires exactly /api prefix", () => {
    expect(parseActorRoute("/API/counter/123")).toBeNull();
    expect(parseActorRoute("/Api/counter/123")).toBeNull();
  });

  it("requires at least 3 path segments", () => {
    expect(parseActorRoute("/api")).toBeNull();
    expect(parseActorRoute("/api/counter")).toBeNull();
  });

  it("extracts actorType correctly", () => {
    const result = parseActorRoute("/api/todo-list/abc");
    expect(result?.actorType).toBe("todo-list");
  });

  it("extracts actorId correctly", () => {
    const result = parseActorRoute("/api/counter/my-counter-123");
    expect(result?.actorId).toBe("my-counter-123");
  });

  it("ignores trailing path segments", () => {
    const result = parseActorRoute("/api/counter/abc/ws/extra");
    expect(result?.actorType).toBe("counter");
    expect(result?.actorId).toBe("abc");
  });

  it("decodes special characters in actorId", () => {
    const result = parseActorRoute("/api/counter/hello%20world");
    expect(result?.actorId).toBe("hello world");
  });

  it("handles actorId with slashes encoded", () => {
    const result = parseActorRoute("/api/counter/a%2Fb");
    expect(result?.actorId).toBe("a/b");
  });

  it("returns null for root path", () => {
    expect(parseActorRoute("/")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseActorRoute("")).toBeNull();
  });

  it("first segment must be api", () => {
    expect(parseActorRoute("/notapi/counter/123")).toBeNull();
  });
});
