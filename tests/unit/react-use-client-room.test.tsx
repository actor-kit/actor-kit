/**
 * @vitest-environment jsdom
 */
/**
 * useClient(options) follows the room it is given: a component that moves to another room (a new
 * `path` or `host`) gets a client for that room, and the old room's client is disconnected. Before,
 * the first room's client was kept for the life of the component.
 */
import type { ActorClient, WebSocketConstructor, WebSocketLike } from "@actor-kit/client";
import { createActorContext } from "@actor-kit/react";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

type View = { n: number };
type Event = { type: "INC" };
const Ctx = createActorContext<View, Event>();

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

afterEach(() => {
  cleanup();
  sockets.length = 0;
});

function Room({ path, host = "h.example", seen }: { path: string; host?: string; seen: ActorClient<View, Event>[] }) {
  const client = Ctx.useClient({ path, host, initialView: { n: path.length }, WebSocketImpl, heartbeat: false });
  seen.push(client);
  return <span data-testid="n">{client.view.n}</span>;
}

describe("useClient and a new room", () => {
  it("a new path gets its own client, connected; the old one is disconnected", async () => {
    const seen: ActorClient<View, Event>[] = [];
    const { rerender } = render(<Room path="/api/c/1" seen={seen} />);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const first = seen[0];

    rerender(<Room path="/api/c/two" seen={seen} />);
    const second = seen.at(-1);
    expect(second).not.toBe(first);
    expect(screen.getByTestId("n").textContent).toBe(String("/api/c/two".length));
    expect(first?.connectionState).toBe("disconnected");
    expect(sockets[0]?.closed).toBe(true);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(sockets[1]?.url).toContain("h.example/api/c/two");
    expect(second?.connectionState).toBe("connecting");
  });

  it("a new host is a new room too", async () => {
    const seen: ActorClient<View, Event>[] = [];
    const { rerender } = render(<Room path="/api/c/1" seen={seen} />);
    rerender(<Room path="/api/c/1" host="other.example" seen={seen} />);
    expect(seen.at(-1)).not.toBe(seen[0]);
    await vi.waitFor(() => expect(sockets.map((s) => s.url).join()).toContain("other.example/api/c/1"));
  });

  it("the same room across renders keeps its one client", () => {
    const seen: ActorClient<View, Event>[] = [];
    const { rerender } = render(<Room path="/api/c/1" seen={seen} />);
    rerender(<Room path="/api/c/1" seen={seen} />);
    rerender(<Room path="/api/c/1" seen={seen} />);
    expect(new Set(seen).size).toBe(1);
  });

  it("mounting renders once (the first room's client is made once)", () => {
    const seen: ActorClient<View, Event>[] = [];
    render(<Room path="/api/c/1" seen={seen} />);
    expect(seen).toHaveLength(1);
  });
});
