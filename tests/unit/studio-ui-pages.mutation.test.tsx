/**
 * @vitest-environment jsdom
 *
 * Dashboard and actor detail pages, through the router: what each row,
 * tab, badge and panel shows. WebSocket and fetch are fakes.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioApiError } from "../../packages/studio/ui/src/api";
import { StatusBadge } from "../../packages/studio/ui/src/components/actor-detail/status-badge";
import { causeLabel } from "../../packages/studio/ui/src/components/actor-detail/timeline-panel";
import { listFailure, PAGE_SIZE } from "../../packages/studio/ui/src/hooks/use-actor-list";
import { FakeWebSocket, fetchCalls, installFakes, renderAt, snapshotFrame, timelineEntry } from "./studio-ui-pages.helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const MIN = 60_000;

function actor(actorId: string, extra: Partial<{ actorType: string; lastActiveAt: number; connectionCount: number }> = {}) {
  return { actorType: "counter", actorId, lastActiveAt: Date.now(), version: 1, connectionCount: 0, ...extra };
}

function actorIds(): string[] {
  return screen.queryAllByTestId(/^actor-link-/).map((el) => el.textContent ?? "");
}

describe("Dashboard", () => {
  it("shows Loading until the list arrives", async () => {
    let answer: (r: Response) => void = () => {};
    installFakes((url) =>
      url.pathname.endsWith("/types")
        ? Response.json({ types: [] })
        : new Promise<Response>((resolve) => {
            answer = resolve;
          }),
    );
    renderAt("/");
    await waitFor(() => expect(screen.getByText("Loading...")).toBeTruthy());
    await act(async () => answer(Response.json({ actors: [actor("c1")] })));
    await waitFor(() => expect(actorIds()).toEqual(["c1"]));
    expect(screen.queryByText("Loading...")).toBeNull();
  });

  it("shows each actor's type, id link, last activity and connection count", async () => {
    const lastActiveAt = Date.now() - 5 * MIN;
    installFakes((url) =>
      url.pathname.endsWith("/types")
        ? Response.json({ types: ["chat", "counter"] })
        : Response.json({ actors: [actor("room 1", { actorType: "chat", lastActiveAt, connectionCount: 3 })] }),
    );
    renderAt("/");
    await waitFor(() => expect(actorIds()).toEqual(["room 1"]));
    const cells = within(screen.getByTestId("actor-list")).getAllByRole("cell");
    expect(cells.map((c) => c.textContent)).toEqual(["chat", "room 1", "5m ago", "3"]);
    expect(cells[2]?.getAttribute("title")).toBe(new Date(lastActiveAt).toISOString());
    expect(screen.getByTestId("actor-link-room 1").getAttribute("href")).toBe("/__studio/actors/chat/room%201");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["All types", "chat", "counter"]);
    expect(fetchCalls.find((u) => u.pathname === "/__studio/api/actors")?.searchParams.get("limit")).toBe(
      String(PAGE_SIZE + 1),
    );
  });

  it("keeps working when the type list fails", async () => {
    installFakes((url) =>
      url.pathname.endsWith("/types")
        ? Response.json({ error: "types down" }, { status: 500 })
        : Response.json({ actors: [actor("c1")] }),
    );
    renderAt("/");
    await waitFor(() => expect(actorIds()).toEqual(["c1"]));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });

  it("shows no pager for exactly one full page, and one for a page plus one", async () => {
    let total = PAGE_SIZE;
    installFakes((url) => {
      if (url.pathname.endsWith("/types")) return Response.json({ types: [] });
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit"));
      const all = Array.from({ length: total }, (_, i) => actor(`c${i}`));
      return Response.json({ actors: all.slice(offset, offset + limit) });
    });
    renderAt("/");
    await waitFor(() => expect(actorIds()).toHaveLength(PAGE_SIZE));
    expect(screen.queryByTestId("page-info")).toBeNull();
    cleanup();

    total = PAGE_SIZE + 1;
    renderAt("/");
    await waitFor(() => expect(actorIds()).toHaveLength(PAGE_SIZE));
    expect(screen.getByTestId("page-info").textContent).toBe(`1–${PAGE_SIZE}`);
    expect(screen.getByTestId("page-next")).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByTestId("page-next"));
    await waitFor(() => expect(actorIds()).toEqual([`c${PAGE_SIZE}`]));
    expect(screen.getByTestId("page-info").textContent).toBe(`${PAGE_SIZE + 1}–${PAGE_SIZE + 1}`);
    expect(screen.getByTestId("page-prev")).toHaveProperty("disabled", false);
    expect(screen.getByTestId("page-next")).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByTestId("page-prev"));
    await waitFor(() => expect(actorIds()).toHaveLength(PAGE_SIZE));
    expect(fetchCalls.at(-1)?.searchParams.get("offset")).toBeNull();
  });

  it("goes back to the first page when the type filter changes", async () => {
    installFakes((url) => {
      if (url.pathname.endsWith("/types")) return Response.json({ types: ["counter"] });
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const all = Array.from({ length: PAGE_SIZE * 2 }, (_, i) => actor(`c${i}`));
      return Response.json({ actors: all.slice(offset, offset + PAGE_SIZE + 1) });
    });
    renderAt("/");
    await waitFor(() => expect(actorIds()).toHaveLength(PAGE_SIZE));
    fireEvent.click(screen.getByTestId("page-next"));
    await waitFor(() => expect(actorIds()[0]).toBe(`c${PAGE_SIZE}`));
    await waitFor(() => expect(screen.getByRole("option", { name: "counter" })).toBeTruthy());
    fireEvent.change(screen.getByTestId("type-filter"), { target: { value: "counter" } });
    await waitFor(() => expect(actorIds()[0]).toBe("c0"));
    expect(fetchCalls.at(-1)?.searchParams.get("offset")).toBeNull();
    expect(fetchCalls.at(-1)?.searchParams.get("type")).toBe("counter");
  });

  it.each([
    [401, true],
    [403, true],
    [404, false],
    [500, false],
  ])("on HTTP %i offers a fresh sign-in: %s", async (status, offered) => {
    installFakes(() => Response.json({ error: "Unauthorized: no" }, { status }));
    renderAt("/");
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.queryByTestId("studio-sign-in") !== null).toBe(offered);
    expect(screen.queryByText("Loading...")).toBeNull();
    expect(screen.queryByText("No actors found.")).toBeNull();
  });

  it("describes list failures", () => {
    expect(listFailure(new StudioApiError("forbidden", "no", 403))).toEqual({
      kind: "failed",
      message: "no",
      unauthorized: true,
    });
    expect(listFailure(new StudioApiError("server", "boom", 500))).toEqual({
      kind: "failed",
      message: "boom",
      unauthorized: false,
    });
    expect(listFailure(new TypeError("odd"))).toEqual({ kind: "failed", message: "odd", unauthorized: false });
    expect(listFailure(42)).toEqual({ kind: "failed", message: "Failed to fetch actors", unauthorized: false });
  });

  it("submits nothing while the manual connect form is incomplete", async () => {
    installFakes((url) =>
      url.pathname.endsWith("/types") ? Response.json({ types: [] }) : Response.json({ actors: [] }),
    );
    const { router } = renderAt("/");
    await waitFor(() => expect(screen.getByTestId("manual-type")).toBeTruthy());
    expect(screen.getByTestId("manual-type")).toHaveProperty("value", "");
    expect(screen.getByTestId("manual-id")).toHaveProperty("value", "");
    fireEvent.change(screen.getByTestId("manual-type"), { target: { value: "counter" } });
    fireEvent.submit(screen.getByTestId("manual-id"));
    fireEvent.change(screen.getByTestId("manual-type"), { target: { value: " " } });
    fireEvent.change(screen.getByTestId("manual-id"), { target: { value: "a1" } });
    fireEvent.submit(screen.getByTestId("manual-id"));
    await new Promise((r) => setTimeout(r, 20));
    expect(router.state.location.pathname).toBe("/");
    expect(screen.getByTestId("manual-connect")).toHaveProperty("disabled", true);
  });
});

// --- Actor detail ---

function installDetailFakes(): void {
  installFakes((url) => {
    if (url.pathname === "/__studio/api/actors") return Response.json({ actors: [] });
    if (url.pathname === "/__studio/api/actors/types") return Response.json({ types: [] });
    throw new TypeError("Failed to fetch");
  });
}

async function openLive(frame: ReturnType<typeof snapshotFrame>): Promise<FakeWebSocket> {
  installDetailFakes();
  renderAt("/actors/counter/a1");
  await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
  const ws = FakeWebSocket.latest();
  act(() => {
    ws.serverOpen();
    ws.serverSend(frame);
  });
  return ws;
}

function tabLabels(): string[] {
  return within(screen.getByTestId("tab-bar"))
    .getAllByRole("button")
    .map((b) => b.textContent ?? "");
}

describe("Actor detail header and tabs", () => {
  it("shows the type, id, version, live badge, and counts only for non-empty lists", async () => {
    await openLive({ ...snapshotFrame({ n: 1 }, []), version: 4 });
    expect(screen.getByTestId("actor-title").textContent).toBe("countera1");
    expect(screen.getByText(/Version 4/)).toBeTruthy();
    expect(screen.getByTestId("status").textContent).toBe("Live");
    expect(tabLabels()).toEqual(["State", "Timeline", "Connections", "Outbox", "Timers", "Links"]);
  });

  it("counts timeline entries, connections, executions, and links plus subscribers", async () => {
    await openLive({
      ...snapshotFrame({}, [timelineEntry(2, {}), timelineEntry(1, {}, "init", {})]),
      connections: [{ connectionId: "s1", caller: "u1", callerType: "user", connectedAt: Date.now(), role: null }],
      outbox: [{ id: "o1", service: "mail", payload: "{}", status: "pending", attempts: 0, createdAt: 1 }],
      activeLinks: [{ targetType: "room", targetId: "r1", linkName: "room", version: 1 }],
      linkSubscribers: [
        { subscriberType: "lobby", subscriberId: "l1" },
        { subscriberType: "lobby", subscriberId: "l2" },
      ],
    });
    expect(tabLabels()).toEqual(["State", "Timeline(2)", "Connections(1)", "Outbox(1)", "Timers", "Links(3)"]);
  });

  it("shows Polling with an explanation when only HTTP works", async () => {
    installFakes((url) =>
      url.pathname.endsWith("/timeline")
        ? Response.json({ entries: [], hasMore: false })
        : Response.json({
            state: { n: 2 },
            version: 1,
            actorId: "a1",
            connections: [],
            outbox: [],
            activeLinks: [],
            linkSubscribers: [],
          }),
    );
    renderAt("/actors/counter/a1");
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    act(() => FakeWebSocket.latest().serverDrop());
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("Polling"));
    expect(screen.getByTestId("status").getAttribute("title")).toBe("Live updates unavailable; showing HTTP data");
    expect(screen.getByTestId("state-panel").textContent).toContain("n:2");
  });

  it("shows neither badge text nor Connecting for a permanent error before any data", async () => {
    installFakes(() => Response.json({ error: "Forbidden here" }, { status: 403 }));
    renderAt("/actors/counter/a1");
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    act(() => FakeWebSocket.latest().serverDrop());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Forbidden here"));
    expect(screen.queryByText("Connecting...")).toBeNull();
    expect(screen.queryByTestId("not-found")).toBeNull();
    expect(screen.getByRole("link", { name: "Back to dashboard" }).getAttribute("href")).toBe("/__studio/");
  });

  it("shows Connecting again while reconnecting before any data", async () => {
    installDetailFakes();
    renderAt("/actors/counter/a1");
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    act(() => {
      FakeWebSocket.latest().serverOpen();
      FakeWebSocket.latest().serverDrop();
    });
    expect(screen.getByText("Connecting...")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Actor detail panels", () => {
  it("lists connections with role or a dash, and a relative connect time", async () => {
    const connectedAt = Date.now() - 2 * MIN;
    await openLive({
      ...snapshotFrame({}, []),
      connections: [
        { connectionId: "s1", caller: "alice", callerType: "user", connectedAt, role: "host" },
        { connectionId: "s2", caller: "svc", callerType: "service", connectedAt, role: null },
      ],
    });
    fireEvent.click(screen.getByTestId("tab-connections"));
    const rows = within(screen.getByTestId("connections-panel")).getAllByRole("row").slice(1);
    expect(rows.map((r) => [...r.querySelectorAll("td")].map((td) => td.textContent))).toEqual([
      ["alice", "user", "host", "2m ago"],
      ["svc", "service", "—", "2m ago"],
    ]);
    expect(rows[0]?.querySelectorAll("td")[3]?.getAttribute("title")).toBe(new Date(connectedAt).toISOString());
  });

  it("says when there are no connections, executions, links or subscribers", async () => {
    await openLive(snapshotFrame({}, []));
    fireEvent.click(screen.getByTestId("tab-connections"));
    expect(screen.getByTestId("connections-panel").textContent).toBe("No active connections.");
    fireEvent.click(screen.getByTestId("tab-outbox"));
    expect(screen.getByTestId("outbox-panel").textContent).toBe("No executions.");
    fireEvent.click(screen.getByTestId("tab-links"));
    expect(screen.getByTestId("links-panel").textContent).toBe("Linked toNo active links.SubscribersNo subscribers.");
    fireEvent.click(screen.getByTestId("tab-timeline"));
    expect(screen.getByTestId("timeline-panel").textContent).toBe("No timeline entries.");
  });

  it("lists executions with service, status and attempts", async () => {
    await openLive({
      ...snapshotFrame({}, []),
      outbox: [
        { id: "o1", service: "mail", payload: "{}", status: "done", attempts: 1, createdAt: 1 },
        { id: "o2", service: "charge", payload: "{}", status: "retrying", attempts: 3, createdAt: 2 },
      ],
    });
    fireEvent.click(screen.getByTestId("tab-outbox"));
    const rows = screen.getAllByTestId("outbox-row");
    expect(rows.map((r) => [r.getAttribute("data-status"), r.textContent])).toEqual([
      ["done", "o1maildone1"],
      ["retrying", "o2chargeretrying3"],
    ]);
    expect(
      within(screen.getByTestId("outbox-panel"))
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Effect", "Service", "Status", "Attempts", "Last error", ""]);
  });

  it("lists links with target and version, and subscribers", async () => {
    await openLive({
      ...snapshotFrame({}, []),
      activeLinks: [{ targetType: "room", targetId: "r1", linkName: "lobby", version: 7 }],
      linkSubscribers: [{ subscriberType: "lobby", subscriberId: "l1" }],
    });
    fireEvent.click(screen.getByTestId("tab-links"));
    expect(screen.getByTestId("active-link-row").textContent).toBe("lobbyroom:r17");
    expect(screen.getByTestId("active-link-version").textContent).toBe("7");
    expect(screen.getByTestId("link-subscriber-row").textContent).toBe("lobbyl1");
  });
});

describe("Actor detail timeline", () => {
  it("labels causes and shows a relative time", async () => {
    await openLive(
      snapshotFrame({}, [
        timelineEntry(3, {}, "service.onDone", { service: "mail" }),
        timelineEntry(2, {}, "weird.cause", {}),
        timelineEntry(1, {}, "init", {}),
      ]),
    );
    fireEvent.click(screen.getByTestId("tab-timeline"));
    expect(screen.getByTestId("timeline-entry-3").textContent).toBe("service okmail completedjust now");
    expect(screen.getByTestId("timeline-entry-2").textContent).toBe("weird.causeweird.causejust now");
    expect(screen.getByTestId("timeline-entry-1").textContent).toBe("initActor initializedjust now");
  });

  it("toggles one entry at a time, and the oldest entry has no diff", async () => {
    await openLive(snapshotFrame({ n: 2 }, [timelineEntry(2, { n: 2 }), timelineEntry(1, { n: 1 }, "init", {})]));
    fireEvent.click(screen.getByTestId("tab-timeline"));
    const newest = screen.getByTestId("timeline-entry-2");
    const oldest = screen.getByTestId("timeline-entry-1");
    expect(newest.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(newest);
    expect(newest.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Changes:")).toBeTruthy();
    expect(screen.getByText("State after:")).toBeTruthy();
    fireEvent.click(oldest);
    expect(newest.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Changes:")).toBeNull();
    expect(screen.getAllByText("Cause data:")).toHaveLength(1);
    fireEvent.click(oldest);
    expect(screen.queryByText("Cause data:")).toBeNull();
  });

  it("keeps the expanded entry when switching tabs and back", async () => {
    await openLive(snapshotFrame({}, [timelineEntry(1, {}, "init", {})]));
    fireEvent.click(screen.getByTestId("tab-timeline"));
    fireEvent.click(screen.getByTestId("timeline-entry-1"));
    fireEvent.click(screen.getByTestId("tab-state"));
    expect(screen.queryByTestId("timeline-panel")).toBeNull();
    fireEvent.click(screen.getByTestId("tab-timeline"));
    expect(screen.getByTestId("timeline-entry-1").getAttribute("aria-expanded")).toBe("true");
  });

  it.each([
    ["init", "init"],
    ["migrate", "migrate"],
    ["message", "message"],
    ["lifecycle.connect", "connect"],
    ["lifecycle.disconnect", "disconnect"],
    ["service.onDone", "service ok"],
    ["service.onError", "service err"],
    ["link.onUpdate", "link update"],
    ["link.onError", "link err"],
    ["link.onUnlink", "link unlink"],
    ["custom", "custom"],
    ["toString", "toString"],
  ])("labels %s as %s", (causeType, label) => {
    expect(causeLabel(causeType).label).toBe(label);
  });
});

describe("Page details", () => {
  it("handles the manual connect submit itself (no browser form post)", async () => {
    installFakes((url) =>
      url.pathname.endsWith("/types") ? Response.json({ types: [] }) : Response.json({ actors: [] }),
    );
    renderAt("/");
    await waitFor(() => expect(screen.getByTestId("manual-type")).toBeTruthy());
    const form = screen.getByTestId("manual-id").closest("form");
    if (form === null) throw new Error("no form");
    expect(fireEvent.submit(form)).toBe(false);
  });

  it("does not report a superseded request's abort as an error", async () => {
    let calls = 0;
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("fetch", (input: string, init?: RequestInit) => {
      if (String(input).endsWith("/types")) return Promise.resolve(Response.json({ types: [] }));
      calls++;
      return new Promise<Response>((_, reject) => {
        // Every list request hangs until aborted, like a slow registry.
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    renderAt("/");
    await waitFor(() => expect(calls).toBe(1));
    fireEvent.change(screen.getByTestId("search-input"), { target: { value: "x" } });
    await waitFor(() => expect(calls).toBe(2));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Loading...")).toBeTruthy();
  });

  it("shows exactly the selected tab's panel", async () => {
    await openLive(snapshotFrame({ n: 1 }, [timelineEntry(1, { n: 1 }, "init", {})]));
    const panels = ["state", "timeline", "connections", "outbox", "links"];
    for (const tab of panels) {
      fireEvent.click(screen.getByTestId(`tab-${tab}`));
      expect(panels.filter((p) => screen.queryByTestId(`${p}-panel`) !== null)).toEqual([tab]);
    }
    fireEvent.click(screen.getByTestId("tab-timeline"));
    expect(screen.queryByText("No timeline entries.")).toBeNull();
  });
});

describe("Panel table headers", () => {
  it("labels every column of the connections, outbox, links and subscribers tables", async () => {
    await openLive({
      ...snapshotFrame({}, []),
      connections: [{ connectionId: "s1", caller: "u1", callerType: "user", connectedAt: Date.now(), role: null }],
      outbox: [{ id: "o1", service: "mail", payload: "{}", status: "done", attempts: 1, createdAt: 1 }],
      activeLinks: [{ targetType: "room", targetId: "r1", linkName: "room", version: 1 }],
      linkSubscribers: [{ subscriberType: "lobby", subscriberId: "l1" }],
    });
    const headers = (panel: string) =>
      within(screen.getByTestId(panel))
        .getAllByRole("columnheader")
        .map((h) => h.textContent);
    fireEvent.click(screen.getByTestId("tab-connections"));
    expect(headers("connections-panel")).toEqual(["Caller", "Type", "Role", "Connected"]);
    fireEvent.click(screen.getByTestId("tab-outbox"));
    expect(headers("outbox-panel")).toEqual(["Effect", "Service", "Status", "Attempts", "Last error", ""]);
    fireEvent.click(screen.getByTestId("tab-links"));
    expect(headers("links-panel")).toEqual(["Link", "Target", "Version", "Type", "ID"]);
  });
});

describe("StatusBadge", () => {
  it.each([
    ["connecting", null, null],
    ["live", "Live", null],
    ["reconnecting", "Reconnecting...", null],
    ["polling", "Polling", "Live updates unavailable; showing HTTP data"],
    ["not-found", "Not found", null],
    ["error", "Disconnected", null],
  ] as const)("%s shows %s", (status, label, title) => {
    const { container } = render(createElement(StatusBadge, { status }));
    const badge = screen.queryByTestId("status");
    expect(badge?.textContent ?? null).toBe(label);
    expect(badge?.getAttribute("title") ?? null).toBe(title);
    if (label === null) expect(container.innerHTML).toBe("");
  });
});
