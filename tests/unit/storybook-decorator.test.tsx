/**
 * @vitest-environment jsdom
 */
import type { ConnectionState } from "@actor-kit/client";
import { createActorContext } from "@actor-kit/react";
import { act, cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createMockClient, withActorKit } from "../../packages/storybook/src/index";

type View = { count: number };
type Message = { type: "INC"; by?: number } | { type: "NOOP" };

afterEach(() => {
  cleanup();
});

describe("createMockClient", () => {
  it("defaults to a connected user and exposes the initial view", () => {
    const client = createMockClient<View, Message>({ initialView: { count: 1 } });
    expect(client.view).toEqual({ count: 1 });
    expect(client.role).toBe("user");
    expect(client.connectionState).toBe("connected");
  });

  it("uses the given role and connection state", () => {
    const client = createMockClient<View, Message>({
      initialView: { count: 1 },
      role: "admin",
      connectionState: "reconnecting",
    });
    expect(client.role).toBe("admin");
    expect(client.connectionState).toBe("reconnecting");
  });

  it("send() without onSend changes nothing and notifies nobody", () => {
    const client = createMockClient<View, Message>({ initialView: { count: 1 } });
    const seen: View[] = [];
    client.subscribe((v) => seen.push(v));
    client.send({ type: "INC" });
    expect(client.view).toEqual({ count: 1 });
    expect(seen).toEqual([]);
  });

  it("send() applies the view onSend returns and notifies every subscriber", () => {
    const sent: Message[] = [];
    const client = createMockClient<View, Message>({
      initialView: { count: 1 },
      onSend: (m) => {
        sent.push(m);
        return m.type === "INC" ? { count: client.view.count + (m.by ?? 1) } : undefined;
      },
    });
    const a: View[] = [];
    const b: View[] = [];
    client.subscribe((v) => a.push(v));
    client.subscribe((v) => b.push(v));
    client.send({ type: "INC", by: 2 });
    expect(sent).toEqual([{ type: "INC", by: 2 }]);
    expect(client.view).toEqual({ count: 3 });
    expect(a).toEqual([{ count: 3 }]);
    expect(b).toEqual([{ count: 3 }]);
  });

  it("send() keeps the view when onSend returns undefined", () => {
    const client = createMockClient<View, Message>({ initialView: { count: 1 }, onSend: () => undefined });
    const seen: View[] = [];
    client.subscribe((v) => seen.push(v));
    client.send({ type: "NOOP" });
    expect(client.view).toEqual({ count: 1 });
    expect(seen).toEqual([]);
  });

  it("unsubscribe stops view notifications", () => {
    const client = createMockClient<View, Message>({ initialView: { count: 0 }, onSend: () => ({ count: 9 }) });
    const seen: View[] = [];
    const off = client.subscribe((v) => seen.push(v));
    off();
    client.send({ type: "INC" });
    expect(seen).toEqual([]);
    expect(client.view).toEqual({ count: 9 });
  });

  it("trigger() sends an event built from the type and payload", () => {
    const sent: unknown[] = [];
    const client = createMockClient<View, Message>({
      initialView: { count: 0 },
      onSend: (m) => {
        sent.push(m);
        return { count: 5 };
      },
    });
    client.trigger("INC", { by: 4 });
    client.trigger("NOOP");
    expect(sent).toEqual([{ type: "INC", by: 4 }, { type: "NOOP" }]);
    expect(client.view).toEqual({ count: 5 });
  });

  it("connect() changes nothing", () => {
    const client = createMockClient<View, Message>({ initialView: { count: 0 }, connectionState: "connecting" });
    const states: ConnectionState[] = [];
    client.onStateChange((s) => states.push(s));
    client.connect();
    expect(client.connectionState).toBe("connecting");
    expect(states).toEqual([]);
  });

  it("disconnect() moves to disconnected and notifies state listeners until they unsubscribe", () => {
    const client = createMockClient<View, Message>({ initialView: { count: 0 } });
    const a: ConnectionState[] = [];
    const b: ConnectionState[] = [];
    client.onStateChange((s) => a.push(s));
    const offB = client.onStateChange((s) => b.push(s));
    offB();
    client.disconnect();
    expect(client.connectionState).toBe("disconnected");
    expect(a).toEqual(["disconnected"]);
    expect(b).toEqual([]);
  });
});

describe("withActorKit", () => {
  const Ctx = createActorContext<View, Message>();

  function Counter() {
    const view = Ctx.useView();
    const role = Ctx.useRole();
    const send = Ctx.useSend();
    return (
      <button type="button" onClick={() => send({ type: "INC" })}>
        {`${role}:${view.count}`}
      </button>
    );
  }

  it("renders the story inside the context with a mock client holding the view", () => {
    const decorator = withActorKit<View, Message>({ context: Ctx, view: { count: 2 } });
    render(<>{decorator(() => <Counter />)}</>);
    expect(screen.getByRole("button").textContent).toBe("user:2");
  });

  it("passes the role and routes sends through onSend", () => {
    const sent: unknown[] = [];
    const decorator = withActorKit<View, Message>({
      context: Ctx,
      view: { count: 2 },
      role: "admin",
      onSend: (m) => {
        sent.push(m);
        return { count: 3 };
      },
    });
    render(<>{decorator(() => <Counter />)}</>);
    act(() => screen.getByRole("button").click());
    expect(sent).toEqual([{ type: "INC" }]);
    expect(screen.getByRole("button").textContent).toBe("admin:3");
  });
});
