/**
 * @vitest-environment jsdom
 *
 * Timeline "Restore to here" (ADR-015 D3): an entry that carries its journal seq offers a restore
 * (confirm first), which posts to the Studio actions route; older entries without a seq do not.
 */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeWebSocket,
  fetchCalls,
  fetchInits,
  installFakes,
  renderAt,
  snapshotFrame,
  timelineEntry,
} from "./studio-ui-pages.helpers";

let actionResponse: () => Response | Promise<Response> = () => Response.json({ ok: true });

beforeEach(() => {
  actionResponse = () => Response.json({ ok: true });
  installFakes((url) => {
    if (url.pathname === "/__studio/api/actors") return Response.json({ actors: [] });
    if (url.pathname === "/__studio/api/actors/types") return Response.json({ types: [] });
    if (url.pathname === "/__studio/api/actors/counter/a1/actions") return actionResponse();
    throw new TypeError("Failed to fetch");
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openTimeline(entries: ReturnType<typeof timelineEntry>[]) {
  renderAt("/actors/counter/a1");
  await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
  const ws = FakeWebSocket.latest();
  act(() => {
    ws.serverOpen();
    ws.serverSend(snapshotFrame({ count: 2 }, entries));
  });
  fireEvent.click(screen.getByTestId("tab-timeline"));
}

const withSeq = (id: number, seq: number) => ({ ...timelineEntry(id, { count: id }), seq });

const actionBodies = () =>
  fetchCalls.flatMap((url, i) => (url.pathname.endsWith("/actions") ? [JSON.parse(String(fetchInits[i]?.body))] : []));

describe("Timeline: restore to here", () => {
  it("asks for confirmation, then restores to the entry's journal seq", async () => {
    await openTimeline([withSeq(2, 7), withSeq(1, 6)]);
    fireEvent.click(screen.getByTestId("timeline-entry-1"));
    fireEvent.click(screen.getByRole("button", { name: "Restore to here" }));
    expect(actionBodies()).toEqual([]);
    expect(screen.getByText(/Restore this actor to seq 6\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm restore" }));
    await waitFor(() => expect(actionBodies()).toEqual([{ action: "restore", toSeq: 6 }]));
  });

  it("can be cancelled", async () => {
    await openTimeline([withSeq(1, 6)]);
    fireEvent.click(screen.getByTestId("timeline-entry-1"));
    fireEvent.click(screen.getByRole("button", { name: "Restore to here" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Confirm restore" })).toBeNull();
    expect(screen.getByRole("button", { name: "Restore to here" })).toBeTruthy();
    expect(actionBodies()).toEqual([]);
  });

  it("is not offered for entries recorded before timeline rows carried a seq", async () => {
    await openTimeline([timelineEntry(1, { count: 1 })]);
    fireEvent.click(screen.getByTestId("timeline-entry-1"));
    expect(screen.queryByRole("button", { name: "Restore to here" })).toBeNull();
  });

  it("shows the server's refusal", async () => {
    actionResponse = () => Response.json({ error: "Cannot restore to seq 6: the journal is pruned before it" }, { status: 409 });
    await openTimeline([withSeq(1, 6)]);
    fireEvent.click(screen.getByTestId("timeline-entry-1"));
    fireEvent.click(screen.getByRole("button", { name: "Restore to here" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm restore" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("pruned before it");
  });

  it("disables the confirm button while restoring and closes the prompt when done", async () => {
    let release: (r: Response) => void = () => {};
    actionResponse = () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      });
    await openTimeline([withSeq(1, 6)]);
    fireEvent.click(screen.getByTestId("timeline-entry-1"));
    fireEvent.click(screen.getByRole("button", { name: "Restore to here" }));
    const confirm = screen.getByRole("button", { name: "Confirm restore" });
    fireEvent.click(confirm);
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(true));
    await act(async () => release(Response.json({ ok: true })));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Confirm restore" })).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Timeline: restore to here, retrying", () => {
  it("clears an earlier error and re-enables the button after a failure", async () => {
    actionResponse = () => Response.json({ error: "first try failed" }, { status: 409 });
    await openTimeline([withSeq(1, 6)]);
    fireEvent.click(screen.getByTestId("timeline-entry-1"));
    fireEvent.click(screen.getByRole("button", { name: "Restore to here" }));
    const confirm = screen.getByRole("button", { name: "Confirm restore" });
    fireEvent.click(confirm);
    expect(await screen.findByRole("alert")).toBeTruthy();
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false));
    let release: (r: Response) => void = () => {};
    actionResponse = () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      });
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    await act(async () => release(Response.json({ ok: true })));
  });
});
