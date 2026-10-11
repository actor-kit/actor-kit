/**
 * simulate(): links recorded per actor (init links read the target's view), unlink(name) targets,
 * journal options (off, checkpoints), and contracts that cannot be simulated.
 */
import { schema, string, uint32, view } from "@actor-kit/core";
import { replayJournal, simulate } from "@actor-kit/test";
import { defineActor, link, message } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

type Room = { name: string };
const RoomContract = defineActor("room", {
  input: z.object({ name: z.string() }),
  init: ({ name }: { name: string }): Room => ({ name }),
  roles: {
    member: (_s: Room, _c: string, { callerType }: { callerType: string }) => callerType === "service",
    guest: () => true,
  },
  messages: {},
  views: {
    member: view.shared(schema({ name: string }), (s: Room) => ({ name: s.name })),
    guest: view.shared(schema({ name: string }), () => ({ name: "?" })),
  },
});

type Desk = { seen: unknown[]; unlinked: string[]; n: number };
const DeskContract = defineActor("desk", {
  input: z.object({ roomId: z.string().optional() }),
  init: async (
    { roomId }: { roomId?: string },
    ctx: { link(name: string, id: string): Promise<unknown> },
  ): Promise<Desk> => ({
    seen: roomId === undefined ? [] : [await ctx.link("room", roomId)],
    unlinked: [],
    n: 0,
  }),
  roles: { any: () => true },
  messages: {
    JOIN: message(z.object({ id: z.string() }), (s: Desk, { id }, ctx) => {
      ctx.link("room", id);
      ctx.link("nowhere", id);
      return s;
    }),
    LEAVE: message(z.object({ id: z.string() }), (s: Desk, { id }, ctx) => {
      ctx.unlink("room", id);
      return s;
    }),
    LEAVE_ALL: message(z.object({}), (s: Desk, _p, ctx) => {
      ctx.unlink("room");
      return s;
    }),
    BUMP: message(z.object({}), (s: Desk) => ({ ...s, n: s.n + 1 })),
  },
  links: {
    room: link(RoomContract, {
      onUpdate: (s: Desk) => s,
      onUnlink: (s: Desk, id?: string) => ({ ...s, unlinked: [...s.unlinked, id ?? "?"] }),
    }),
  },
  views: { any: view.shared(schema({ n: uint32 }), (s: Desk) => ({ n: s.n })) },
  journal: { checkpointEvery: 2 },
});

describe("simulate: links", () => {
  it("init links read the target's view for a service caller, with its role", async () => {
    const sim = simulate({ contracts: [RoomContract, DeskContract] });
    await sim.spawn(RoomContract, "r1", { name: "lobby" });
    const desk = await sim.spawn(DeskContract, "d1", { roomId: "r1" });
    expect(desk.state.seen).toEqual([{ role: "member", name: "lobby" }]);
    expect(desk.links).toEqual([{ name: "room", id: "r1" }]);
    const { state } = await replayJournal(DeskContract, desk.journal);
    expect(state).toEqual(desk.state);
  });

  it("an init link to an actor that does not exist, or an undeclared link, fails the spawn", async () => {
    const sim = simulate({ contracts: [RoomContract, DeskContract] });
    await expect(sim.spawn(DeskContract, "d1", { roomId: "ghost" })).rejects.toThrow(
      /room\/ghost has not been spawned/,
    );
    const Bad = defineActor("bad", {
      input: z.object({}),
      init: async (_i: unknown, ctx: { link(n: string, id: string): Promise<unknown> }) => ({
        v: await ctx.link("x", "y"),
      }),
      roles: { any: () => true },
      messages: {},
      views: {},
    });
    await expect(sim.spawn(Bad, "b", {})).rejects.toThrow('Link "x" not declared');
  });

  it("records declared links once, drops undeclared ones, and unlinks by id or by name", async () => {
    const sim = simulate({ contracts: [RoomContract, DeskContract] });
    const desk = await sim.spawn(DeskContract, "d1", {});
    desk.send("a", { type: "JOIN", id: "r1" });
    desk.send("a", { type: "JOIN", id: "r1" });
    desk.send("a", { type: "JOIN", id: "r2" });
    desk.send("a", { type: "JOIN", id: "r3" });
    expect(desk.links).toEqual([
      { name: "room", id: "r1" },
      { name: "room", id: "r2" },
      { name: "room", id: "r3" },
    ]);
    desk.send("a", { type: "LEAVE", id: "r2" });
    expect(desk.links.map((l) => l.id)).toEqual(["r1", "r3"]);
    desk.send("a", { type: "LEAVE_ALL" });
    expect(desk.links).toEqual([]);
    expect(desk.state.unlinked).toEqual(["r2", "r1", "r3"]);
    const { state } = await replayJournal(DeskContract, desk.journal);
    expect(state).toEqual(desk.state);
  });
});

describe("simulate: journal options", () => {
  it("checkpoints every checkpointEvery events, with the serialized state", async () => {
    const sim = simulate({ contracts: [DeskContract] });
    const desk = await sim.spawn(DeskContract, "d1", {});
    for (let i = 0; i < 4; i++) desk.send("a", { type: "BUMP" });
    expect(desk.journal.checkpoints.map((c) => [c.seq, JSON.parse(c.state).n])).toEqual([
      [2, 1],
      [4, 3],
    ]);
  });

  it("journal: false writes no journal", async () => {
    const Off = defineActor("off", { ...DeskContract.def, journal: false });
    const sim = simulate();
    const off = await sim.spawn(Off, "o1", {});
    off.send("a", { type: "BUMP" });
    expect(off.journal).toEqual({ events: [], checkpoints: [] });
    expect(off.state.n).toBe(1);
  });
});

describe("simulate: contracts", () => {
  it("refuses something that is not an actor contract", () => {
    expect(() => simulate({ contracts: [{ name: "x", def: { init: () => 1 } }] })).toThrow(
      /"x" is not an actor contract/,
    );
    expect(() => simulate({ contracts: [{ name: "y", def: null }] })).toThrow(/not an actor contract/);
  });

  it("refuses a message that is not a message() definition", () => {
    const broken = { name: "z", def: { ...DeskContract.def, messages: { BAD: { handler: () => 1 } } } };
    expect(() => simulate({ contracts: [broken] })).toThrow('message "BAD" is not a message() definition');
  });

  it("an unknown caller role is refused like the runtime", async () => {
    const sim = simulate({ contracts: [RoomContract] });
    const room = await sim.spawn(RoomContract, "r1", { name: "x" });
    const strict = defineActor("strict", { ...RoomContract.def, roles: { member: () => false } });
    const s = await sim.spawn(strict, "s1", { name: "x" });
    expect(s.send("a", { type: "ANY" })).toMatchObject({ ok: false, code: "no_role" });
    expect(() => s.connect("a")).toThrow(/no role matched/);
    expect(() => s.view("a")).toThrow(/no role matched/);
    expect(s.role("a")).toBeNull();
    expect(room.view("a", { callerType: "service" })).toEqual({ name: "x" });
  });
});
