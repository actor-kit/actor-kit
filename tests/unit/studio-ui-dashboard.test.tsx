/**
 * @vitest-environment jsdom
 *
 * Dashboard: listing, type filter, search, pagination, empty and error
 * states, the studio-key prompt, and manual connect.
 */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket, type FetchRoute, fetchCalls, installFakes, renderAt } from "./studio-ui-pages.helpers";

function actor(actorType: string, actorId: string) {
  return { actorType, actorId, lastActiveAt: Date.now(), version: 1, connectionCount: 0 };
}

/** A registry with `count` counters (sorted), honoring type/search/limit/offset like the real one. */
function registryRoute(all: ReturnType<typeof actor>[]): FetchRoute {
  return (url) => {
    if (url.pathname === "/__studio/api/actors/types") {
      return Response.json({ types: [...new Set(all.map((a) => a.actorType))] });
    }
    if (url.pathname === "/__studio/api/actors") {
      const type = url.searchParams.get("type");
      const search = url.searchParams.get("search");
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const matching = all.filter(
        (a) => (type === null || a.actorType === type) && (search === null || a.actorId.includes(search)),
      );
      return Response.json({ actors: matching.slice(offset, offset + limit) });
    }
    throw new TypeError("Failed to fetch");
  };
}

function actorIds(): string[] {
  return screen.queryAllByTestId(/^actor-link-/).map((el) => el.textContent ?? "");
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Dashboard", () => {
  beforeEach(() => {
    installFakes(registryRoute([actor("counter", "c1"), actor("counter", "c2"), actor("chat", "room-1")]));
  });

  it("lists actors with links to their detail pages", async () => {
    renderAt("/");
    await waitFor(() => expect(actorIds()).toEqual(["c1", "c2", "room-1"]));
  });

  it("filters by actor type", async () => {
    renderAt("/");
    await waitFor(() => expect(screen.getByRole("option", { name: "chat" })).toBeTruthy());
    fireEvent.change(screen.getByTestId("type-filter"), { target: { value: "chat" } });
    await waitFor(() => expect(actorIds()).toEqual(["room-1"]));
    expect(fetchCalls.at(-1)?.searchParams.get("type")).toBe("chat");
  });

  it("searches by actor id", async () => {
    renderAt("/");
    await waitFor(() => expect(actorIds()).toHaveLength(3));
    fireEvent.change(screen.getByTestId("search-input"), { target: { value: "c2" } });
    await waitFor(() => expect(actorIds()).toEqual(["c2"]));
  });

  it("shows the empty state when nothing matches", async () => {
    renderAt("/");
    await waitFor(() => expect(actorIds()).toHaveLength(3));
    fireEvent.change(screen.getByTestId("search-input"), { target: { value: "zzz" } });
    await waitFor(() => expect(screen.getByText("No actors found.")).toBeTruthy());
  });

  it("keeps the newest search result when responses arrive out of order", async () => {
    const pending: Array<{ search: string | null; resolve: (r: Response) => void }> = [];
    installFakes((url) => {
      if (url.pathname === "/__studio/api/actors/types") return Response.json({ types: [] });
      const search = url.searchParams.get("search");
      return new Promise<Response>((resolve) => pending.push({ search, resolve }));
    });
    renderAt("/");
    await waitFor(() => expect(pending).toHaveLength(1));
    fireEvent.change(screen.getByTestId("search-input"), { target: { value: "a" } });
    await waitFor(() => expect(pending).toHaveLength(2));
    fireEvent.change(screen.getByTestId("search-input"), { target: { value: "ab" } });
    await waitFor(() => expect(pending).toHaveLength(3));

    // Newest ("ab") answers first, then the stale "a" request answers.
    await act(async () => {
      pending[2]?.resolve(Response.json({ actors: [actor("counter", "ab-1")] }));
    });
    await act(async () => {
      pending[1]?.resolve(Response.json({ actors: [actor("counter", "a-1"), actor("counter", "ab-1")] }));
      pending[0]?.resolve(Response.json({ actors: [] }));
    });
    await waitFor(() => expect(actorIds()).toEqual(["ab-1"]));
  });

  it("paginates with Next/Previous and resets to the first page when the filter changes", async () => {
    const many = Array.from({ length: 120 }, (_, i) => actor("counter", `c-${String(i).padStart(3, "0")}`));
    installFakes(registryRoute(many));
    renderAt("/");
    await waitFor(() => expect(actorIds()).toHaveLength(50));
    expect(actorIds()[0]).toBe("c-000");
    expect(screen.getByTestId("page-info").textContent).toBe("1–50");
    expect(screen.getByTestId("page-prev")).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByTestId("page-next"));
    await waitFor(() => expect(actorIds()[0]).toBe("c-050"));
    fireEvent.click(screen.getByTestId("page-next"));
    await waitFor(() => expect(actorIds()).toHaveLength(20));
    expect(screen.getByTestId("page-info").textContent).toBe("101–120");
    expect(screen.getByTestId("page-next")).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByTestId("page-prev"));
    await waitFor(() => expect(actorIds()[0]).toBe("c-050"));

    fireEvent.change(screen.getByTestId("search-input"), { target: { value: "c-1" } });
    await waitFor(() => expect(actorIds()[0]).toBe("c-100"));
    expect(fetchCalls.at(-1)?.searchParams.get("offset")).toBeNull();
  });

  it("does not show pagination controls when everything fits on one page", async () => {
    renderAt("/");
    await waitFor(() => expect(actorIds()).toHaveLength(3));
    expect(screen.queryByTestId("page-next")).toBeNull();
  });
});

