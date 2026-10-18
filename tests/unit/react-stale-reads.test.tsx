/**
 * @vitest-environment jsdom
 */
/**
 * Stale reads in the React hooks: what a component shows must be the client's current view, role
 * and connection state, also when they changed between render and subscribe, when the Provider is
 * given another client, and when a selector changes. A stale read here is a screen behind the room.
 */
import type { ActorClient, ConnectionState } from "@actor-kit/client";
import { createActorContext } from "@actor-kit/react";
import { act, cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";

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
});

const Ctx = createActorContext<View, Event>();

function RoleProbe() {
  return <span data-testid="role">{Ctx.useRole() ?? "none"}</span>;
}

function StateProbe() {
  return <span data-testid="state">{Ctx.useConnectionState()}</span>;
}

function TimesProbe({ factor }: { factor: number }) {
  const selected = Ctx.useSelector((v: View) => v.n * factor);
  return <span data-testid="sel">{selected}</span>;
}

/** Changes what the client reports after the first read: the change lands between render and subscribe. */
function changeAfterFirstRead(f: ReturnType<typeof fakeClient>, next: View, apply: () => void) {
  let reads = 0;
  const first = f.client.view;
  f.setReadView(() => {
    reads++;
    if (reads === 1) return first;
    apply();
    return next;
  });
}

describe("useSelector", () => {
  it("selects with the new selector as soon as it changes, without waiting for a frame", () => {
    const f = fakeClient({ n: 3 });
    const { rerender } = render(
      <Ctx.Provider client={f.client}>
        <TimesProbe factor={2} />
      </Ctx.Provider>,
    );
    expect(screen.getByTestId("sel").textContent).toBe("6");
    rerender(
      <Ctx.Provider client={f.client}>
        <TimesProbe factor={10} />
      </Ctx.Provider>,
    );
    expect(screen.getByTestId("sel").textContent).toBe("30");
  });

  it("shows the new client's view at once when the Provider is given another client", () => {
    const a = fakeClient({ n: 1 });
    const b = fakeClient({ n: 5 });
    const { rerender } = render(
      <Ctx.Provider client={a.client}>
        <TimesProbe factor={2} />
      </Ctx.Provider>,
    );
    rerender(
      <Ctx.Provider client={b.client}>
        <TimesProbe factor={2} />
      </Ctx.Provider>,
    );
    expect(screen.getByTestId("sel").textContent).toBe("10");
    expect(a.listenerCount()).toBe(0);
  });

  it("catches up with a view that changed between render and subscribe", () => {
    const f = fakeClient({ n: 1 });
    changeAfterFirstRead(f, { n: 4 }, () => {});
    render(
      <Ctx.Provider client={f.client}>
        <TimesProbe factor={2} />
      </Ctx.Provider>,
    );
    expect(screen.getByTestId("sel").textContent).toBe("8");
  });

  it("keeps the selected value when an unrelated frame arrives (no re-render with a new value)", () => {
    const f = fakeClient({ n: 2 });
    const renders: number[] = [];
    function Parity() {
      const even = Ctx.useSelector((v: View) => ({ even: v.n % 2 === 0 }), (x, y) => x.even === y.even);
      renders.push(even.even ? 1 : 0);
      return null;
    }
    render(
      <Ctx.Provider client={f.client}>
        <Parity />
      </Ctx.Provider>,
    );
    const before = renders.length;
    act(() => f.emit({ n: 4 }));
    expect(renders.length).toBe(before);
    act(() => f.emit({ n: 5 }));
    expect(renders.at(-1)).toBe(0);
  });
});

describe("useRole", () => {
  it("shows the new client's role at once when the Provider is given another client", () => {
    const a = fakeClient({ n: 1 }, "player");
    const b = fakeClient({ n: 1 }, "host");
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
    expect(screen.getByTestId("role").textContent).toBe("host");
  });

  it("catches up with a role that changed between render and subscribe", () => {
    let role = "player";
    const f = fakeClient({ n: 1 });
    const client: ActorClient<View, Event> = {
      ...f.client,
      get view() {
        return f.client.view;
      },
      get connectionState() {
        return f.client.connectionState;
      },
      get role() {
        const now = role;
        role = "host";
        return now;
      },
    };
    render(
      <Ctx.Provider client={client}>
        <RoleProbe />
      </Ctx.Provider>,
    );
    expect(screen.getByTestId("role").textContent).toBe("host");
  });
});

describe("useConnectionState", () => {
  it("shows the new client's state at once when the Provider is given another client", () => {
    const a = fakeClient({ n: 1 });
    const b = fakeClient({ n: 1 });
    act(() => b.setState("connected"));
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
    expect(screen.getByTestId("state").textContent).toBe("connected");
  });

  it("catches up with a state that changed between render and subscribe", () => {
    let state: ConnectionState = "connecting";
    const f = fakeClient({ n: 1 });
    const client: ActorClient<View, Event> = {
      ...f.client,
      get view() {
        return f.client.view;
      },
      get role() {
        return f.client.role;
      },
      get connectionState() {
        const now = state;
        state = "connected";
        return now;
      },
    };
    render(
      <Ctx.Provider client={client}>
        <StateProbe />
      </Ctx.Provider>,
    );
    expect(screen.getByTestId("state").textContent).toBe("connected");
  });
});

describe("useView", () => {
  it("the first render after the Provider is given another client already shows that client's view", () => {
    const a = fakeClient({ n: 1 });
    const b = fakeClient({ n: 9 });
    const seen: number[] = [];
    function Probe() {
      seen.push(Ctx.useView().n);
      return null;
    }
    const { rerender } = render(
      <Ctx.Provider client={a.client}>
        <Probe />
      </Ctx.Provider>,
    );
    const before = seen.length;
    rerender(
      <Ctx.Provider client={b.client}>
        <Probe />
      </Ctx.Provider>,
    );
    expect(seen.slice(before)).not.toContain(1);
    expect(seen.at(-1)).toBe(9);
  });
});
