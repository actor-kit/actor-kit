/**
 * Studio view reducer: live frames that arrive before the first snapshot change nothing, and
 * studio.timers replaces the pending timers.
 */
import { describe, expect, it } from "vitest";
import { initialStudioState, studioReducer } from "../../packages/studio/ui/src/studio-state";

const timer = { id: "1:0", name: "t", key: "k", payload: { n: 1 }, fireAt: 5, createdAt: 1 };
const entry = { id: 1, causeType: "init", cause: {}, state: { n: 1 }, checksum: "c", createdAt: 1 };

describe("studioReducer before the first snapshot", () => {
  it.each([
    { type: "studio.timers", timers: [timer] },
    { type: "studio.outbox", outbox: [] },
    { type: "studio.links", activeLinks: [], linkSubscribers: [] },
  ] as const)("$type leaves the state alone", (frame) => {
    expect(studioReducer(initialStudioState, { type: "frame", frame })).toBe(initialStudioState);
  });

  it("a timeline frame adds the entry but there is still nothing to inspect", () => {
    const next = studioReducer(initialStudioState, { type: "frame", frame: { type: "studio.timeline", entry } });
    expect(next.inspect).toBeNull();
    expect(next.timeline).toEqual([entry]);
  });
});

describe("studioReducer: timers", () => {
  const inspect = {
    state: {},
    version: 1,
    actorId: "a",
    connections: [],
    outbox: [],
    activeLinks: [],
    linkSubscribers: [],
  };
  const loaded = { ...initialStudioState, inspect };

  it("studio.timers replaces the timers", () => {
    const next = studioReducer(loaded, { type: "frame", frame: { type: "studio.timers", timers: [timer] } });
    expect(next.inspect?.timers).toEqual([timer]);
  });

  it("a snapshot carries its timers, and none when the actor sends none", () => {
    const snapshot = { type: "studio.snapshot", ...inspect, timeline: [], actorType: "t", actorId: "a" } as const;
    expect(studioReducer(loaded, { type: "frame", frame: { ...snapshot, timers: [timer] } }).inspect?.timers).toEqual([
      timer,
    ]);
    expect(studioReducer(loaded, { type: "frame", frame: snapshot }).inspect?.timers).toBeUndefined();
  });
});
