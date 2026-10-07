import {
  handleStudioFrame,
  parseTimelineOptions,
  resolveTimelineSize,
  toTimelineEntry,
} from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";

type State = { owner: string; count: number };
const state: State = { owner: "alice", count: 3 };
const source = {
  state,
  roles: {
    admin: (_s: State, _c: string, { callerType }: { callerType: "user" | "service" }) => callerType === "service",
    owner: (s: State, caller: string) => caller === s.owner,
  },
  views: {
    admin: { kind: "shared" as const, fn: (s: State) => ({ count: s.count }) },
    owner: { kind: "perCaller" as const, fn: (s: State, caller: string) => ({ count: s.count, viewer: caller }) },
    legacy: { fn: (_s: State, caller: string) => ({ viewer: caller }) },
    broken: {
      kind: "shared" as const,
      fn: (): never => {
        throw new Error("nope");
      },
    },
  },
};

const frame = (value: unknown) => handleStudioFrame(JSON.stringify(value), source);

describe("resolveTimelineSize", () => {
  it("defaults to 500", () => {
    expect(resolveTimelineSize(undefined)).toBe(500);
  });

  it("accepts positive integers", () => {
    expect(resolveTimelineSize(1)).toBe(1);
    expect(resolveTimelineSize(1000)).toBe(1000);
  });

  it.each([0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects %s", (size) => {
    expect(() => resolveTimelineSize(size)).toThrow(/timelineSize must be a positive integer/);
  });
});

describe("parseTimelineOptions", () => {
  it("defaults limit to 50 with no cursor", () => {
    expect(parseTimelineOptions(undefined)).toEqual({ limit: 50, before: undefined });
    expect(parseTimelineOptions({})).toEqual({ limit: 50, before: undefined });
  });

  it("passes valid limit and before through", () => {
    expect(parseTimelineOptions({ limit: 3, before: 10 })).toEqual({ limit: 3, before: 10 });
  });

  it.each([
    { limit: 0 },
    { limit: -1 },
    { limit: 1.5 },
    { limit: Number.NaN },
    { limit: "5" },
    { before: 0 },
    { before: -3 },
    { before: Number.NaN },
    { before: "abc" },
    "limit=5",
    null,
  ])("rejects %j", (opts) => {
    expect(() => parseTimelineOptions(opts)).toThrow(/^Invalid timeline options/);
  });
});

describe("toTimelineEntry", () => {
  it("maps a timeline row to the wire shape", () => {
    expect(
      toTimelineEntry({
        id: 7,
        cause_type: "message",
        cause_data: "{}",
        state_snapshot: '{"a":1}',
        checksum: "abc",
        created_at: 99,
      }),
    ).toEqual({
      id: 7,
      causeType: "message",
      causeData: "{}",
      stateSnapshot: '{"a":1}',
      checksum: "abc",
      createdAt: 99,
    });
  });

  it("rejects malformed rows", () => {
    expect(() => toTimelineEntry({ id: "7", cause_type: "message" })).toThrow();
  });
});

describe("handleStudioFrame", () => {
  it("computes a shared view without a caller", () => {
    expect(frame({ type: "studio.requestView", role: "admin" })).toEqual({
      type: "studio.view",
      role: "admin",
      caller: null,
      callerRole: null,
      data: { count: 3 },
    });
  });

  it("computes a perCaller view and reports the caller's actual role", () => {
    expect(frame({ type: "studio.requestView", role: "owner", caller: "alice" })).toEqual({
      type: "studio.view",
      role: "owner",
      caller: "alice",
      callerRole: "owner",
      data: { count: 3, viewer: "alice" },
    });
  });

  it("reports callerRole null when the caller holds no role", () => {
    expect(frame({ type: "studio.requestView", role: "owner", caller: "mallory" })).toMatchObject({
      callerRole: null,
      data: { viewer: "mallory" },
    });
  });

  it("uses callerType when resolving the caller's role", () => {
    expect(frame({ type: "studio.requestView", role: "admin", caller: "svc", callerType: "service" })).toMatchObject({
      callerRole: "admin",
    });
  });

  it.each(["owner", "legacy"])("requires a caller for perCaller view %s", (role) => {
    expect(frame({ type: "studio.requestView", role })).toEqual({
      type: "studio.view",
      role,
      caller: null,
      error: `View for role "${role}" is perCaller: caller is required`,
    });
  });

  it.each(["ghost", "__proto__", "constructor", "toString", "hasOwnProperty"])("unknown role %s", (role) => {
    expect(frame({ type: "studio.requestView", role })).toEqual({
      type: "studio.view",
      role,
      caller: null,
      error: `No view for role "${role}"`,
    });
  });

  it("reports a throwing projection", () => {
    expect(frame({ type: "studio.requestView", role: "broken" })).toEqual({
      type: "studio.view",
      role: "broken",
      caller: null,
      error: "View projection threw: nope",
    });
  });

  it("rejects invalid JSON", () => {
    expect(handleStudioFrame("{nope", source)).toEqual({ type: "studio.error", error: "Invalid JSON in studio frame" });
  });

  it.each([[null], [[]], ["str"], [{ role: "admin" }], [{ type: 5 }]])("rejects untyped frame %j", (value) => {
    expect(frame(value)).toEqual({
      type: "studio.error",
      error: "Studio frames must be JSON objects with a string 'type'",
    });
  });

  it("refuses app messages", () => {
    expect(frame({ type: "INCREMENT", amount: 1 })).toEqual({
      type: "studio.error",
      error: 'Unsupported studio frame "INCREMENT": studio connections cannot send app messages',
    });
  });

  it.each([
    { type: "studio.requestView" },
    { type: "studio.requestView", role: 7 },
    { type: "studio.requestView", role: "admin", caller: 7 },
    { type: "studio.requestView", role: "admin", caller: "x", callerType: "robot" },
  ])("rejects malformed requestView %j", (value) => {
    const reply = frame(value);
    expect(reply.type).toBe("studio.error");
    expect("error" in reply && reply.error.startsWith("Invalid studio.requestView:")).toBe(true);
  });
});
