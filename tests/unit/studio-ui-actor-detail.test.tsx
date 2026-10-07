/**
 * @vitest-environment jsdom
 *
 * Actor detail page: initial load, live updates, error states, timeline
 * rendering, and socket cleanup on navigation.
 */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket, installFakes, renderAt, snapshotFrame, timelineEntry } from "./studio-ui-pages.helpers";

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

async function openDetail(): Promise<FakeWebSocket> {
  renderAt("/actors/counter/a1");
  await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
  return FakeWebSocket.latest();
}

describe("Actor detail page", () => {
  it("shows Connecting until the snapshot arrives, then the state", async () => {
    const ws = await openDetail();
    expect(screen.getByText("Connecting...")).toBeTruthy();
    act(() => {
      ws.serverOpen();
      ws.serverSend(snapshotFrame({ count: 5 }, [timelineEntry(1, { count: 5 }, "init", {})]));
    });
    expect(screen.getByTestId("state-panel").textContent).toContain("count:5");
    expect(screen.getByText("Live")).toBeTruthy();
  });

  it("updates state and timeline live as messages arrive", async () => {
    const ws = await openDetail();
    act(() => {
      ws.serverOpen();
      ws.serverSend(snapshotFrame({ count: 0 }, [timelineEntry(1, { count: 0 }, "init", {})]));
      ws.serverSend({ type: "studio.timeline", entry: timelineEntry(2, { count: 1 }) });
    });
    expect(screen.getByTestId("state-panel").textContent).toContain("count:1");
    fireEvent.click(screen.getByTestId("tab-timeline"));
    expect(screen.getByTestId("timeline-entry-2").textContent).toContain("u1 sent INCREMENT");
    expect(screen.getByTestId("timeline-entry-1").textContent).toContain("Actor initialized");
  });

  it("expands exactly one live timeline entry and shows its diff", async () => {
    const ws = await openDetail();
    act(() => {
      ws.serverOpen();
      ws.serverSend(snapshotFrame({ count: 0 }, [timelineEntry(1, { count: 0 }, "init", {})]));
      ws.serverSend({ type: "studio.timeline", entry: timelineEntry(2, { count: 1 }) });
      ws.serverSend({ type: "studio.timeline", entry: timelineEntry(3, { count: 2 }) });
    });
    fireEvent.click(screen.getByTestId("tab-timeline"));
    fireEvent.click(screen.getByTestId("timeline-entry-2"));
    expect(screen.getAllByText("Cause data:")).toHaveLength(1);
    expect(screen.getByText("Changes:")).toBeTruthy();
    expect(screen.getByTestId("timeline-panel").textContent).toContain("count0→1");
  });

  it("shows the diff for an entry whose previous state is falsy (null)", async () => {
    const ws = await openDetail();
    act(() => {
      ws.serverOpen();
      ws.serverSend(
        snapshotFrame({ count: 1 }, [timelineEntry(2, { count: 1 }), timelineEntry(1, null, "init", {})]),
      );
    });
    fireEvent.click(screen.getByTestId("tab-timeline"));
    fireEvent.click(screen.getByTestId("timeline-entry-2"));
    expect(screen.getByText("Changes:")).toBeTruthy();
  });

  it("summarizes every cause type, including ones with missing fields", async () => {
    const ws = await openDetail();
    act(() => {
      ws.serverOpen();
      ws.serverSend(
        snapshotFrame({}, [
          timelineEntry(9, {}, "link.onUnlink", { sourceType: "room", sourceId: "r1" }),
          timelineEntry(8, {}, "link.onError", { sourceType: "room", sourceId: "r1", error: "boom" }),
          timelineEntry(7, {}, "migrate", { fromVersion: 1, toVersion: 2 }),
          timelineEntry(6, {}, "service.onError", { service: "charge", error: "declined" }),
          timelineEntry(5, {}, "service.onDone", { service: "charge" }),
          timelineEntry(4, {}, "lifecycle.disconnect", { caller: "u2" }),
          timelineEntry(3, {}, "lifecycle.connect", { caller: "u2", role: "player" }),
          timelineEntry(2, {}, "message", {}),
          timelineEntry(1, {}, "custom.thing", {}),
        ]),
      );
    });
    fireEvent.click(screen.getByTestId("tab-timeline"));
    const text = (id: number) => screen.getByTestId(`timeline-entry-${id}`).textContent;
    expect(text(9)).toContain("room:r1 unlinked");
    expect(text(8)).toContain("room:r1 failed: boom");
    expect(text(7)).toContain("Migrated from v1 to v2");
    expect(text(6)).toContain("charge failed: declined");
    expect(text(5)).toContain("charge completed");
    expect(text(4)).toContain("u2 disconnected");
    expect(text(3)).toContain("u2 connected (player)");
    expect(text(2)).toContain("unknown sent unknown");
    expect(text(1)).toContain("custom.thing");
  });

  it("shows a malformed frame as an error banner without crashing the page", async () => {
    const ws = await openDetail();
    act(() => {
      ws.serverOpen();
      ws.serverSend(snapshotFrame({ count: 3 }, [timelineEntry(1, { count: 3 }, "init", {})]));
      ws.serverSend({ type: "studio.timeline", entry: { ...timelineEntry(2, {}), causeData: "not json" } });
    });
    expect(screen.getByRole("alert").textContent).toMatch(/Malformed studio frame/);
    expect(screen.getByTestId("state-panel").textContent).toContain("count:3");
  });

  it("shows Reconnecting while the socket is down, keeping the last state", async () => {
    const ws = await openDetail();
    act(() => {
      ws.serverOpen();
      ws.serverSend(snapshotFrame({ count: 3 }, []));
      ws.serverDrop();
    });
    expect(screen.getByText("Reconnecting...")).toBeTruthy();
    expect(screen.getByTestId("state-panel").textContent).toContain("count:3");
  });

  it("shows an error state for an unknown actor type instead of Connecting forever", async () => {
    installFakes(() => Response.json({ error: 'Actor type "nope" not found in env bindings' }, { status: 404 }));
    renderAt("/actors/nope/a1");
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    act(() => FakeWebSocket.latest().serverDrop());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain('Actor type "nope" not found'));
    expect(screen.queryByText("Connecting...")).toBeNull();
  });

  it("shows 'not created yet' for an actor the registry doesn't know, then goes live once it exists", async () => {
    installFakes(() => Response.json({ error: 'Actor "counter/a1" not found' }, { status: 404 }));
    renderAt("/actors/counter/a1");
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    act(() => FakeWebSocket.latest().serverDrop());
    await waitFor(() => expect(screen.getByTestId("not-found")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain('Actor "counter/a1" not found');

    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(2), { timeout: 3000 });
    act(() => {
      FakeWebSocket.latest().serverOpen();
      FakeWebSocket.latest().serverSend(snapshotFrame({ count: 0 }, []));
    });
    expect(screen.getByTestId("state-panel").textContent).toContain("count:0");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    [401, "Unauthorized"],
    [403, "Studio is not configured"],
  ])("shows a readable error for %i", async (status, message) => {
    installFakes(() => Response.json({ error: message }, { status }));
    renderAt("/actors/counter/a1");
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    act(() => FakeWebSocket.latest().serverDrop());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(message));
    expect(screen.queryByText("Connecting...")).toBeNull();
  });

  it("shows a server error (500) from the HTTP probe", async () => {
    installFakes(() => Response.json({ error: "RPC method exploded" }, { status: 500 }));
    renderAt("/actors/counter/a1");
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    act(() => FakeWebSocket.latest().serverDrop());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("RPC method exploded"));
  });

  it("closes the socket when navigating back to the dashboard", async () => {
    const ws = await openDetail();
    act(() => {
      ws.serverOpen();
      ws.serverSend(snapshotFrame({ count: 1 }, []));
    });
    fireEvent.click(screen.getByText("← Dashboard"));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Actors" })).toBeTruthy());
    expect(ws.closeCalls).toBe(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
