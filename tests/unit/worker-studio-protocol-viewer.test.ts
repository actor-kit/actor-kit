import { describe, expect, it } from "vitest";
import {
  parseInspectOptions,
  parseViewOptions,
  STUDIO_VIEWER_HEADER,
  viewerFromHeader,
  viewerFromTags,
  viewerTags,
} from "../../packages/worker/src/runtime/studio-protocol";

function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof Error) return error.message;
    return `non-Error thrown: ${String(error)}`;
  }
  return "did not throw";
}

describe("studio viewer header and tags", () => {
  it("names the header the middleware stamps", () => {
    expect(STUDIO_VIEWER_HEADER).toBe("X-Actor-Kit-Studio-Viewer");
  });

  it("reads 'agent' from the header and everything else as human", () => {
    expect(viewerFromHeader("agent")).toBe("agent");
    expect(viewerFromHeader("human")).toBe("human");
    expect(viewerFromHeader("Agent")).toBe("human");
    expect(viewerFromHeader("")).toBe("human");
    expect(viewerFromHeader(null)).toBe("human");
  });

  it("tags agent sockets with one exact tag and humans with none", () => {
    expect(viewerTags("agent")).toEqual(["studioViewer:agent"]);
    expect(viewerTags("human")).toEqual([]);
  });

  it("reads the viewer back from the socket tags", () => {
    expect(viewerFromTags(["studioViewer:agent"])).toBe("agent");
    expect(viewerFromTags(["studio", "studioViewer:agent"])).toBe("agent");
    expect(viewerFromTags(viewerTags("agent"))).toBe("agent");
    expect(viewerFromTags([])).toBe("human");
    expect(viewerFromTags(["studio", ""])).toBe("human");
    expect(viewerFromTags(viewerTags("human"))).toBe("human");
  });
});

describe("parseInspectOptions", () => {
  it("defaults to human when options are absent or omit the viewer", () => {
    expect(parseInspectOptions(undefined)).toEqual({ viewer: "human" });
    expect(parseInspectOptions({})).toEqual({ viewer: "human" });
  });

  it("keeps an explicit viewer", () => {
    expect(parseInspectOptions({ viewer: "agent" })).toEqual({ viewer: "agent" });
    expect(parseInspectOptions({ viewer: "human" })).toEqual({ viewer: "human" });
  });

  it("rejects an unknown viewer, an unknown key and a non-object", () => {
    expect(thrownMessage(() => parseInspectOptions({ viewer: "robot" }))).toMatch(
      /^Invalid inspect options: .*viewer/s,
    );
    expect(thrownMessage(() => parseInspectOptions({ viewer: "" }))).toMatch(/^Invalid inspect options: .*viewer/s);
    expect(thrownMessage(() => parseInspectOptions({ extra: 1 }))).toMatch(/^Invalid inspect options: .*extra/s);
    expect(thrownMessage(() => parseInspectOptions("agent"))).toMatch(/^Invalid inspect options: .+/s);
  });
});

describe("parseViewOptions", () => {
  it("returns every field and defaults the viewer to human", () => {
    expect(parseViewOptions({ role: "admin" })).toEqual({ role: "admin", viewer: "human" });
    expect(parseViewOptions({ role: "o", caller: "b" })).toEqual({ role: "o", caller: "b", viewer: "human" });
  });

  it("keeps caller, callerType and viewer", () => {
    expect(parseViewOptions({ role: "admin", caller: "bob", callerType: "service", viewer: "agent" })).toEqual({
      role: "admin",
      caller: "bob",
      callerType: "service",
      viewer: "agent",
    });
    expect(parseViewOptions({ role: "owner", caller: "alice", callerType: "user", viewer: "human" })).toEqual({
      role: "owner",
      caller: "alice",
      callerType: "user",
      viewer: "human",
    });
  });

  it("rejects missing or empty role, empty caller, bad callerType and bad viewer", () => {
    expect(thrownMessage(() => parseViewOptions(undefined))).toMatch(/^Invalid view options: .+/s);
    expect(thrownMessage(() => parseViewOptions({}))).toMatch(/^Invalid view options: .*role/s);
    expect(thrownMessage(() => parseViewOptions({ role: "" }))).toMatch(/^Invalid view options: .*role/s);
    expect(thrownMessage(() => parseViewOptions({ role: "a", caller: "" }))).toMatch(
      /^Invalid view options: .*caller/s,
    );
    expect(thrownMessage(() => parseViewOptions({ role: "a", callerType: "" }))).toMatch(
      /^Invalid view options: .*callerType/s,
    );
    expect(thrownMessage(() => parseViewOptions({ role: "a", callerType: "robot" }))).toMatch(
      /^Invalid view options: .*callerType/s,
    );
    expect(thrownMessage(() => parseViewOptions({ role: "a", viewer: "robot" }))).toMatch(
      /^Invalid view options: .*viewer/s,
    );
  });
});
