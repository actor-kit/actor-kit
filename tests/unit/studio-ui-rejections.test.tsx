/**
 * @vitest-environment jsdom
 *
 * ADR-018 F: the actor page shows how many messages the actor refused, by code on hover.
 */
import { act, cleanup, screen, waitFor } from "@testing-library/react";
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

async function open(frame: Record<string, unknown>) {
  renderAt("/actors/counter/a1");
  await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
  const ws = FakeWebSocket.latest();
  act(() => {
    ws.serverOpen();
    ws.serverSend(frame);
  });
}

describe("rejections counter", () => {
  it("shows the total, and each code's count as its title", async () => {
    const frame = snapshotFrame({ count: 0 }, [timelineEntry(1, { count: 0 }, "init", {})]);
    await open({ ...frame, rejections: { total: 3, byCode: { guard_failed: 2, no_role: 1 } } });
    const counter = screen.getByTestId("rejections-count");
    expect(counter.textContent).toBe("· 3 rejected");
    expect(counter.getAttribute("title")).toBe("guard_failed: 2, no_role: 1");
  });

  it("shows nothing for an actor that does not report rejections (older versions)", async () => {
    await open(snapshotFrame({ count: 0 }, [timelineEntry(1, { count: 0 }, "init", {})]));
    expect(screen.queryByTestId("rejections-count")).toBeNull();
  });
});
