/**
 * @vitest-environment jsdom
 *
 * Outbox panel, ADR-015 D1: retry details (next try, last error) and the Redrive action on
 * dead letters (failed rows), which posts to the Studio actions route.
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

let actionResponse: () => Response = () => Response.json({ ok: true });

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

async function openOutbox(outbox: unknown[]): Promise<FakeWebSocket> {
  renderAt("/actors/counter/a1");
  await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
  const ws = FakeWebSocket.latest();
  act(() => {
    ws.serverOpen();
    ws.serverSend(snapshotFrame({ count: 0 }, [timelineEntry(1, { count: 0 }, "init", {})]));
    ws.serverSend({ type: "studio.outbox", outbox });
  });
  fireEvent.click(screen.getByTestId("tab-outbox"));
  return ws;
}

function row(id: string, status: string, extra: Record<string, unknown> = {}) {
  return { id, service: "NOTIFY", payload: "{}", status, attempts: 1, createdAt: 1, ...extra };
}

const actionCalls = () =>
  fetchCalls
    .map((url, i) => ({ url, init: fetchInits[i] }))
    .filter(({ url }) => url.pathname.endsWith("/actions"));

describe("Outbox panel: retries and dead letters", () => {
  it("shows the effect id, the last error and when a retrying row tries next", async () => {
    await openOutbox([row("12:0", "retrying", { nextAttemptAt: Date.now() + 5000, lastError: "timeout" })]);
    const text = screen.getByTestId("outbox-row").textContent ?? "";
    expect(text).toContain("12:0");
    expect(text).toContain("timeout");
    expect(screen.getByTestId("outbox-next-try").textContent).toMatch(/in \d+s/);
  });

  it("still renders rows from an actor that sends no retry fields", async () => {
    await openOutbox([row("e1", "done")]);
    expect(screen.getByTestId("outbox-row").getAttribute("data-status")).toBe("done");
    expect(screen.queryByTestId("outbox-next-try")).toBeNull();
  });

  it("offers Redrive only on failed rows", async () => {
    await openOutbox([row("3:0", "failed", { lastError: "boom" }), row("2:0", "done"), row("1:0", "retrying")]);
    expect(screen.getAllByRole("button", { name: /redrive/i })).toHaveLength(1);
  });

  it("Redrive posts the effect id to the actions route", async () => {
    await openOutbox([row("3:0", "failed", { lastError: "boom" })]);
    fireEvent.click(screen.getByRole("button", { name: /redrive 3:0/i }));
    await waitFor(() => expect(actionCalls()).toHaveLength(1));
    const [call] = actionCalls();
    expect(call?.init?.method).toBe("POST");
    expect(JSON.parse(String(call?.init?.body))).toEqual({ action: "redrive", effectId: "3:0" });
  });

  it("shows the server's refusal (e.g. no mutate scope) instead of failing silently", async () => {
    actionResponse = () => Response.json({ error: "Studio actions need the mutate scope" }, { status: 403 });
    await openOutbox([row("3:0", "failed")]);
    fireEvent.click(screen.getByRole("button", { name: /redrive 3:0/i }));
    expect(await screen.findByText(/need the mutate scope/)).toBeTruthy();
  });
});
