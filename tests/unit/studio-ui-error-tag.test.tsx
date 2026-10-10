/**
 * @vitest-environment jsdom
 *
 * Outbox panel, ADR-016 §2: the Last error column shows the error's `_tag` (Timeout, Defect or a declared
 * error) before its text. Rows from actors older than ADR-016 have no tag and show the text alone.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
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

async function openOutbox(outbox: unknown[]): Promise<void> {
  renderAt("/actors/checkout/a1");
  await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
  const ws = FakeWebSocket.latest();
  act(() => {
    ws.serverOpen();
    ws.serverSend(snapshotFrame({ count: 0 }, [timelineEntry(1, { count: 0 }, "init", {})]));
    ws.serverSend({ type: "studio.outbox", outbox });
  });
  fireEvent.click(screen.getByTestId("tab-outbox"));
}

const row = (id: string, extra: Record<string, unknown>) => ({
  id,
  service: "charge",
  payload: "{}",
  status: "failed",
  attempts: 1,
  createdAt: 1,
  ...extra,
});

describe("Outbox panel: typed errors", () => {
  it("shows the tag of the last error before its text", async () => {
    await openOutbox([
      row("3:0", { lastError: '{"_tag":"CardDeclined","reason":"stolen"}', lastErrorTag: "CardDeclined" }),
      row("2:0", { lastError: "timed out after 30000ms", lastErrorTag: "Timeout" }),
    ]);
    const [declined, timedOut] = screen.getAllByTestId("outbox-row");
    expect(within(declined ?? document.body).getByTestId("outbox-error-tag").textContent).toBe("CardDeclined");
    expect(declined?.textContent).toContain('"reason":"stolen"');
    expect(within(timedOut ?? document.body).getByTestId("outbox-error-tag").textContent).toBe("Timeout");
    expect(timedOut?.textContent).toContain("timed out after 30000ms");
  });

  it("an untagged error shows its text alone", async () => {
    await openOutbox([row("1:0", { lastError: "cancelled: the actor was restored to seq 1" })]);
    const [only] = screen.getAllByTestId("outbox-row");
    expect(within(only ?? document.body).queryByTestId("outbox-error-tag")).toBeNull();
    expect(only?.textContent).toContain("cancelled: the actor was restored to seq 1");
  });
});
