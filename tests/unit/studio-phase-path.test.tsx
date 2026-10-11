/**
 * @vitest-environment jsdom
 *
 * Studio shows a nested state's path (ADR-019 A): the State panel names the active path, and the
 * timeline marks phase changes with the dotted path. Entries in the 0.2 flat shape still read.
 */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { phaseChange, phasePath } from "../../packages/studio/ui/src/phase-change";
import { TimelineEntrySchema } from "../../packages/studio/ui/src/protocol";
import { FakeWebSocket, installFakes, renderAt, snapshotFrame, timelineEntry } from "./studio-ui-pages.helpers";

const nested = (phase: string[]) => ({
  shared: {},
  phase,
  locals: phase.map(() => null),
  stateTimers: phase.map(() => []),
});

describe("phasePath", () => {
  it("is the dotted path of a nested state, or the 0.2 flat phase", () => {
    expect(phasePath(nested(["playing", "window"]))).toBe("playing.window");
    expect(phasePath(nested(["lobby"]))).toBe("lobby");
    expect(phasePath({ shared: {}, phase: "round", local: null, stateTimers: [] })).toBe("round");
  });

  it("is null for a state without a phase, or a phase that is not a path", () => {
    expect(phasePath({ count: 1 })).toBeNull();
    expect(phasePath(null)).toBeNull();
    expect(phasePath(5)).toBeNull();
    expect(phasePath({ phase: 7 })).toBeNull();
    expect(phasePath({ phase: [] })).toBeNull();
    expect(phasePath({ phase: ["a", 2] })).toBeNull();
  });

  it("marks a timeline entry whose path differs from the previous one", () => {
    const at = (id: number, state: unknown) => TimelineEntrySchema.parse(timelineEntry(id, state));
    const window = at(2, nested(["playing", "window"]));
    const acting = at(3, nested(["playing", "acting"]));
    expect(phaseChange(acting, window)).toBe("playing.acting");
    expect(phaseChange(window, at(1, nested(["playing", "window"])))).toBeNull();
  });
});

describe("State panel", () => {
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

  async function open(state: unknown) {
    renderAt("/actors/rounds/r1");
    await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
    const ws = FakeWebSocket.latest();
    act(() => {
      ws.serverOpen();
      ws.serverSend(snapshotFrame(state, [timelineEntry(1, state, "init", {})]));
    });
  }

  it("names the active path of an actor with states", async () => {
    await open(nested(["playing", "window"]));
    expect(screen.getByTestId("state-phase").textContent).toBe("In playing › window");
  });

  it("shows no path for an actor without states", async () => {
    await open({ count: 1 });
    expect(screen.queryByTestId("state-phase")).toBeNull();
    fireEvent.click(screen.getByTestId("tab-timeline"));
    expect(screen.queryByTestId("timeline-phase-1")).toBeNull();
  });
});
