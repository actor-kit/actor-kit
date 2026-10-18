/**
 * @vitest-environment jsdom
 */
/**
 * A child that sends on mount (`useEffect(() => send(JOIN), [])`) under a Provider whose client
 * `useClient` made: the message reaches the actor. React runs a child's effects before its parent's, so
 * when useClient connected in a passive effect the send came first, on a client not yet connected, and
 * was dropped (found migrating story-nook: the host phone never joined). useClient connects in a layout
 * effect, before any passive effect.
 */
import type { WebSocketConstructor, WebSocketLike } from "@actor-kit/client";
import { createActorContext } from "@actor-kit/react";
import { act, cleanup, render } from "@testing-library/react";
import React, { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

type View = { n: number };
type Event = { type: "JOIN" };
const Ctx = createActorContext<View, Event>();

const sockets: Array<{ sent: string[]; open(): void }> = [];
class FakeSocket implements WebSocketLike {
  readyState = 0;
  binaryType = "blob";
  private readonly listeners = new Map<string, Array<(e: { data?: unknown }) => void>>();
  private readonly record: { sent: string[]; open(): void };
  constructor() {
    this.record = {
      sent: [],
      open: () => {
        this.readyState = 1;
        for (const l of this.listeners.get("open") ?? []) l({});
      },
    };
    sockets.push(this.record);
  }
  send(data: string) {
    this.record.sent.push(data);
  }
  close() {}
  addEventListener(type: string, listener: (e: { data?: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
}
const WebSocketImpl: WebSocketConstructor = FakeSocket;

afterEach(() => {
  cleanup();
  sockets.length = 0;
});

function Joiner() {
  const send = Ctx.useSend();
  useEffect(() => send({ type: "JOIN" }), [send]);
  return null;
}

function Room() {
  const client = Ctx.useClient({ path: "/api/r/1", host: "h.example", initialView: { n: 0 }, WebSocketImpl, heartbeat: false });
  return (
    <Ctx.Provider client={client}>
      <Joiner />
    </Ctx.Provider>
  );
}

describe("useClient and a child that sends on mount", () => {
  it("the message is queued and goes out when the socket opens", async () => {
    render(<Room />);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    act(() => sockets[0]?.open());
    expect(sockets[0]?.sent.map((m) => JSON.parse(m).type)).toEqual(["JOIN"]);
  });
});
