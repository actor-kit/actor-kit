/**
 * @vitest-environment jsdom
 */
/**
 * `actorContext(Contract).useClient(...)` decodes binary views with the contract's per-role schemas.
 * Before, the contract was ignored: the hook built a client with no schema, so a Worker that sends
 * binary (`withCallerIdentity(..., { supportsBinary: true })`) left React screens on their first
 * view (found migrating codebreakers to 0.3).
 */
import type { WebSocketConstructor, WebSocketLike } from "@actor-kit/client";
import { createSnapshotFrame, encode, schema, string, uint32, view } from "@actor-kit/core";
import { actorContext } from "@actor-kit/react";
import { defineActor, message } from "@actor-kit/worker/testing";
import { act, cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

type State = { round: number; secret: string };
const TvView = schema({ round: uint32 });
const PlayerView = schema({ round: uint32, secret: string });

const Room = defineActor("room", {
  input: z.object({}),
  init: (): State => ({ round: 0, secret: "" }),
  roles: { tv: (_s: State, caller: string) => caller === "tv", player: () => true },
  messages: { NEXT: message(z.object({}), (s: State) => ({ ...s, round: s.round + 1 })) },
  views: {
    tv: view.shared(TvView, (s: State) => ({ round: s.round })),
    player: view.shared(PlayerView, (s: State) => ({ round: s.round, secret: s.secret })),
  },
});

const sockets: Array<{ emit(data: unknown): void; open(): void }> = [];
class FakeSocket implements WebSocketLike {
  readyState = 0;
  binaryType = "blob";
  private readonly listeners = new Map<string, Array<(e: { data?: unknown }) => void>>();
  constructor() {
    sockets.push({
      emit: (data) => {
        for (const l of this.listeners.get("message") ?? []) l({ data });
      },
      open: () => {
        this.readyState = 1;
        for (const l of this.listeners.get("open") ?? []) l({});
      },
    });
  }
  send() {}
  close() {}
  addEventListener(type: string, listener: (e: { data?: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
}
const WebSocketImpl: WebSocketConstructor = FakeSocket;

function frame(roleIndex: number, bytes: Uint8Array): ArrayBuffer {
  const f = createSnapshotFrame(1, roleIndex, bytes);
  const copy = new ArrayBuffer(f.byteLength);
  new Uint8Array(copy).set(f);
  return copy;
}

afterEach(() => {
  cleanup();
  sockets.length = 0;
});

describe("actorContext(Contract).useClient decodes binary views", () => {
  const Ctx = actorContext(Room);

  function Screen() {
    const client = Ctx.useClient({
      path: "/api/room/r1",
      host: "example.com",
      initialView: { round: 0, secret: "" },
      WebSocketImpl,
      heartbeat: false,
    });
    return (
      <Ctx.Provider client={client}>
        <Shown />
      </Ctx.Provider>
    );
  }
  function Shown() {
    const v = Ctx.useView();
    return <span data-testid="v">{JSON.stringify(v)}</span>;
  }

  it("a player's snapshot is decoded with the player view's schema (role index 1)", async () => {
    render(<Screen />);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    act(() => {
      sockets[0]?.open();
      sockets[0]?.emit(frame(1, encode(PlayerView, { round: 3, secret: "owl" })));
    });
    expect(screen.getByTestId("v").textContent).toBe(JSON.stringify({ round: 3, secret: "owl" }));
  });

  it("the TV's snapshot with the TV view's schema (role index 0)", async () => {
    render(<Screen />);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    act(() => {
      sockets[0]?.open();
      sockets[0]?.emit(frame(0, encode(TvView, { round: 7 })));
    });
    expect(screen.getByTestId("v").textContent).toBe(JSON.stringify({ round: 7 }));
  });
});
