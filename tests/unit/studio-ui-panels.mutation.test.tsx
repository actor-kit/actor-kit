/**
 * @vitest-environment jsdom
 *
 * Mutants that survived Stryker on the Studio panels: the timer and restore badge labels, the
 * separator between emitted event names, and the timers panel's clock being stopped on unmount.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { causeLabel } from "../../packages/studio/ui/src/components/actor-detail/timeline-panel";
import { TimersPanel } from "../../packages/studio/ui/src/components/timers-panel";
import { FakeWebSocket, installFakes, renderAt, snapshotFrame, timelineEntry } from "./studio-ui-pages.helpers";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("timeline badges", () => {
  it.each([
    ["timer", "timer"],
    ["restore", "restore"],
  ])("%s entries are labelled %s", (causeType, label) => {
    expect(causeLabel(causeType).label).toBe(label);
  });
});

describe("emitted events on a timeline row", () => {
  beforeEach(() => {
    installFakes((url) => {
      if (url.pathname === "/__studio/api/actors") return Response.json({ actors: [] });
      if (url.pathname === "/__studio/api/actors/types") return Response.json({ types: [] });
      throw new TypeError("Failed to fetch");
    });
  });

  it("are listed by name, comma separated", async () => {
    renderAt("/actors/counter/a1");
    await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
    const ws = FakeWebSocket.latest();
    const emitted = JSON.stringify([
      { name: "Opened", payload: null },
      { name: "Closed", payload: null },
    ]);
    act(() => {
      ws.serverOpen();
      ws.serverSend(snapshotFrame({ count: 1 }, [{ ...timelineEntry(2, { count: 1 }), emitted }]));
    });
    fireEvent.click(screen.getByTestId("tab-timeline"));
    expect(screen.getByTestId("timeline-emitted-2").textContent).toBe("Opened, Closed");
  });
});

describe("timers panel clock", () => {
  it("stops ticking when the panel goes away", () => {
    vi.useFakeTimers();
    const { unmount } = render(<TimersPanel actorType="counter" actorId="a1" timers={[]} />);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