describe("Dashboard error states", () => {
  it("shows the registry's error message (503) and keeps manual connect available", async () => {
    installFakes((url) =>
      url.pathname.endsWith("/types")
        ? Response.json({ types: [], error: "StudioRegistry not found in env bindings" }, { status: 503 })
        : Response.json({ actors: [], error: "StudioRegistry not found in env bindings" }, { status: 503 }),
    );
    renderAt("/");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("StudioRegistry not found in env bindings"));
    expect(screen.getByTestId("manual-type")).toBeTruthy();
  });

  it("shows a server error (500)", async () => {
    installFakes(() => Response.json({ error: "registry exploded" }, { status: 500 }));
    renderAt("/");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("registry exploded"));
  });

  it("shows a network error", async () => {
    installFakes(() => {
      throw new TypeError("Failed to fetch");
    });
    renderAt("/");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Network error/));
  });

  it("shows a malformed response as an error", async () => {
    installFakes(() => Response.json({ actors: "nope" }));
    renderAt("/");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Malformed response/));
  });

  it("prompts for the studio key on 401 and retries with it", async () => {
    installFakes((url) => {
      // Test-only key value, not a real secret.
      const ok = fetchCalls.at(-1) !== undefined && localStorage.getItem("actor-kit-studio-key") === "test-key";
      if (!ok) return new Response("Unauthorized", { status: 401 });
      return url.pathname.endsWith("/types")
        ? Response.json({ types: ["counter"] })
        : Response.json({ actors: [actor("counter", "c1")] });
    });
    renderAt("/");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Unauthorized/));
    fireEvent.change(screen.getByTestId("studio-key-input"), { target: { value: "test-key" } });
    fireEvent.click(screen.getByTestId("studio-key-save"));
    await waitFor(() => expect(actorIds()).toEqual(["c1"]));
    expect(screen.getByRole("option", { name: "counter" })).toBeTruthy();
  });
});

describe("Manual connect", () => {
  beforeEach(() => {
    installFakes((url) => {
      if (url.pathname === "/__studio/api/actors") return Response.json({ actors: [] });
      if (url.pathname === "/__studio/api/actors/types") return Response.json({ types: [] });
      throw new TypeError("Failed to fetch");
    });
  });

  it("is disabled until both type and id are filled", async () => {
    renderAt("/");
    await waitFor(() => expect(screen.getByTestId("manual-connect")).toBeTruthy());
    expect(screen.getByTestId("manual-connect")).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByTestId("manual-type"), { target: { value: "counter" } });
    fireEvent.change(screen.getByTestId("manual-id"), { target: { value: "   " } });
    expect(screen.getByTestId("manual-connect")).toHaveProperty("disabled", true);
  });

  it("navigates to the actor detail page with trimmed values", async () => {
    const { router } = renderAt("/");
    await waitFor(() => expect(screen.getByTestId("manual-type")).toBeTruthy());
    fireEvent.change(screen.getByTestId("manual-type"), { target: { value: " counter " } });
    fireEvent.change(screen.getByTestId("manual-id"), { target: { value: " a1 " } });
    fireEvent.click(screen.getByTestId("manual-connect"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/actors/counter/a1"));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    expect(FakeWebSocket.latest().url).toMatch(/\/__studio\/actors\/counter\/a1\/ws$/);
  });

  it("submits on Enter", async () => {
    const { router } = renderAt("/");
    await waitFor(() => expect(screen.getByTestId("manual-type")).toBeTruthy());
    fireEvent.change(screen.getByTestId("manual-type"), { target: { value: "counter" } });
    fireEvent.change(screen.getByTestId("manual-id"), { target: { value: "a1" } });
    fireEvent.submit(screen.getByTestId("manual-id"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/actors/counter/a1"));
  });

  it("round-trips an id containing slashes, spaces and unicode", async () => {
    renderAt("/");
    await waitFor(() => expect(screen.getByTestId("manual-type")).toBeTruthy());
    fireEvent.change(screen.getByTestId("manual-type"), { target: { value: "counter" } });
    fireEvent.change(screen.getByTestId("manual-id"), { target: { value: "room/1 é?#" } });
    fireEvent.click(screen.getByTestId("manual-connect"));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    expect(FakeWebSocket.latest().url).toContain(`/actors/counter/${encodeURIComponent("room/1 é?#")}/ws`);
    await act(async () => {
      FakeWebSocket.latest().serverOpen();
      FakeWebSocket.latest().serverSend({
        type: "studio.snapshot",
        state: {},
        timeline: [],
        connections: [],
        outbox: [],
        activeLinks: [],
        linkSubscribers: [],
        actorType: "counter",
        actorId: "x",
        version: 1,
      });
    });
    expect(screen.getByTestId("actor-title").textContent).toContain("room/1 é?#");
  });
});
