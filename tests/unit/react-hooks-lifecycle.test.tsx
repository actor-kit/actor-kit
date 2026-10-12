/**
 * @vitest-environment jsdom
 */
import type { ActorClient, ConnectionState, WebSocketConstructor, WebSocketLike } from "@actor-kit/client";
import { createActorContext } from "@actor-kit/react";
import { act, cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

type View = { n: number };
type Event = { type: "INC" };

/** A fake ActorClient. `readView` lets a test change what `view` returns from one read to the next. */
function fakeClient(initial: View, initialRole?: string) {
  let view = initial;
  let role = initialRole;
  let connectionState: ConnectionState = "connecting";
  const viewListeners = new Set<(v: View) => void>();
  const stateListeners = new Set<(s: ConnectionState) => void>();
  let readView: () => View = () => view;
  const client: ActorClient<View, Event> = {
    get connectionState() {
      return connectionState;
    },
    get view() {
      return readView();
    },
    get role() {
      return role;
    },
    subscribe(fn) {
      viewListeners.add(fn);
      return () => viewListeners.delete(fn);
    },
    onStateChange(fn) {
      stateListeners.add(fn);
      return () => stateListeners.delete(fn);
    },
    send: () => {},
    trigger: () => {},
    connect: () => {},
    disconnect: () => {},
  };
  return {
    client,
    emit(next: View, nextRole?: string) {
      view = next;
      role = nextRole;
      for (const fn of viewListeners) fn(next);
    },
    setState(s: ConnectionState) {
      connectionState = s;
      for (const fn of stateListeners) fn(s);
    },
    setReadView(fn: () => View) {
      readView = fn;
    },
    listenerCount: () => viewListeners.size + stateListeners.size,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const Ctx = createActorContext<View, Event>();

function ViewProbe({ seen }: { seen: unknown[] }) {
  const view = Ctx.useView();
  seen.push(view);
  return <span data-testid="view">{view.n}</span>;
}

function RoleProbe() {
  return <span data-testid="role">{Ctx.useRole() ?? "none"}</span>;
}

function StateProbe() {
  return <span data-testid="state">{Ctx.useConnectionState()}</span>;
}

function SelectorProbe({ seen }: { seen: unknown[] }) {
  const doubled = Ctx.useSelector(selectDouble);
  seen.push(doubled);
  return <span data-testid="sel">{doubled}</span>;
}
const selectDouble = (v: View) => v.n * 2;

describe("hooks outside a Provider", () => {
  it.each([
    ["useView", () => Ctx.useView()],
    ["useSend", () => Ctx.useSend()],
    ["useRole", () => Ctx.useRole()],
  ])("%s throws a helpful error", (_name, hook) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Bad() {
      hook();
      return null;
    }
    expect(() => render(<Bad />)).toThrow("useView/useSend/useRole must be used inside <Provider>");
  });

  it.each([
    ["useView", () => Ctx.useView()],
    ["useSend", () => Ctx.useSend()],
    ["useRole", () => Ctx.useRole()],
  ])("%s outside a Provider is a missing_provider error", (_name, hook) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Bad() {
      hook();
      return null;
    }
    expect(() => render(<Bad />)).toThrow(expect.objectContaining({ code: "missing_provider" }));
  });
});

describe("useView", () => {
  it("renders the client's current view on the very first render", () => {
    const f = fakeClient({ n: 1 });
    const seen: unknown[] = [];
    render(
      <Ctx.Provider client={f.client}>
        <ViewProbe seen={seen} />
      </Ctx.Provider>,
    );
    expect(seen[0]).toEqual({ n: 1 });
  });

  it("catches up with a view that changed between render and subscribe", () => {
    const f = fakeClient({ n: 1 });
    let reads = 0;
    f.setReadView(() => (++reads === 1 ? { n: 1 } : { n: 5 }));
    render(
      <Ctx.Provider client={f.client}>
        <ViewProbe seen={[]} />
      </Ctx.Provider>,
    );
    expect(screen.getByTestId("view").textContent).toBe("5");
  });

  it("follows a new client given to the Provider", () => {
    const a = fakeClient({ n: 1 });
    const b = fakeClient({ n: 9 });
    const { rerender } = render(
      <Ctx.Provider client={a.client}>
        <ViewProbe seen={[]} />
      </Ctx.Provider>,
    );
    rerender(
      <Ctx.Provider client={b.client}>
        <ViewProbe seen={[]} />
      </Ctx.Provider>,
    );
    expect(screen.getByTestId("view").textContent).toBe("9");
    act(() => b.emit({ n: 10 }));
    expect(screen.getByTestId("view").textContent).toBe("10");
    expect(a.listenerCount()).toBe(0);
  });
});

describe("useRole", () => {
  it("starts from the client's role and follows changes", () => {
    const f = fakeClient({ n: 1 }, "player");
    render(
      <Ctx.Provider client={f.client}>
        <RoleProbe />
      </Ctx.Provider>,
    );
    expect(screen.getByTestId("role").textContent).toBe("player");
    act(() => f.emit({ n: 2 }, "admin"));
    expect(screen.getByTestId("role").textContent).toBe("admin");
    act(() => f.emit({ n: 3 }, "player"));
    expect(screen.getByTestId("role").textContent).toBe("player");
  });

  it("follows a new client given to the Provider", () => {
    const a = fakeClient({ n: 1 }, "player");
    const b = fakeClient({ n: 1 }, "player");
    const { rerender } = render(
      <Ctx.Provider client={a.client}>
        <RoleProbe />
      </Ctx.Provider>,
    );
    rerender(
      <Ctx.Provider client={b.client}>
        <RoleProbe />
      </Ctx.Provider>,
    );
    act(() => b.emit({ n: 2 }, "admin"));
    expect(screen.getByTestId("role").textContent).toBe("admin");
  });
});

describe("useConnectionState", () => {
  it("starts from the client's state and follows changes", () => {
    const f = fakeClient({ n: 1 });
    render(
      <Ctx.Provider client={f.client}>
        <StateProbe />
      </Ctx.Provider>,
    );
    expect(screen.getByTestId("state").textContent).toBe("connecting");
    act(() => f.setState("connected"));
    expect(screen.getByTestId("state").textContent).toBe("connected");
  });

  it("follows a new client and unsubscribes from the old one", () => {
    const a = fakeClient({ n: 1 });
    const b = fakeClient({ n: 1 });
    const { rerender } = render(
      <Ctx.Provider client={a.client}>
        <StateProbe />
      </Ctx.Provider>,
    );
    rerender(
      <Ctx.Provider client={b.client}>
        <StateProbe />
      </Ctx.Provider>,
    );
    act(() => b.setState("reconnecting"));
    expect(screen.getByTestId("state").textContent).toBe("reconnecting");
    expect(a.listenerCount()).toBe(0);
  });
});

describe("useSelector", () => {
  it("selects from the current view on the very first render", () => {
    const f = fakeClient({ n: 2 });
    const seen: unknown[] = [];
    render(
      <Ctx.Provider client={f.client}>
        <SelectorProbe seen={seen} />
      </Ctx.Provider>,
    );
    expect(seen[0]).toBe(4);
  });

  it("follows a new client given to the Provider", () => {
    const a = fakeClient({ n: 1 });
    const b = fakeClient({ n: 1 });
    const { rerender } = render(
      <Ctx.Provider client={a.client}>
        <SelectorProbe seen={[]} />
      </Ctx.Provider>,
    );
    rerender(
      <Ctx.Provider client={b.client}>
        <SelectorProbe seen={[]} />
      </Ctx.Provider>,
    );
    act(() => b.emit({ n: 7 }));
    expect(screen.getByTestId("sel").textContent).toBe("14");
  });
});

describe("useClient", () => {
  const sockets: { url: string; closed: boolean }[] = [];
  class FakeSocket implements WebSocketLike {
    readonly readyState = 0;
    binaryType = "blob";
    private readonly record: { url: string; closed: boolean };
    constructor(url: string) {
      this.record = { url, closed: false };
      sockets.push(this.record);
    }
    send() {}
    close() {
      this.record.closed = true;
    }
    addEventListener() {}
  }
  const WebSocketImpl: WebSocketConstructor = FakeSocket;

  it("creates one client, connects it on mount and disconnects it on unmount", async () => {
    sockets.length = 0;
    const clients: ActorClient<View, Event>[] = [];
    function Owner() {
      const client = Ctx.useClient({ path: "/api/c/1", host: "h.example", initialView: { n: 3 }, WebSocketImpl });
      clients.push(client);
      return <span data-testid="owned">{client.view.n}</span>;
    }
    const { rerender, unmount } = render(<Owner />);
    rerender(<Owner />);
    expect(screen.getByTestId("owned").textContent).toBe("3");
    expect(clients[0]).toBe(clients[clients.length - 1]);
    expect(clients[0]?.connectionState).toBe("connecting");
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(sockets[0]?.url).toContain("h.example/api/c/1");
    unmount();
    expect(clients[0]?.connectionState).toBe("disconnected");
    expect(sockets[0]?.closed).toBe(true);
  });
});
