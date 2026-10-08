/**
 * @vitest-environment jsdom
 *
 * Outbox panel: forwards are listed beside executions (same effect ids, statuses and redrive),
 * labelled with the link they go through and their target.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket, installFakes, renderAt, snapshotFrame, timelineEntry } from "./studio-ui-pages.helpers";

beforeEach(() => {
  installFakes((url) => {
    if (url.pathname === "/__studio/api/actors") return Response.json({ actors: [] });
    if (url.pathname === "/__studio/api/actors/types") return Response.json({ types: [] });
    if (url.pathname.endsWith("/actions")) return Response.json({ ok: true });
    throw new TypeError("Failed to fetch");
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openOutbox(outbox: unknown[]) {
  renderAt("/actors/counter/a1");
  await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
  const ws = FakeWebSocket.latest();
  act(() => {
    ws.serverOpen();
    ws.serverSend(snapshotFrame({ count: 0 }, [timelineEntry(1, { count: 0 }, "init", {})]));
    ws.serverSend({ type: "studio.outbox", outbox });
  });
  fireEvent.click(screen.getByTestId("tab-outbox"));
}

const base = { payload: "{}", attempts: 2, createdAt: 1, nextAttemptAt: null, lastError: "unreachable" };

describe("Outbox panel: forwards", () => {
  it("labels a forward with its link and target; executions keep their service name", async () => {
    await openOutbox([
      { ...base, id: "4:1", service: "room", status: "failed", kind: "forward", target: "lobby-7" },
      { ...base, id: "4:0", service: "EMAIL", status: "done", lastError: null },
    ]);
    const [forward, execution] = screen.getAllByTestId("outbox-row");
    if (forward === undefined || execution === undefined) throw new Error("expected two rows");
    expect(within(forward).getByTestId("outbox-forward").textContent).toBe("forward → room / lobby-7");
    expect(within(execution).queryByTestId("outbox-forward")).toBeNull();
    expect(within(execution).getAllByRole("cell")[1]?.textContent).toBe("EMAIL");
    expect(within(forward).getByRole("button", { name: "Redrive 4:1" })).toBeTruthy();
  });

});
