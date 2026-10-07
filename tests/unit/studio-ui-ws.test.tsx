/**
 * @vitest-environment jsdom
 *
 * useStudioWs — the Studio UI's live connection to one actor.
 * WebSocket and fetch are replaced at the global boundary with fakes.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStudioWs } from "../../packages/studio/ui/src/hooks/use-studio-ws";

// --- Fakes ---

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readyState = 0;
  closeCalls = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.closeCalls++;
    this.readyState = 3;
  }

  // --- test controls ---
  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  serverSend(data: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: typeof data === "string" ? data : JSON.stringify(data) }));
  }
  serverDrop(): void {
    this.readyState = 3;
    this.onerror?.(new Event("error"));
    this.onclose?.(new CloseEvent("close", { code: 1006 }));
  }

  static latest(): FakeWebSocket {
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (ws === undefined) throw new Error("no socket created");
    return ws;
  }
  static live(): FakeWebSocket[] {
    return FakeWebSocket.instances.filter((ws) => ws.closeCalls === 0 && ws.readyState !== 3);
  }
}

type FetchRoute = (url: string) => Response | Promise<Response>;
let fetchRoute: FetchRoute = () => {
  throw new TypeError("Failed to fetch");
};

function entry(id: number, state: unknown, causeType = "message", cause: Record<string, unknown> = {}) {
  return {
    id,
    causeType,
    causeData: JSON.stringify({ caller: "u1", messageType: "INC", ...cause }),
    stateSnapshot: JSON.stringify(state),
    checksum: "c",
    createdAt: 1_000 + id,
  };
}

function snapshot(count: number, timeline: ReturnType<typeof entry>[] = [entry(1, { count })]) {
  return {
    type: "studio.snapshot",
    state: { count },
    timeline,
    connections: [],
    outbox: [],
    activeLinks: [],
    linkSubscribers: [],
    actorType: "counter",
    actorId: "a1",
    version: 1,
  };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("fetch", (input: string) => Promise.resolve().then(() => fetchRoute(String(input))));
  fetchRoute = () => {
    throw new TypeError("Failed to fetch");
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useStudioWs", () => {
  it("opens one socket to the actor's studio endpoint", () => {
    renderHook(() => useStudioWs("counter", "a 1"));
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.latest().url).toMatch(/\/__studio\/actors\/counter\/a%201\/ws$/);
  });

  it("applies the snapshot with parsed timeline state", () => {
    const { result } = renderHook(() => useStudioWs("counter", "a1"));
    act(() => {
      FakeWebSocket.latest().serverOpen();
      FakeWebSocket.latest().serverSend(snapshot(3, [entry(2, { count: 3 }), entry(1, { count: 2 })]));
    });
    expect(result.current.status).toBe("live");
    expect(result.current.inspect?.state).toEqual({ count: 3 });
    expect(result.current.timeline.map((e) => e.id)).toEqual([2, 1]);
    expect(result.current.timeline[0]?.state).toEqual({ count: 3 });
    expect(result.current.timeline[0]?.cause).toEqual({ caller: "u1", messageType: "INC" });
  });

  it("prepends live timeline entries and updates state", () => {
    const { result } = renderHook(() => useStudioWs("counter", "a1"));
    act(() => {
      FakeWebSocket.latest().serverOpen();
      FakeWebSocket.latest().serverSend(snapshot(1));
      FakeWebSocket.latest().serverSend({ type: "studio.timeline", entry: entry(2, { count: 2 }) });
    });
    expect(result.current.timeline.map((e) => e.id)).toEqual([2, 1]);
    expect(result.current.inspect?.state).toEqual({ count: 2 });
  });

  it("does not duplicate a live entry the snapshot already contains", () => {
    const { result } = renderHook(() => useStudioWs("counter", "a1"));
    act(() => {
      FakeWebSocket.latest().serverOpen();
      FakeWebSocket.latest().serverSend(snapshot(2, [entry(2, { count: 2 }), entry(1, { count: 1 })]));
      FakeWebSocket.latest().serverSend({ type: "studio.timeline", entry: entry(2, { count: 2 }) });
    });
    expect(result.current.timeline.map((e) => e.id)).toEqual([2, 1]);
  });

  it("surfaces a non-JSON frame as an error and keeps the last good data", () => {
    const { result } = renderHook(() => useStudioWs("counter", "a1"));
    act(() => {
      FakeWebSocket.latest().serverOpen();
      FakeWebSocket.latest().serverSend(snapshot(4));
      FakeWebSocket.latest().serverSend("{not json");
    });
    expect(result.current.error).toMatch(/not valid JSON/);
    expect(result.current.inspect?.state).toEqual({ count: 4 });
  });

  it("surfaces a timeline frame with an unparseable state snapshot as an error, without throwing", () => {
    const { result } = renderHook(() => useStudioWs("counter", "a1"));
    act(() => {
      FakeWebSocket.latest().serverOpen();
      FakeWebSocket.latest().serverSend(snapshot(4));
      FakeWebSocket.latest().serverSend({
        type: "studio.timeline",
        entry: { ...entry(2, {}), stateSnapshot: "{broken" },
      });
    });
    expect(result.current.error).toMatch(/studio\.timeline/);
    expect(result.current.inspect?.state).toEqual({ count: 4 });
    expect(result.current.timeline.map((e) => e.id)).toEqual([1]);
  });

  it("surfaces a snapshot with the wrong shape as an error", () => {
    const { result } = renderHook(() => useStudioWs("counter", "a1"));
    act(() => {
      FakeWebSocket.latest().serverOpen();
      FakeWebSocket.latest().serverSend({ type: "studio.snapshot", state: {} });
    });
    expect(result.current.error).toMatch(/studio\.snapshot/);
    expect(result.current.inspect).toBeNull();
  });

  it("ignores frame types it does not render (studio.view)", () => {
    const { result } = renderHook(() => useStudioWs("counter", "a1"));
    act(() => {
      FakeWebSocket.latest().serverOpen();
      FakeWebSocket.latest().serverSend(snapshot(1));
      FakeWebSocket.latest().serverSend({ type: "studio.view", role: "user", view: {} });
    });
    expect(result.current.error).toBeNull();
  });

  it("upserts connections by connectionId and removes them on disconnect", () => {
    const { result } = renderHook(() => useStudioWs("counter", "a1"));
    const conn = { connectionId: "c1", caller: "u1", callerType: "user", connectedAt: 5, role: "user" };
    act(() => {
      FakeWebSocket.latest().serverOpen();
      FakeWebSocket.latest().serverSend(snapshot(1));
      FakeWebSocket.latest().serverSend({ type: "studio.connection", action: "connect", connection: conn });
      FakeWebSocket.latest().serverSend({
        type: "studio.connection",
        action: "connect",
        connection: { ...conn, connectedAt: 6 },
      });
    });
    expect(result.current.inspect?.connections).toEqual([{ ...conn, connectedAt: 6 }]);
    act(() => {
      FakeWebSocket.latest().serverSend({
        type: "studio.connection",
        action: "disconnect",
        connection: { connectionId: "c1", caller: "u1", callerType: "user" },
      });
    });
    expect(result.current.inspect?.connections).toEqual([]);
  });

  it("lists every socket as its own connection: two tabs of one caller are two rows, one tab closing removes one", () => {
    const { result } = renderHook(() => useStudioWs("counter", "a1"));
    const tab1 = { connectionId: "c1", caller: "u1", callerType: "user", connectedAt: 5, role: "user" };
    const tab2 = { ...tab1, connectionId: "c2", connectedAt: 6 };
    act(() => {
      FakeWebSocket.latest().serverOpen();
      FakeWebSocket.latest().serverSend(snapshot(1));
      FakeWebSocket.latest().serverSend({ type: "studio.connection", action: "connect", connection: tab1 });
      FakeWebSocket.latest().serverSend({ type: "studio.connection", action: "connect", connection: tab2 });
    });
    expect(result.current.inspect?.connections).toEqual([tab1, tab2]);
    act(() => {
      FakeWebSocket.latest().serverSend({
        type: "studio.connection",
        action: "disconnect",
        connection: { connectionId: "c1", caller: "u1", callerType: "user" },
      });
    });
    expect(result.current.inspect?.connections).toEqual([tab2]);
    expect(result.current.error).toBeNull();
  });

  it("treats a connection frame without a connectionId as malformed", () => {
    const { result } = renderHook(() => useStudioWs("counter", "a1"));
    act(() => {
      FakeWebSocket.latest().serverOpen();
      FakeWebSocket.latest().serverSend(snapshot(1));
      FakeWebSocket.latest().serverSend({
        type: "studio.connection",
        action: "connect",
        connection: { caller: "u1", callerType: "user", connectedAt: 5, role: "user" },
      });
    });
    expect(result.current.inspect?.connections).toEqual([]);
    expect(result.current.error).not.toBeNull();
  });

  it("reconnects after the socket drops and replaces the timeline from the new snapshot", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useStudioWs("counter", "a1"));
    act(() => {
      FakeWebSocket.latest().serverOpen();
      FakeWebSocket.latest().serverSend(snapshot(1));
      FakeWebSocket.latest().serverSend({ type: "studio.timeline", entry: entry(2, { count: 2 }) });
    });
    act(() => FakeWebSocket.latest().serverDrop());
    expect(result.current.status).toBe("reconnecting");
    expect(result.current.connected).toBe(false);
    // Last known data stays on screen while reconnecting
    expect(result.current.inspect?.state).toEqual({ count: 2 });

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);

    act(() => {
      FakeWebSocket.latest().serverOpen();
      FakeWebSocket.latest().serverSend(
        snapshot(3, [entry(3, { count: 3 }), entry(2, { count: 2 }), entry(1, { count: 1 })]),
      );
    });
    expect(result.current.status).toBe("live");
    expect(result.current.timeline.map((e) => e.id)).toEqual([3, 2, 1]);
    expect(FakeWebSocket.live()).toHaveLength(1);
  });

  it("backs off between failed reconnect attempts", () => {
    vi.useFakeTimers();
    renderHook(() => useStudioWs("counter", "a1"));
    act(() => {
      FakeWebSocket.latest().serverOpen();
      FakeWebSocket.latest().serverDrop();
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    // Second attempt fails before opening; HTTP probe fails with a network error.
    act(() => FakeWebSocket.latest().serverDrop());
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("closes the socket on unmount and never reconnects afterwards", () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useStudioWs("counter", "a1"));
    const ws = FakeWebSocket.latest();
    act(() => ws.serverOpen());
    unmount();
    expect(ws.closeCalls).toBe(1);
    act(() => ws.serverDrop());
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("cancels a pending reconnect on unmount", () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useStudioWs("counter", "a1"));
    act(() => {
      FakeWebSocket.latest().serverOpen();
      FakeWebSocket.latest().serverDrop();
    });
    unmount();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("ignores frames and close events from the previous actor's socket after switching actors", () => {
    const { result, rerender } = renderHook(({ id }) => useStudioWs("counter", id), {
      initialProps: { id: "a1" },
    });
    const first = FakeWebSocket.latest();
    act(() => {
      first.serverOpen();
      first.serverSend(snapshot(1));
    });
    rerender({ id: "b2" });
    const second = FakeWebSocket.latest();
    expect(second).not.toBe(first);
    expect(first.closeCalls).toBe(1);
    act(() => {
      second.serverOpen();
      second.serverSend({ ...snapshot(9), actorId: "b2" });
      // Late events from the old socket must not leak into the new actor's view
      first.serverSend(snapshot(1));
      first.serverDrop();
    });
    expect(result.current.inspect?.state).toEqual({ count: 9 });
    expect(result.current.status).toBe("live");
  });

  it("shows not-found (404) and keeps polling, going live once the actor is created", async () => {
    vi.useFakeTimers();
    fetchRoute = () => Response.json({ error: 'Actor "counter/a1" not found' }, { status: 404 });
    const { result } = renderHook(() => useStudioWs("counter", "a1"));
    await act(async () => {
      FakeWebSocket.latest().serverDrop();
      await vi.runOnlyPendingTimersAsync();
    });
    expect(result.current.status).toBe("not-found");
    expect(result.current.error).toMatch(/not found/);

    // Still not there on the next attempt
    await act(async () => {
      FakeWebSocket.latest().serverDrop();
      await vi.runOnlyPendingTimersAsync();
    });
    expect(result.current.status).toBe("not-found");

    // The actor now exists: the next socket opens
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    act(() => {
      FakeWebSocket.latest().serverOpen();
      FakeWebSocket.latest().serverSend(snapshot(0));
    });
    expect(result.current.status).toBe("live");
    expect(result.current.error).toBeNull();
    expect(result.current.inspect?.state).toEqual({ count: 0 });
  });

  it.each([
    [401, "Unauthorized"],
    [403, "Forbidden"],
  ])("stops retrying and shows a readable error on %i", async (status, body) => {
    vi.useFakeTimers();
    fetchRoute = () => Response.json({ error: body }, { status });
    const { result } = renderHook(() => useStudioWs("counter", "a1"));
    await act(async () => {
      FakeWebSocket.latest().serverDrop();
      await vi.runOnlyPendingTimersAsync();
    });
    expect(result.current.status).toBe("error");
    expect(result.current.error).toMatch(new RegExp(body));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("falls back to HTTP when the socket cannot open but the API answers", async () => {
    fetchRoute = (url) => {
      if (url.includes("/timeline")) {
        return Response.json({ entries: [entry(1, { count: 7 })], hasMore: false });
      }
      return Response.json({
        state: { count: 7 },
        version: 1,
        actorId: "a1",
        connections: [],
        outbox: [],
        activeLinks: [],
        linkSubscribers: [],
      });
    };
    const { result } = renderHook(() => useStudioWs("counter", "a1"));
    await act(async () => {
      FakeWebSocket.latest().serverDrop();
    });
    await vi.waitFor(() => expect(result.current.status).toBe("polling"));
    expect(result.current.inspect?.state).toEqual({ count: 7 });
    expect(result.current.timeline.map((e) => e.id)).toEqual([1]);
  });

  it("caps the in-memory timeline so a long session does not grow without bound", () => {
    const { result } = renderHook(() => useStudioWs("counter", "a1"));
    act(() => {
      FakeWebSocket.latest().serverOpen();
      FakeWebSocket.latest().serverSend(snapshot(0));
      for (let i = 2; i < 1_200; i++) {
        FakeWebSocket.latest().serverSend({ type: "studio.timeline", entry: entry(i, { count: i }) });
      }
    });
    expect(result.current.timeline.length).toBe(500);
    expect(result.current.timeline[0]?.id).toBe(1_199);
  });
});
