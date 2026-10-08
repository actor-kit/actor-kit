/**
 * Studio view state machine, cause summaries and frame parsing: the pure
 * logic behind the actor detail page.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { formatCauseSummary } from "../../packages/studio/ui/src/cause-summary";
import {
  formatIssues,
  type InspectResult,
  parseStudioFrame,
  type StudioFrame,
  type TimelineItem,
} from "../../packages/studio/ui/src/protocol";
import {
  initialStudioState,
  MAX_TIMELINE_ENTRIES,
  type StudioStatus,
  type StudioViewState,
  studioReducer,
} from "../../packages/studio/ui/src/studio-state";

function item(id: number, state: unknown = { n: id }): TimelineItem {
  return { id, causeType: "message", cause: {}, state, checksum: "c", createdAt: id };
}

function conn(connectionId: string, caller = "u1") {
  return { connectionId, caller, callerType: "user" as const, connectedAt: 1, role: "player" };
}

const inspect: InspectResult = {
  state: { n: 0 },
  version: 3,
  actorId: "a1",
  connections: [conn("s1")],
  outbox: [],
  activeLinks: [],
  linkSubscribers: [],
};

function stateWith(overrides: Partial<StudioViewState>): StudioViewState {
  return { ...initialStudioState, ...overrides };
}

function frame(f: StudioFrame): { type: "frame"; frame: StudioFrame } {
  return { type: "frame", frame: f };
}

describe("studioReducer: socket lifecycle", () => {
  it("starts connecting with nothing loaded", () => {
    expect(initialStudioState).toEqual({ inspect: null, timeline: [], status: "connecting", error: null });
  });

  it("reset returns the initial state", () => {
    expect(studioReducer(stateWith({ inspect, status: "live", error: "x" }), { type: "reset" })).toBe(
      initialStudioState,
    );
  });

  it("socket-open goes live and clears the error, keeping data", () => {
    const next = studioReducer(stateWith({ inspect, status: "reconnecting", error: "boom" }), { type: "socket-open" });
    expect(next).toEqual({ inspect, timeline: [], status: "live", error: null });
  });

  it.each<StudioStatus>(["connecting", "live", "reconnecting"])(
    "socket-closed while %s becomes reconnecting, keeping data and error",
    (status) => {
      const next = studioReducer(stateWith({ inspect, status, error: "e" }), { type: "socket-closed" });
      expect(next).toEqual({ inspect, timeline: [], status: "reconnecting", error: "e" });
    },
  );

  it.each<StudioStatus>(["error", "polling", "not-found"])("socket-closed while %s changes nothing", (status) => {
    const before = stateWith({ status, error: "e" });
    expect(studioReducer(before, { type: "socket-closed" })).toBe(before);
  });
});

describe("studioReducer: outcomes", () => {
  it("a malformed frame records a prefixed error and keeps everything else", () => {
    const before = stateWith({ inspect, status: "live" });
    expect(studioReducer(before, { type: "malformed-frame", error: "bad" })).toEqual({
      ...before,
      error: "Malformed studio frame: bad",
    });
  });

  it("an HTTP load replaces data, polls and clears the error", () => {
    const before = stateWith({ timeline: [item(9)], status: "reconnecting", error: "old" });
    expect(studioReducer(before, { type: "http-loaded", inspect, timeline: [item(1)] })).toEqual({
      inspect,
      timeline: [item(1)],
      status: "polling",
      error: null,
    });
  });

  it("an HTTP load caps the timeline", () => {
    const long = Array.from({ length: MAX_TIMELINE_ENTRIES + 3 }, (_, i) => item(i));
    const next = studioReducer(initialStudioState, { type: "http-loaded", inspect, timeline: long });
    expect(next.timeline).toHaveLength(MAX_TIMELINE_ENTRIES);
    expect(next.timeline.at(-1)?.id).toBe(MAX_TIMELINE_ENTRIES - 1);
  });

  it.each([
    ["permanent", "error"],
    ["not-found", "not-found"],
    ["transient", "reconnecting"],
  ] as const)("a %s request failure leaves status %s and shows the error", (failure, status) => {
    const before = stateWith({ inspect, status: "reconnecting" });
    expect(studioReducer(before, { type: "request-failed", error: "nope", failure })).toEqual({
      ...before,
      status,
      error: "nope",
    });
  });
});

describe("studioReducer: frames", () => {
  const snapshot = {
    type: "studio.snapshot",
    state: { n: 5 },
    version: 7,
    actorId: "a1",
    connections: [conn("s2")],
    outbox: [{ id: "o1", service: "charge", payload: "{}", status: "pending", attempts: 0, createdAt: 1 }],
    activeLinks: [{ targetType: "room", targetId: "r1", linkName: "room", version: 2 }],
    linkSubscribers: [{ subscriberType: "lobby", subscriberId: "l1" }],
    timeline: [item(2), item(1)],
    actorType: "counter",
  } satisfies StudioFrame;

  it("a snapshot replaces inspect and timeline, clears the error, keeps status", () => {
    const next = studioReducer(stateWith({ status: "live", error: "e", timeline: [item(99)] }), frame(snapshot));
    expect(next).toEqual({
      status: "live",
      error: null,
      timeline: [item(2), item(1)],
      inspect: {
        state: { n: 5 },
        version: 7,
        actorId: "a1",
        connections: snapshot.connections,
        outbox: snapshot.outbox,
        activeLinks: snapshot.activeLinks,
        linkSubscribers: snapshot.linkSubscribers,
      },
    });
  });

  it("a snapshot caps its timeline", () => {
    const timeline = Array.from({ length: MAX_TIMELINE_ENTRIES + 1 }, (_, i) => item(i));
    const next = studioReducer(initialStudioState, frame({ ...snapshot, timeline }));
    expect(next.timeline).toHaveLength(MAX_TIMELINE_ENTRIES);
  });

  it("a timeline entry is prepended and becomes the current state", () => {
    const before = stateWith({ inspect, timeline: [item(1)], error: "kept" });
    const next = studioReducer(before, frame({ type: "studio.timeline", entry: item(2, { n: 2 }) }));
    expect(next.timeline.map((e) => e.id)).toEqual([2, 1]);
    expect(next.inspect).toEqual({ ...inspect, state: { n: 2 } });
    expect(next.error).toBe("kept");
  });

  it("a timeline entry before any snapshot is kept without inventing inspect data", () => {
    const next = studioReducer(initialStudioState, frame({ type: "studio.timeline", entry: item(1) }));
    expect(next.timeline.map((e) => e.id)).toEqual([1]);
    expect(next.inspect).toBeNull();
  });

  it("a timeline entry already shown is ignored", () => {
    const before = stateWith({ inspect, timeline: [item(2), item(1)] });
    expect(studioReducer(before, frame({ type: "studio.timeline", entry: item(1, { n: 100 }) }))).toBe(before);
  });

  it("live timeline entries are capped, dropping the oldest", () => {
    const full = Array.from({ length: MAX_TIMELINE_ENTRIES }, (_, i) => item(MAX_TIMELINE_ENTRIES - i));
    const next = studioReducer(
      stateWith({ inspect, timeline: full }),
      frame({ type: "studio.timeline", entry: item(1000) }),
    );
    expect(next.timeline).toHaveLength(MAX_TIMELINE_ENTRIES);
    expect(next.timeline[0]?.id).toBe(1000);
    expect(next.timeline.at(-1)?.id).toBe(2);
  });

  it("a timeline of exactly the cap is kept whole", () => {
    const full = Array.from({ length: MAX_TIMELINE_ENTRIES }, (_, i) => item(i));
    expect(studioReducer(initialStudioState, frame({ ...snapshot, timeline: full })).timeline).toBe(full);
  });

  it("connect adds a row; reconnecting the same socket replaces it; disconnect removes only that socket", () => {
    let s = stateWith({ inspect });
    s = studioReducer(s, frame({ type: "studio.connection", action: "connect", connection: conn("s2", "u2") }));
    expect(s.inspect?.connections.map((c) => c.connectionId)).toEqual(["s1", "s2"]);
    s = studioReducer(
      s,
      frame({ type: "studio.connection", action: "connect", connection: { ...conn("s1"), role: "host" } }),
    );
    expect(s.inspect?.connections.map((c) => [c.connectionId, c.role])).toEqual([
      ["s2", "player"],
      ["s1", "host"],
    ]);
    s = studioReducer(
      s,
      frame({
        type: "studio.connection",
        action: "disconnect",
        connection: { connectionId: "s2", caller: "u2", callerType: "user" },
      }),
    );
    expect(s.inspect?.connections.map((c) => c.connectionId)).toEqual(["s1"]);
    expect(s.inspect?.state).toEqual(inspect.state);
  });

  it("outbox and links frames replace their lists", () => {
    const outbox = [{ id: "o1", service: "mail", payload: "{}", status: "done", attempts: 1, createdAt: 2 }];
    let s = studioReducer(stateWith({ inspect }), frame({ type: "studio.outbox", outbox }));
    expect(s.inspect).toEqual({ ...inspect, outbox });
    const activeLinks = [{ targetType: "room", targetId: "r", linkName: "l", version: 1 }];
    const linkSubscribers = [{ subscriberType: "lobby", subscriberId: "x" }];
    s = studioReducer(s, frame({ type: "studio.links", activeLinks, linkSubscribers }));
    expect(s.inspect).toEqual({ ...inspect, outbox, activeLinks, linkSubscribers });
  });

  it.each<StudioFrame>([
    { type: "studio.connection", action: "connect", connection: conn("s9") },
    { type: "studio.outbox", outbox: [] },
    { type: "studio.links", activeLinks: [], linkSubscribers: [] },
  ])("a $type frame before the snapshot changes nothing", (f) => {
    const before = stateWith({ status: "live" });
    expect(studioReducer(before, frame(f))).toBe(before);
  });
});

describe("formatCauseSummary", () => {
  it.each([
    ["message", { caller: "u1", messageType: "INC" }, "u1 sent INC"],
    ["lifecycle.connect", { caller: "u1", role: "host" }, "u1 connected (host)"],
    ["lifecycle.disconnect", { caller: "u1" }, "u1 disconnected"],
    ["service.onDone", { service: "mail" }, "mail completed"],
    ["service.onError", { service: "mail", error: "down" }, "mail failed: down"],
    ["link.onUpdate", { sourceType: "room", sourceId: "r1" }, "room:r1 updated"],
    ["link.onError", { sourceType: "room", sourceId: "r1", error: "gone" }, "room:r1 failed: gone"],
    ["link.onUnlink", { sourceType: "room", sourceId: "r1" }, "room:r1 unlinked"],
    ["init", { caller: "ignored" }, "Actor initialized"],
    ["migrate", { fromVersion: 1, toVersion: 2 }, "Migrated from v1 to v2"],
  ])("%s reads naturally", (causeType, cause, text) => {
    expect(formatCauseSummary(causeType, cause)).toBe(text);
  });

  it("shows numbers and booleans as text and anything else as unknown", () => {
    expect(formatCauseSummary("message", { caller: true, messageType: 0 })).toBe("true sent 0");
    expect(formatCauseSummary("message", { caller: false, messageType: { x: 1 } })).toBe("false sent unknown");
    expect(formatCauseSummary("message", { caller: null })).toBe("unknown sent unknown");
  });

  it("names unknown cause types, including ones that look like object properties", () => {
    expect(formatCauseSummary("custom.thing", {})).toBe("custom.thing");
    expect(formatCauseSummary("constructor", {})).toBe("constructor");
    expect(formatCauseSummary("toString", {})).toBe("toString");
  });
});

describe("parseStudioFrame", () => {
  const entryWire = {
    id: 1,
    causeType: "message",
    causeData: JSON.stringify({ caller: "u1" }),
    stateSnapshot: JSON.stringify({ n: 1 }),
    checksum: "c",
    createdAt: 5,
  };

  it("rejects a binary frame", () => {
    expect(parseStudioFrame(new ArrayBuffer(2))).toEqual({ kind: "malformed", error: "Expected a text frame" });
  });

  it("rejects text that is not JSON", () => {
    expect(parseStudioFrame("{nope")).toEqual({ kind: "malformed", error: "Frame is not valid JSON" });
  });

  it("rejects JSON without a string type", () => {
    expect(parseStudioFrame(JSON.stringify({ kind: "x" }))).toEqual({ kind: "malformed", error: "Frame has no type" });
    expect(parseStudioFrame(JSON.stringify({ type: 3 }))).toEqual({ kind: "malformed", error: "Frame has no type" });
  });

  it("ignores frame types the UI does not render", () => {
    expect(parseStudioFrame(JSON.stringify({ type: "studio.view", view: {} }))).toEqual({
      kind: "ignored",
      type: "studio.view",
    });
  });

  it("parses a timeline frame into a domain entry with parsed cause and state", () => {
    expect(parseStudioFrame(JSON.stringify({ type: "studio.timeline", entry: entryWire }))).toEqual({
      kind: "frame",
      frame: {
        type: "studio.timeline",
        entry: { id: 1, causeType: "message", cause: { caller: "u1" }, state: { n: 1 }, checksum: "c", createdAt: 5 },
      },
    });
  });

  it("names the frame type and the failing path when a known frame is invalid", () => {
    const bad = { type: "studio.timeline", entry: { ...entryWire, stateSnapshot: "{" } };
    expect(parseStudioFrame(JSON.stringify(bad))).toEqual({
      kind: "malformed",
      error: "Invalid studio.timeline frame: entry.stateSnapshot: Invalid JSON text",
    });
  });

  it("requires cause data to be a JSON object", () => {
    const bad = { type: "studio.timeline", entry: { ...entryWire, causeData: "[1]" } };
    const parsed = parseStudioFrame(JSON.stringify(bad));
    expect(parsed.kind).toBe("malformed");
  });

  it("parses connect frames with the full connection and disconnect frames with its identity", () => {
    const connection = conn("s1");
    expect(parseStudioFrame(JSON.stringify({ type: "studio.connection", action: "connect", connection }))).toEqual({
      kind: "frame",
      frame: { type: "studio.connection", action: "connect", connection },
    });
    const disconnect = { type: "studio.connection", action: "disconnect", connection };
    expect(parseStudioFrame(JSON.stringify(disconnect))).toEqual({
      kind: "frame",
      frame: {
        type: "studio.connection",
        action: "disconnect",
        connection: { connectionId: "s1", caller: "u1", callerType: "user" },
      },
    });
  });

  it("rejects a connection with an empty id or an unknown caller type", () => {
    const empty = { type: "studio.connection", action: "connect", connection: conn("") };
    expect(parseStudioFrame(JSON.stringify(empty)).kind).toBe("malformed");
    const robot = { type: "studio.connection", action: "connect", connection: { ...conn("s1"), callerType: "robot" } };
    expect(parseStudioFrame(JSON.stringify(robot)).kind).toBe("malformed");
    const noAction = { type: "studio.connection", connection: conn("s1") };
    expect(parseStudioFrame(JSON.stringify(noAction)).kind).toBe("malformed");
  });

  it("parses outbox and links frames", () => {
    const outbox = [{ id: "o", service: "s", payload: "{}", status: "done", attempts: 1, createdAt: 1 }];
    expect(parseStudioFrame(JSON.stringify({ type: "studio.outbox", outbox }))).toEqual({
      kind: "frame",
      frame: { type: "studio.outbox", outbox },
    });
    const links = {
      type: "studio.links",
      activeLinks: [{ targetType: "t", targetId: "i", linkName: "n", version: 1 }],
      linkSubscribers: [{ subscriberType: "t", subscriberId: "i" }],
    };
    expect(parseStudioFrame(JSON.stringify(links))).toEqual({ kind: "frame", frame: links });
  });
});

describe("formatIssues", () => {
  it("prefixes the first issue with its path", () => {
    const result = z.object({ a: z.object({ b: z.string() }) }).safeParse({ a: { b: 1 } });
    expect(result.success).toBe(false);
    if (!result.success) expect(formatIssues(result.error)).toMatch(/^a\.b: /);
  });

  it("uses the bare message for a root-level issue", () => {
    const result = z.string().safeParse(1);
    if (result.success) throw new Error("expected failure");
    expect(formatIssues(result.error)).toBe(result.error.issues[0]?.message);
    expect(formatIssues(result.error)).not.toMatch(/^: /);
  });

  it("falls back to a generic text when there are no issues", () => {
    expect(formatIssues(new z.ZodError([]))).toBe("invalid data");
  });
});
