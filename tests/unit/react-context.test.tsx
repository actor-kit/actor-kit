/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen, act } from "@testing-library/react";
import React, { type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createActorContext } from "../../packages/actor-kit/src/react/context";

// --- Fake client to inject ---
function createFakeClient() {
  let view: unknown = undefined;
  let role: string | undefined = undefined;
  let connectionState: "connecting" | "connected" | "disconnected" = "connecting";
  const viewListeners = new Set<(v: unknown) => void>();
  const stateListeners = new Set<(s: string) => void>();

  return {
    get connectionState() { return connectionState; },
    get view() { return view; },
    get role() { return role; },
    subscribe(fn: (v: unknown) => void) {
      viewListeners.add(fn);
      return () => { viewListeners.delete(fn); };
    },
    onStateChange(fn: (s: string) => void) {
      stateListeners.add(fn);
      return () => { stateListeners.delete(fn); };
    },
    send: vi.fn(),
    trigger: vi.fn(),
    disconnect: vi.fn(),
    // Test helpers
    _setView(v: unknown, r: string) {
      view = v;
      role = r;
      connectionState = "connected";
      for (const fn of viewListeners) fn(v);
    },
    _setConnectionState(s: "connecting" | "connected" | "disconnected") {
      connectionState = s;
      for (const fn of stateListeners) fn(s);
    },
  };
}

// We need to mock createActorClient to return our fake
vi.mock("../../packages/actor-kit/src/client/client", () => {
  return {
    createActorClient: vi.fn(),
  };
});

import { createActorClient } from "../../packages/actor-kit/src/client/client";
const mockCreateClient = vi.mocked(createActorClient);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("createActorContext — React SDK", () => {
  it("creates a context with Provider and hooks", () => {
    const ctx = createActorContext("counter");
    expect(ctx.Provider).toBeDefined();
    expect(ctx.useView).toBeDefined();
    expect(ctx.useSend).toBeDefined();
    expect(ctx.useRole).toBeDefined();
    expect(ctx.useConnectionState).toBeDefined();
    expect(ctx.useSelector).toBeDefined();
  });

  it("Provider renders children after client connects", async () => {
    const fake = createFakeClient();
    mockCreateClient.mockReturnValue(fake as ReturnType<typeof createActorClient>);

    const ctx = createActorContext("counter");

    function Child() {
      const view = ctx.useView();
      return React.createElement("div", { "data-testid": "view" }, JSON.stringify(view));
    }

    render(
      React.createElement(ctx.Provider, {
        actorId: "test",
        host: "example.com",
        accessToken: "token",
        children: React.createElement(Child),
      }),
    );

    // Provider initially returns null while client is created via useEffect
    // After effect runs, child renders with undefined view
    await act(async () => {});
    // View should be undefined initially (stringified as empty or "undefined")
    const initial = screen.queryByTestId("view")?.textContent ?? "";
    expect(initial === "" || initial === "undefined" || initial === "null").toBe(true);

    // Simulate server sending snapshot
    act(() => {
      fake._setView({ count: 42 }, "user");
    });

    expect(screen.getByTestId("view").textContent).toContain("42");
  });

  it("useSend returns a function that delegates to client.send", async () => {
    const fake = createFakeClient();
    mockCreateClient.mockReturnValue(fake as ReturnType<typeof createActorClient>);

    const ctx = createActorContext("counter");
    let sendFn: ReturnType<typeof ctx.useSend> | undefined;

    function Child() {
      sendFn = ctx.useSend();
      return null;
    }

    render(
      React.createElement(ctx.Provider, {
        actorId: "test",
        host: "example.com",
        accessToken: "token",
        children: React.createElement(Child),
      }),
    );

    act(() => {
      fake._setView({}, "user");
    });

    expect(sendFn).toBeDefined();
    sendFn!({ type: "INCREMENT", amount: 5 });
    expect(fake.send).toHaveBeenCalledWith({ type: "INCREMENT", amount: 5 });
  });

  it("useRole returns current role", async () => {
    const fake = createFakeClient();
    mockCreateClient.mockReturnValue(fake as ReturnType<typeof createActorClient>);

    const ctx = createActorContext("counter");
    let currentRole: string | undefined;

    function Child() {
      currentRole = ctx.useRole();
      return null;
    }

    render(
      React.createElement(ctx.Provider, {
        actorId: "test",
        host: "example.com",
        accessToken: "token",
        children: React.createElement(Child),
      }),
    );

    act(() => {
      fake._setView({ count: 0 }, "admin");
    });

    expect(currentRole).toBe("admin");
  });

  it("useSelector preserves selected value when unrelated state changes", async () => {
    const fake = createFakeClient();
    mockCreateClient.mockReturnValue(fake as ReturnType<typeof createActorClient>);

    const ctx = createActorContext("counter");

    function Child() {
      const count = ctx.useSelector((v) => (v as { count?: number })?.count ?? 0);
      return React.createElement("div", { "data-testid": "count" }, String(count));
    }

    render(
      React.createElement(ctx.Provider, {
        actorId: "test",
        host: "example.com",
        accessToken: "token",
        children: React.createElement(Child),
      }),
    );

    act(() => {
      fake._setView({ count: 5 }, "user");
    });

    expect(screen.getByTestId("count").textContent).toBe("5");

    // Same count, different other field — selected value should stay the same
    act(() => {
      fake._setView({ count: 5, other: "changed" }, "user");
    });

    expect(screen.getByTestId("count").textContent).toBe("5");

    // Different count — should update
    act(() => {
      fake._setView({ count: 10 }, "user");
    });

    expect(screen.getByTestId("count").textContent).toBe("10");
  });

  it("disconnects on unmount", async () => {
    const fake = createFakeClient();
    mockCreateClient.mockReturnValue(fake as ReturnType<typeof createActorClient>);

    const ctx = createActorContext("counter");

    const { unmount } = render(
      React.createElement(ctx.Provider, {
        actorId: "test",
        host: "example.com",
        accessToken: "token",
        children: React.createElement("div"),
      }),
    );

    unmount();
    expect(fake.disconnect).toHaveBeenCalled();
  });
});
