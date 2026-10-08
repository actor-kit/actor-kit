/**
 * @vitest-environment jsdom
 *
 * useStudioWs: backoff timing, stale sockets within one actor's session,
 * the HTTP probe after a socket that never opened, and teardown. WebSocket
 * and fetch are fakes at the global boundary.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioApiError } from "../../packages/studio/ui/src/api";
import {
  describeRequestFailure,
  reconnectDelay,
  studioSocketUrl,
  useStudioWs,
} from "../../packages/studio/ui/src/hooks/use-studio-ws";
import { FakeWebSocket } from "./studio-ui-pages.helpers";

type Pending = { url: string; signal: AbortSignal | undefined; resolve: (r: Response) => void };
let pending: Pending[] = [];
let route: ((url: string) => Response) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  pending = [];
  route = null;
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("fetch", (input: string, init?: RequestInit) => {
    const url = String(input);
    if (route !== null) return Promise.resolve(route(url));
    return new Promise<Response>((resolve) => pending.push({ url, signal: init?.signal ?? undefined, resolve }));
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const inspectBody = {
  state: { n: 1 },
  version: 1,
  actorId: "a1",
  connections: [],
  outbox: [],
  activeLinks: [],
  linkSubscribers: [],
};

function snapshot(n: number) {
  return { type: "studio.snapshot", ...inspectBody, state: { n }, timeline: [], actorType: "counter", actorId: "a1" };
}

function httpOk(url: string): Response {
  return Response.json(url.endsWith("/timeline") ? { entries: [], hasMore: false } : inspectBody);
}

async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("pure helpers", () => {
  it.each([
    [0, 500],
    [1, 1_000],
    [2, 2_000],
    [4, 8_000],
    [5, 10_000],
    [30, 10_000],
  ])("reconnect attempt %i waits %i ms", (attempt, ms) => {
    expect(reconnectDelay(attempt)).toBe(ms);
  });

  it("builds ws: and wss: URLs on the page host with encoded segments", () => {
    expect(studioSocketUrl({ protocol: "http:", host: "localhost:8787" }, "chat room", "a/1")).toBe(
      "ws://localhost:8787/__studio/actors/chat%20room/a%2F1/ws",
    );
    expect(studioSocketUrl({ protocol: "https:", host: "app.example" }, "counter", "a1")).toBe(
      "wss://app.example/__studio/actors/counter/a1/ws",
    );
  });

  it("classifies request failures", () => {
    expect(describeRequestFailure(new StudioApiError("unauthorized", "Unauthorized", 401))).toEqual({
      error: "Unauthorized",
      failure: "permanent",
    });
    expect(describeRequestFailure(new StudioApiError("not-found", "gone", 404))).toEqual({
      error: "gone",
      failure: "not-found",
    });
    expect(describeRequestFailure(new StudioApiError("server", "boom", 500))).toEqual({
      error: "boom",
      failure: "transient",
    });
    expect(describeRequestFailure(new TypeError("odd"))).toEqual({ error: "odd", failure: "transient" });
    expect(describeRequestFailure("weird")).toEqual({ error: "Request failed", failure: "transient" });
  });
});

describe("useStudioWs", () => {
  it("reports connected only while live", () => {
    const { result } = renderHook(() => useStudioWs("counter", "a1"));
    expect(result.current.connected).toBe(false);
    act(() => FakeWebSocket.latest().serverOpen());
    expect(result.current.connected).toBe(true);
    act(() => FakeWebSocket.latest().serverDrop());
    expect(result.current.connected).toBe(false);
  });

  it("doubles the wait between failed attempts, and resets it after a successful open", async () => {
    route = () => {
      throw new TypeError("Failed to fetch");
    };
    renderHook(() => useStudioWs("counter", "a1"));
    const waits: number[] = [];
    for (let k = 0; k < 3; k++) {
      act(() => FakeWebSocket.latest().serverDrop());
      await flush();
      const before = FakeWebSocket.instances.length;
      let waited = 0;
      while (FakeWebSocket.instances.length === before) {
        await advance(250);
        waited += 250;
      }
      waits.push(waited);
    }
    expect(waits).toEqual([500, 1_000, 2_000]);

    act(() => FakeWebSocket.latest().serverOpen());
    act(() => FakeWebSocket.latest().serverDrop());
    const before = FakeWebSocket.instances.length;
    await advance(499);
    expect(FakeWebSocket.instances).toHaveLength(before);
    await advance(1);
    expect(FakeWebSocket.instances).toHaveLength(before + 1);
  });

  it("ignores a late open, message or close from a socket it already replaced", async () => {
    const { result } = renderHook(() => useStudioWs("counter", "a1"));
    const first = FakeWebSocket.latest();
    act(() => {
      first.serverOpen();
      first.serverSend(snapshot(1));
      first.serverDrop();
    });
    await advance(500);
    const second = FakeWebSocket.latest();
    expect(second).not.toBe(first);
    act(() => {
      first.serverOpen();
      first.serverSend(snapshot(99));
      first.serverSend("not json");
    });
    expect(result.current.status).toBe("reconnecting");
    expect(result.current.inspect?.state).toEqual({ n: 1 });
    expect(result.current.error).toBeNull();
    act(() => first.serverDrop());
    await advance(10_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("shows HTTP data while polling and retries the socket after the first delay", async () => {
    route = httpOk;
    const { result } = renderHook(() => useStudioWs("counter", "a1"));
    act(() => FakeWebSocket.latest().serverDrop());
    await flush();
    expect(result.current.status).toBe("polling");
    expect(result.current.inspect?.state).toEqual({ n: 1 });
    await advance(499);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await advance(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("stops retrying after a permanent failure", async () => {
    route = () => Response.json({ error: "nope" }, { status: 403 });
    const { result } = renderHook(() => useStudioWs("counter", "a1"));
    act(() => FakeWebSocket.latest().serverDrop());
    await flush();
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("nope");
    await advance(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("keeps retrying after a not-found or server failure", async () => {
    route = () => Response.json({ error: "missing" }, { status: 404 });
    const { result } = renderHook(() => useStudioWs("counter", "a1"));
    act(() => FakeWebSocket.latest().serverDrop());
    await flush();
    expect(result.current.status).toBe("not-found");
    await advance(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("aborts an in-flight probe on unmount and ignores its late answer", async () => {
    const { result, unmount } = renderHook(() => useStudioWs("counter", "a1"));
    act(() => FakeWebSocket.latest().serverDrop());
    await flush();
    expect(pending).toHaveLength(2);
    unmount();
    expect(pending.every((p) => p.signal?.aborted === true)).toBe(true);
    await act(async () => {
      for (const p of pending) p.resolve(httpOk(p.url));
    });
    await advance(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(result.current.inspect).toBeNull();
  });

  it("ignores a late probe failure after unmount", async () => {
    const { unmount } = renderHook(() => useStudioWs("counter", "a1"));
    act(() => FakeWebSocket.latest().serverDrop());
    await flush();
    unmount();
    await act(async () => {
      for (const p of pending) p.resolve(Response.json({ error: "down" }, { status: 500 }));
    });
    await advance(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("cancels a scheduled reconnect on unmount and closes nothing twice", async () => {
    const { unmount } = renderHook(() => useStudioWs("counter", "a1"));
    const ws = FakeWebSocket.latest();
    act(() => {
      ws.serverOpen();
      ws.serverDrop();
    });
    unmount();
    expect(ws.closeCalls).toBe(0);
    await advance(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("unmounts cleanly while waiting to reconnect (no socket to close)", () => {
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent) => {
      errors.push(e.error);
      e.preventDefault();
    };
    window.addEventListener("error", onError);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { unmount } = renderHook(() => useStudioWs("counter", "a1"));
      act(() => {
        FakeWebSocket.latest().serverOpen();
        FakeWebSocket.latest().serverDrop();
      });
      unmount();
      expect(errors).toEqual([]);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("error", onError);
      consoleError.mockRestore();
    }
  });

  it("closes the open socket with a normal close code on unmount", () => {
    const { unmount } = renderHook(() => useStudioWs("counter", "a1"));
    const ws = FakeWebSocket.latest();
    const close = vi.spyOn(ws, "close");
    act(() => ws.serverOpen());
    unmount();
    expect(close).toHaveBeenCalledWith(1000, "studio view closed");
  });

  it("starts over from a clean state when the actor changes", () => {
    const { result, rerender } = renderHook(({ id }) => useStudioWs("counter", id), { initialProps: { id: "a1" } });
    act(() => {
      FakeWebSocket.latest().serverOpen();
      FakeWebSocket.latest().serverSend(snapshot(3));
    });
    rerender({ id: "a2" });
    expect(result.current).toEqual({ inspect: null, timeline: [], status: "connecting", error: null, connected: false });
    expect(FakeWebSocket.latest().url).toMatch(/\/actors\/counter\/a2\/ws$/);
  });
});
