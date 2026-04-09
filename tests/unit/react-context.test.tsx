/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen, act } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActorClient } from "@actor-kit/client";
import { createActorContext } from "@actor-kit/react";

// --- Fake client that matches ActorClient interface ---
function createFakeClient() {
  let view: unknown = undefined;
  let role: string | undefined = undefined;
  let connectionState: "connecting" | "connected" | "disconnected" = "connecting";
  const viewListeners = new Set<(v: unknown) => void>();
  const stateListeners = new Set<(s: "connecting" | "connected" | "disconnected" | "reconnecting") => void>();

  return {
    get connectionState() {
      return connectionState;
    },
    get view() {
      return view;
    },
    get role() {
      return role;
    },
    subscribe(fn: (v: unknown) => void) {
      viewListeners.add(fn);
      return () => {
        viewListeners.delete(fn);
      };
    },
    onStateChange(fn: (s: "connecting" | "connected" | "disconnected" | "reconnecting") => void) {
      stateListeners.add(fn);
      return () => {
        stateListeners.delete(fn);
      };
    },
    send: vi.fn(),
    trigger: vi.fn(),
    connect: vi.fn(),
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("createActorContext — React SDK", () => {
  it("creates a context with Provider and hooks", () => {
    const ctx = createActorContext();
    expect(ctx.Provider).toBeDefined();
    expect(ctx.useView).toBeDefined();
    expect(ctx.useSend).toBeDefined();
    expect(ctx.useRole).toBeDefined();
    expect(ctx.useConnectionState).toBeDefined();
    expect(ctx.useSelector).toBeDefined();
  });

  it("Provider renders children and useView returns view data", async () => {
    const fake = createFakeClient();
    const ctx = createActorContext();

    function Child() {
      const view = ctx.useView();
      return React.createElement("div", { "data-testid": "view" }, JSON.stringify(view));
    }

    render(
      React.createElement(ctx.Provider, {
        client: fake as unknown as ActorClient,
        children: React.createElement(Child),
      }),
    );

    // Simulate server sending snapshot
    act(() => {
      fake._setView({ count: 42 }, "user");
    });

    expect(screen.getByTestId("view").textContent).toContain("42");
  });

  it("useSend returns a function that delegates to client.send", () => {
    const fake = createFakeClient();
    const ctx = createActorContext();
    let sendFn: ReturnType<typeof ctx.useSend> | undefined;

    function Child() {
      sendFn = ctx.useSend();
      return null;
    }

    render(
      React.createElement(ctx.Provider, {
        client: fake as unknown as ActorClient,
        children: React.createElement(Child),
      }),
    );

    expect(sendFn).toBeDefined();
    sendFn!({ type: "INCREMENT", amount: 5 });
    expect(fake.send).toHaveBeenCalledWith({ type: "INCREMENT", amount: 5 });
  });

  it("useRole returns current role", () => {
    const fake = createFakeClient();
    const ctx = createActorContext();
    let currentRole: string | undefined;

    function Child() {
      currentRole = ctx.useRole();
      return null;
    }

    render(
      React.createElement(ctx.Provider, {
        client: fake as unknown as ActorClient,
        children: React.createElement(Child),
      }),
    );

    act(() => {
      fake._setView({ count: 0 }, "admin");
    });

    expect(currentRole).toBe("admin");
  });

  it("useSelector preserves selected value when unrelated state changes", () => {
    const fake = createFakeClient();
    const ctx = createActorContext();

    function Child() {
      const count = ctx.useSelector((v) => (v as { count?: number })?.count ?? 0);
      return React.createElement("div", { "data-testid": "count" }, String(count));
    }

    render(
      React.createElement(ctx.Provider, {
        client: fake as unknown as ActorClient,
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
});
