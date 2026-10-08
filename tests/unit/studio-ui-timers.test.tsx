/**
 * @vitest-environment jsdom
 *
 * Timers panel (ADR-015 D2): pending timers with name, key, due-in and payload, live from
 * studio.timers frames, and an admin "Fire now" that posts to the Studio actions route.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
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

function timerRow(key: string, fireAt: number, payload: unknown = { round: 1 }, name = "roundEnd") {
  return { id: `3:${key.length}`, name, key, payload: JSON.stringify(payload), fireAt, createdAt: 1 };
}

async function open(timers: unknown[] | undefined): Promise<FakeWebSocket> {
  renderAt("/actors/counter/a1");
  await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
  const ws = FakeWebSocket.latest();
  act(() => {
    ws.serverOpen();
    const frame = snapshotFrame({ count: 0 }, [timelineEntry(1, { count: 0 }, "init", {})]);
    ws.serverSend(timers === undefined ? frame : { ...frame, timers });
  });
  fireEvent.click(screen.getByTestId("tab-timers"));
  return ws;
}

const rows = () => screen.queryAllByTestId("timer-row");

describe("Timers panel", () => {
  it("lists pending timers soonest first with name, key, due-in and payload, and counts them on the tab", async () => {
    await open([timerRow("round-1", Date.now() + 30_000), timerRow("tick", Date.now() + 90_000, { n: 2 }, "tick")]);
    expect(screen.getByTestId("tab-timers").textContent).toContain("(2)");
    const [first, second] = rows();
    expect(first?.textContent).toContain("roundEnd");
    expect(first?.textContent).toContain("round-1");
    expect(within(first ?? document.body).getByTestId("timer-due").textContent).toMatch(/^in (29|30)s$/);
    expect(first?.textContent).toContain("round:1");
    expect(second?.textContent).toContain("tick");
    expect(within(second ?? document.body).getByTestId("timer-due").textContent).toBe("in 2m");
  });

  it("shows overdue timers as overdue", async () => {
    await open([timerRow("late", Date.now() - 5000)]);
    expect(screen.getByTestId("timer-due").textContent).toBe("overdue");
  });

  it("says so when nothing is pending, also for actors that send no timers", async () => {
    await open(undefined);
    expect(screen.getByTestId("timers-panel").textContent).toContain("No pending timers.");
    expect(screen.getByTestId("tab-timers").textContent).toBe("Timers");
  });

  it("follows studio.timers frames", async () => {
    const ws = await open([]);
    act(() => ws.serverSend({ type: "studio.timers", timers: [timerRow("round-2", Date.now() + 5000)] }));
    expect(rows()).toHaveLength(1);
    act(() => ws.serverSend({ type: "studio.timers", timers: [] }));
    expect(rows()).toHaveLength(0);
  });

  it("Fire now posts the key to the actions route", async () => {
    await open([timerRow("round-1", Date.now() + 30_000)]);
    fireEvent.click(screen.getByRole("button", { name: "Fire round-1 now" }));
    await waitFor(() => expect(fetchCalls.some((u) => u.pathname.endsWith("/actions"))).toBe(true));
    const index = fetchCalls.findIndex((u) => u.pathname.endsWith("/actions"));
    expect(fetchInits[index]?.method).toBe("POST");
    expect(JSON.parse(String(fetchInits[index]?.body))).toEqual({ action: "fireTimer", key: "round-1" });
  });

  it("shows why Fire now was refused", async () => {
    actionResponse = () => Response.json({ error: "Studio actions need the mutate scope" }, { status: 403 });
    await open([timerRow("round-1", Date.now() + 30_000)]);
    fireEvent.click(screen.getByRole("button", { name: "Fire round-1 now" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("mutate scope");
  });

  it("disables Fire now while the request is in flight", async () => {
    let release: (r: Response) => void = () => {};
    actionResponse = () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      });
    await open([timerRow("round-1", Date.now() + 30_000)]);
    const button = screen.getByRole("button", { name: "Fire round-1 now" });
    fireEvent.click(button);
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(true));
    await act(async () => release(Response.json({ ok: true })));
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  });
});

describe("Timers panel: due-in", () => {
  const due = async (offsetMs: number) => {
    cleanup();
    await open([timerRow("k", Date.now() + offsetMs)]);
    return screen.getByTestId("timer-due").textContent;
  };

  it("counts seconds up to a minute, minutes up to an hour, then shows the time", async () => {
    expect(await due(400)).toBe("in 0s");
    expect(await due(59_000)).toBe("in 59s");
    expect(await due(60_000)).toBe("in 1m");
    expect(await due(3_599_000)).toBe("in 60m");
    expect(await due(3_600_000)).not.toMatch(/^in /);
  });

  it("counts down while the panel is open", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      await open([timerRow("k", Date.now() + 10_000)]);
      expect(screen.getByTestId("timer-due").textContent).toBe("in 10s");
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(screen.getByTestId("timer-due").textContent).toBe("in 7s");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows no error until Fire now fails, and clears it when a later one works", async () => {
    actionResponse = () => Response.json({ error: "nope" }, { status: 409 });
    await open([timerRow("k", Date.now() + 10_000)]);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Fire k now" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    actionResponse = () => Response.json({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: "Fire k now" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});
