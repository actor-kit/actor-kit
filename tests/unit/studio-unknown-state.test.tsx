/**
 * @vitest-environment jsdom
 *
 * One history (ADR-017 §5): a timeline entry's after-state is rebuilt from the journal, and is null
 * when it cannot be. The UI says so instead of showing a state, never diffs against it, and a live
 * entry without a state leaves the State panel as it was. The CLI's shape reports no changed paths.
 */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimelineEntrySchema } from "../../packages/studio/ui/src/protocol";
import { studioReducer } from "../../packages/studio/ui/src/studio-state";
import { TimelineEntrySchema as CliEntrySchema } from "../../packages/studio-cli/src/client";
import { timelineShape } from "../../packages/studio-cli/src/shape";
import { FakeWebSocket, installFakes, renderAt, snapshotFrame, timelineEntry } from "./studio-ui-pages.helpers";

const unknownState = (id: number) => ({ ...timelineEntry(id, {}), stateSnapshot: null });

describe("protocol: an entry without a state", () => {
  it("parses as stateUnavailable; a JSON null state is a known state", () => {
    const missing = TimelineEntrySchema.parse(unknownState(3));
    expect(missing).toMatchObject({ id: 3, stateUnavailable: true, state: null });
    const nullState = TimelineEntrySchema.parse({ ...timelineEntry(4, null) });
    expect(nullState.state).toBeNull();
    expect("stateUnavailable" in nullState).toBe(false);
    const known = TimelineEntrySchema.parse(timelineEntry(5, { n: 1 }));
    expect(known.state).toEqual({ n: 1 });
    expect("stateUnavailable" in known).toBe(false);
  });

  it("still names a stateSnapshot that is not JSON", () => {
    expect(TimelineEntrySchema.safeParse({ ...timelineEntry(1, {}), stateSnapshot: "{" }).error?.issues[0]?.message).toBe(
      "Invalid JSON text",
    );
  });
});

describe("studioReducer: a live entry without a state", () => {
  it("is listed but keeps the inspected state", () => {
    const inspect = { state: { n: 1 }, version: 1, actorId: "a", connections: [], outbox: [], activeLinks: [], linkSubscribers: [] };
    const start = { inspect, timeline: [], status: "live" as const, error: null };
    const next = studioReducer(start, {
      type: "frame",
      frame: { type: "studio.timeline", entry: TimelineEntrySchema.parse(unknownState(9)) },
    });
    expect(next.timeline.map((e) => e.id)).toEqual([9]);
    expect(next.inspect?.state).toEqual({ n: 1 });
    const known = studioReducer(next, {
      type: "frame",
      frame: { type: "studio.timeline", entry: TimelineEntrySchema.parse(timelineEntry(10, { n: 2 })) },
    });
    expect(known.inspect?.state).toEqual({ n: 2 });
  });
});

describe("timeline panel: an entry without a state", () => {
  beforeEach(() => {
    installFakes((url) => {
      if (url.pathname === "/__studio/api/actors") return Response.json({ actors: [] });
      if (url.pathname === "/__studio/api/actors/types") return Response.json({ types: [] });
      throw new TypeError("Failed to fetch");
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  async function open(entries: Array<ReturnType<typeof timelineEntry> | ReturnType<typeof unknownState>>) {
    renderAt("/actors/counter/a1");
    await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
    const ws = FakeWebSocket.latest();
    act(() => {
      ws.serverOpen();
      ws.serverSend({ ...snapshotFrame({ count: 2 }, []), timeline: entries });
    });
    fireEvent.click(screen.getByTestId("tab-timeline"));
  }

  it("says the state is not available and shows no diff", async () => {
    await open([timelineEntry(3, { count: 2 }), unknownState(2), timelineEntry(1, { count: 0 })]);
    fireEvent.click(screen.getByTestId("timeline-entry-2"));
    expect(screen.getByText(/not available/)).toBeTruthy();
    expect(screen.queryByText("Changes:")).toBeNull();
    fireEvent.click(screen.getByTestId("timeline-entry-3"));
    expect(screen.queryByText("Changes:")).toBeNull();
  });

  it("diffs entries whose states are both known", async () => {
    await open([timelineEntry(2, { count: 2 }), timelineEntry(1, { count: 0 })]);
    fireEvent.click(screen.getByTestId("timeline-entry-2"));
    expect(screen.getByText("Changes:")).toBeTruthy();
    expect(screen.queryByText(/not available/)).toBeNull();
  });
});

describe("studio-cli: an entry without a state", () => {
  it("parses, and has no changed paths (nor does the entry after it)", () => {
    const entries = [timelineEntry(1, { a: 1 }), unknownState(2), timelineEntry(3, { a: 2 })];
    for (const e of entries) expect(CliEntrySchema.parse(e).stateSnapshot).toBe(e.stateSnapshot);
    expect(timelineShape(entries.map((e) => CliEntrySchema.parse(e))).map((e) => e.changedPaths)).toEqual([[], [], []]);
  });
});

describe("studio projection: an entry without a state", () => {
  it("stays null under redaction", async () => {
    const { projectTimelineEntry } = await import("../../packages/worker/src/runtime/studio-project");
    const { compileRedaction } = await import("../../packages/worker/src/runtime/studio-redact");
    const entry = { id: 1, seq: 1, causeType: "init", causeData: "{}", stateSnapshot: null, checksum: "c", createdAt: 1 };
    const out = await projectTimelineEntry(entry, { redactor: compileRedaction(["name"]), hashCaller: null });
    expect(out.stateSnapshot).toBeNull();
  });
});
