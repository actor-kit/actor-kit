/**
 * @vitest-environment jsdom
 *
 * Actor detail page: Outbox and Links panels follow live studio.outbox and
 * studio.links frames without a reconnect.
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

async function openLive(): Promise<FakeWebSocket> {
  renderAt("/actors/counter/a1");
  await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
  const ws = FakeWebSocket.latest();
  act(() => {
    ws.serverOpen();
    ws.serverSend(snapshotFrame({ count: 0 }, [timelineEntry(1, { count: 0 }, "init", {})]));
  });
  return ws;
}

function execution(id: string, status: string, attempts = 0) {
  return { id, service: "NOTIFY", payload: "{}", status, attempts, createdAt: 1 };
}

const statuses = () => screen.queryAllByTestId("outbox-row").map((row) => row.getAttribute("data-status"));

describe("Outbox panel (live)", () => {
  it("shows pending, then done, as studio.outbox frames arrive", async () => {
    const ws = await openLive();
    fireEvent.click(screen.getByTestId("tab-outbox"));
    expect(screen.getByTestId("outbox-panel").textContent).toContain("No executions.");

    act(() => ws.serverSend({ type: "studio.outbox", outbox: [execution("e1", "pending")] }));
    expect(statuses()).toEqual(["pending"]);
    expect(screen.getByTestId("outbox-row").textContent).toContain("NOTIFY");
    expect(screen.getByTestId("tab-outbox").textContent).toContain("(1)");

    act(() => ws.serverSend({ type: "studio.outbox", outbox: [execution("e1", "done", 1)] }));
    expect(statuses()).toEqual(["done"]);
  });

  it("replaces the list with each frame (failed alongside done)", async () => {
    const ws = await openLive();
    fireEvent.click(screen.getByTestId("tab-outbox"));
    act(() =>
      ws.serverSend({ type: "studio.outbox", outbox: [execution("e2", "failed"), execution("e1", "done")] }),
    );
    expect(statuses()).toEqual(["failed", "done"]);
  });

  it("flags a malformed studio.outbox frame and keeps the last good list", async () => {
    const ws = await openLive();
    fireEvent.click(screen.getByTestId("tab-outbox"));
    act(() => ws.serverSend({ type: "studio.outbox", outbox: [execution("e1", "pending")] }));
    act(() => ws.serverSend({ type: "studio.outbox", outbox: [{ id: "e1" }] }));
    expect(statuses()).toEqual(["pending"]);
    expect(screen.getByText(/Malformed studio frame: Invalid studio.outbox frame/)).toBeTruthy();
  });
});

describe("Links panel (live)", () => {
  it("shows active links and subscribers as studio.links frames arrive, and clears them", async () => {
    const ws = await openLive();
    fireEvent.click(screen.getByTestId("tab-links"));
    expect(screen.getByTestId("links-panel").textContent).toContain("No active links.");
    expect(screen.getByTestId("links-panel").textContent).toContain("No subscribers.");

    act(() =>
      ws.serverSend({
        type: "studio.links",
        activeLinks: [{ targetType: "LOBBY", targetId: "l1", linkName: "lobby", version: 7 }],
        linkSubscribers: [{ subscriberType: "DESK", subscriberId: "d1" }],
      }),
    );
    expect(screen.getByTestId("active-link-row").textContent).toContain("LOBBY:l1");
    expect(screen.getByTestId("active-link-version").textContent).toBe("7");
    expect(screen.getByTestId("link-subscriber-row").textContent).toContain("DESKd1");
    expect(screen.getByTestId("tab-links").textContent).toContain("(2)");

    act(() => ws.serverSend({ type: "studio.links", activeLinks: [], linkSubscribers: [] }));
    expect(screen.queryAllByTestId("active-link-row")).toHaveLength(0);
    expect(screen.queryAllByTestId("link-subscriber-row")).toHaveLength(0);
  });
});
