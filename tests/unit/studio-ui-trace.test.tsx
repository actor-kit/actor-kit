/**
 * @vitest-environment jsdom
 *
 * Causation and correlation ids in Studio (ADR-017 §4): an expanded timeline entry shows its flow
 * and what caused it, with a link to the causing event: the entry itself when it is this actor's,
 * the other actor's timeline (opened at that entry) otherwise.
 */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCauseRef } from "../../packages/studio/ui/src/cause-ref";
import { TimelineEntrySchema } from "../../packages/studio/ui/src/protocol";
import { FakeWebSocket, installFakes, renderAt, snapshotFrame, timelineEntry } from "./studio-ui-pages.helpers";

const traced = (id: number, correlationId: string | null, causationId: string | null) => ({
  ...timelineEntry(id, { count: id }),
  seq: id,
  correlationId,
  causationId,
});

describe("parseCauseRef", () => {
  it("parses event and effect ids (actor ids may contain slashes)", () => {
    expect(parseCauseRef("counter/a1/3")).toEqual({ actorType: "counter", actorId: "a1", seq: 3 });
    expect(parseCauseRef("desk/x/y/7:2")).toEqual({ actorType: "desk", actorId: "x/y", seq: 7, index: 2 });
  });
  it("parses multi-digit indexes", () => {
    expect(parseCauseRef("a/b/3:12")).toEqual({ actorType: "a", actorId: "b", seq: 3, index: 12 });
  });
  it.each(["/x/y/3", "", "counter", "counter/3", "/a/3", "a//3", "a/b/x", "a/b/3:", "a/b/03"])("refuses %j", (id) => {
    expect(parseCauseRef(id)).toBeNull();
  });
});

describe("protocol: ids", () => {
  it("are parsed when present and absent from older entries", () => {
    expect(TimelineEntrySchema.parse(traced(2, "a/1/1", "a/1/1:0"))).toMatchObject({
      correlationId: "a/1/1",
      causationId: "a/1/1:0",
    });
    const old = TimelineEntrySchema.parse(timelineEntry(1, {}));
    expect(old.correlationId).toBeUndefined();
    expect(old.causationId).toBeUndefined();
  });
});

describe("timeline panel: flow and cause", () => {
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

  async function open(path: string, entries: Array<ReturnType<typeof traced> & { emitted?: string }>, clickTab = true) {
    renderAt(path);
    await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
    const ws = FakeWebSocket.latest();
    act(() => {
      ws.serverOpen();
      ws.serverSend({ ...snapshotFrame({ count: 3 }, []), timeline: entries });
    });
    if (clickTab) fireEvent.click(screen.getByTestId("tab-timeline"));
  }

  it("a cause in this actor's timeline opens that entry", async () => {
    await open("/actors/counter/a1", [traced(3, "counter/a1/2", "counter/a1/2:0"), traced(2, "counter/a1/2", null)]);
    fireEvent.click(screen.getByTestId("timeline-entry-3"));
    expect(screen.getByTestId("entry-correlation").textContent).toBe("counter/a1/2");
    fireEvent.click(screen.getByRole("button", { name: "counter/a1/2:0" }));
    expect(screen.getByTestId("timeline-entry-2").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Started this flow")).toBeTruthy();
  });

  it("a cause in another actor links to its timeline at that entry", async () => {
    await open("/actors/counter/a1", [traced(4, "desk/d 1/2", "desk/d 1/2:1")]);
    fireEvent.click(screen.getByTestId("timeline-entry-4"));
    const link = screen.getByRole("link", { name: "desk/d 1/2:1" });
    expect(link.getAttribute("href")).toBe("/__studio/actors/desk/d%201?entry=2");
  });

  it("a cause that is not an id is shown as text", async () => {
    await open("/actors/counter/a1", [traced(5, "x", "not-an-id")]);
    fireEvent.click(screen.getByTestId("timeline-entry-5"));
    expect(screen.getByTestId("entry-causation").textContent).toBe("not-an-id");
    expect(screen.queryByRole("link", { name: "not-an-id" })).toBeNull();
  });

  it("entries written before ids show neither", async () => {
    await open("/actors/counter/a1", [{ ...traced(6, null, null) }]);
    fireEvent.click(screen.getByTestId("timeline-entry-6"));
    expect(screen.queryByTestId("entry-correlation")).toBeNull();
    expect(screen.queryByText("Started this flow")).toBeNull();
  });

  it("?entry=N opens the timeline with that entry expanded", async () => {
    await open("/actors/counter/a1?entry=2", [traced(3, "c", null), traced(2, "c", null)], false);
    expect(screen.getByTestId("timeline-entry-2").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("timeline-entry-3").getAttribute("aria-expanded")).toBe("false");
  });

  it.each(["abc", "0", "1.5", "-2"])("?entry=%s is ignored", async (entry) => {
    await open(`/actors/counter/a1?entry=${entry}`, [traced(2, "c", null)], false);
    expect(screen.getByTestId("state-panel")).toBeTruthy();
    expect(screen.getByText("Actor Kit Studio")).toBeTruthy();
  });

  it("shows the events an entry emitted", async () => {
    const entry = { ...traced(7, "c", null), emitted: JSON.stringify([{ name: "BidPlaced", payload: { amount: 5 } }]) };
    await open("/actors/counter/a1", [entry]);
    expect(screen.getByTestId("timeline-emitted-7").textContent).toBe("BidPlaced");
    fireEvent.click(screen.getByTestId("timeline-entry-7"));
    expect(screen.getByText("Emitted:")).toBeTruthy();
  });

  it("marks the entries where the phase changed", async () => {
    const phased = (id: number, phase: string) => ({
      ...traced(id, "c", null),
      stateSnapshot: JSON.stringify({ shared: {}, phase, local: null, stateTimers: [] }),
    });
    await open("/actors/counter/a1", [phased(3, "round"), phased(2, "lobby"), phased(1, "lobby")]);
    expect(screen.getByTestId("timeline-phase-3").textContent).toBe("→ round");
    expect(screen.queryByTestId("timeline-phase-2")).toBeNull();
  });

  it("an entry that emitted nothing shows neither", async () => {
    await open("/actors/counter/a1", [{ ...traced(8, "c", null), emitted: "[]" }]);
    expect(screen.queryByTestId("timeline-emitted-8")).toBeNull();
    fireEvent.click(screen.getByTestId("timeline-entry-8"));
    expect(screen.queryByText("Emitted:")).toBeNull();
  });
});

describe("phase changes (ADR-017 §1)", () => {
  const at = (id: number, state: unknown) => TimelineEntrySchema.parse({ ...timelineEntry(id, state) });
  it("marks an entry whose phase differs from the previous one", async () => {
    const { phaseChange } = await import("../../packages/studio/ui/src/phase-change");
    const lobby = at(1, { shared: {}, phase: "lobby", local: null, stateTimers: [] });
    const round = at(2, { shared: {}, phase: "round", local: { n: 1 }, stateTimers: [] });
    expect(phaseChange(round, lobby)).toBe("round");
    expect(phaseChange(lobby, lobby)).toBeNull();
    expect(phaseChange(round, undefined)).toBeNull();
    expect(phaseChange(at(3, { count: 1 }), lobby)).toBeNull();
    expect(phaseChange(at(3, { phase: 7 }), lobby)).toBeNull();
    expect(phaseChange(at(3, null), lobby)).toBeNull();
    expect(phaseChange(round, at(1, 5))).toBeNull();
    const unknown = TimelineEntrySchema.parse({ ...timelineEntry(4, {}), stateSnapshot: null });
    expect(phaseChange(unknown, lobby)).toBeNull();
  });
});
