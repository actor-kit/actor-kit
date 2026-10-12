/**
 * Handlers that see only the shared state (lifecycle, service and link callbacks) in an actor with states:
 * they get the shared state, their result replaces it, the active state and its local are kept, and a
 * handler that returns the shared state unchanged leaves the whole state (and the journal) as it was.
 */
import { simulate } from "@actor-kit/test";
import { setup } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

type S = { visits: number; seen: string[] };
const kit = setup({ states: { lobby: {}, playing: {} } });
const lobby = kit.in("lobby");
const playing = kit.in("playing");

const Room = kit.actor("room", {
  input: z.object({}),
  init: (): S => ({ visits: 0, seen: [] }),
  roles: { any: () => true },
  initial: "lobby",
  states: {
    lobby: lobby.state({
      messages: { START: lobby.message(z.object({}), (s: S, _p, ctx) => ctx.goto("playing", s)) },
    }),
    playing: playing.state({}),
  },
  lifecycle: {
    connect: (s: S, event) => ({ visits: s.visits + 1, seen: [...s.seen, event.caller] }),
    disconnect: (s: S) => s,
  },
  views: { any: { fn: (s: { shared: S }) => s.shared } },
});

describe("shared-state handlers in an actor with states", () => {
  it("connect gets the shared state and its result replaces it; the active state is kept", async () => {
    const sim = simulate({ contracts: [Room] });
    const room = await sim.spawn(Room, "r", {});
    room.send("host", { type: "START" });
    const before = room.state;
    room.connect("ann");
    expect(room.state).toEqual({ ...before, shared: { visits: 1, seen: ["ann"] } });
    expect(room.view("ann")).toEqual({ visits: 1, seen: ["ann"] });
  });

  it("a handler that returns the shared state unchanged leaves the state as it was, unjournaled", async () => {
    const sim = simulate({ contracts: [Room] });
    const room = await sim.spawn(Room, "r", {});
    const connection = room.connect("ann");
    const before = room.state;
    const events = room.journal.events.length;
    connection.disconnect();
    expect(room.state).toBe(before);
    expect(room.journal.events).toHaveLength(events);
  });
});
