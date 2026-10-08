/**
 * simulate(): link view pushes, as the runtime does them. After every committed transition a source
 * pushes its view to each actor linked to it (projected for caller `${source}:${subscriberId}`, a
 * service), only when it changed for that subscriber; the subscriber runs link.onUpdate with the
 * role added. A new link (also from init) gets the current view at once.
 *
 * The first test ports the Studio e2e "a lobby rename flows over the link" scenario
 * (tests/e2e-studio/effects-actors.ts: Lobby + AuctionRoom), run in virtual time.
 */
import { nullable, schema, string, uint32, view } from "@actor-kit/core";
import { replayJournal, simulate } from "@actor-kit/test";
import { defineActor, link, message, timer } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// --- Lobby + AuctionRoom, as in tests/e2e-studio/effects-actors.ts ---

type LobbyState = { name: string; renames: number };
const LobbyContract = defineActor("lobby", {
  input: z.object({ name: z.string() }),
  init: ({ name }: { name: string }): LobbyState => ({ name, renames: 0 }),
  roles: { member: () => true },
  messages: {
    RENAME: message(z.object({ name: z.string().min(1) }), (state: LobbyState, { name }) => ({
      name,
      renames: state.renames + 1,
    })),
  },
  views: {
    member: view.shared(schema({ name: string, renames: uint32 }), (s: LobbyState) => ({
      name: s.name,
      renames: s.renames,
    })),
  },
});

type AuctionState = { item: string; lobbyName: string | null };
const AuctionRoomContract = defineActor("auction-room", {
  input: z.object({ item: z.string() }),
  init: ({ item }: { item: string }): AuctionState => ({ item, lobbyName: null }),
  roles: { bidder: () => true },
  links: {
    lobby: link(LobbyContract, {
      onUpdate: (state: AuctionState, linked: unknown) => ({
        ...state,
        lobbyName: z.object({ name: z.string() }).parse(linked).name,
      }),
      onUnlink: (state: AuctionState) => ({ ...state, lobbyName: null }),
    }),
  },
  messages: {
    LINK_LOBBY: message(z.object({ lobbyId: z.string().min(1) }), (state: AuctionState, { lobbyId }, ctx) => {
      ctx.link("lobby", lobbyId);
      return state;
    }),
    UNLINK_LOBBY: message(z.object({ lobbyId: z.string().min(1) }), (state: AuctionState, { lobbyId }, ctx) => {
      ctx.unlink("lobby", lobbyId);
      return state;
    }),
  },
  views: {
    bidder: view.shared(schema({ item: string, lobbyName: nullable(string) }), (s: AuctionState) => ({
      item: s.item,
      lobbyName: s.lobbyName,
    })),
  },
});

describe("simulate: link pushes (the Studio lobby scenario)", () => {
  it("a lobby rename flows over the link to the auction room", async () => {
    const sim = simulate({ contracts: [LobbyContract, AuctionRoomContract] });
    const lobby = await sim.spawn(LobbyContract, "lobby-1", { name: "East Wing" });
    const room = await sim.spawn(AuctionRoomContract, "room-1", { item: "chair" });

    room.send("u", { type: "LINK_LOBBY", lobbyId: "lobby-1" });
    expect(room.state.lobbyName).toBe("East Wing");

    lobby.send("u", { type: "RENAME", name: "West Wing" });
    expect(room.state.lobbyName).toBe("West Wing");

    expect(room.journal.events.map((e) => e.causeType)).toEqual(["init", "message", "link.onUpdate", "link.onUpdate"]);
    expect((await replayJournal(AuctionRoomContract, room.journal)).state).toEqual(room.state);
  });

  it("unlinking stops the pushes; the subscriber keeps what onUnlink left", async () => {
    const sim = simulate({ contracts: [LobbyContract, AuctionRoomContract] });
    const lobby = await sim.spawn(LobbyContract, "lobby-1", { name: "Annex" });
    const room = await sim.spawn(AuctionRoomContract, "room-1", { item: "desk" });
    room.send("u", { type: "LINK_LOBBY", lobbyId: "lobby-1" });
    room.send("u", { type: "UNLINK_LOBBY", lobbyId: "lobby-1" });
    lobby.send("u", { type: "RENAME", name: "Gone" });
    expect(room.state.lobbyName).toBeNull();
  });
});

// --- Pushes in detail ---

type Feed = { headline: string; reads: number; audience: string };
const FeedContract = defineActor("feed", {
  input: z.object({ headline: z.string() }),
  init: ({ headline }: { headline: string }): Feed => ({ headline, reads: 0, audience: "all" }),
  roles: {
    subscriber: (s: Feed, caller: string, { callerType }: { callerType: string }) =>
      callerType === "service" && (s.audience === "all" || caller === s.audience),
    reader: () => true,
  },
  messages: {
    PUBLISH: message(z.object({ headline: z.string() }), (s: Feed, { headline }) => ({ ...s, headline })),
    READ: message(z.object({}), (s: Feed) => ({ ...s, reads: s.reads + 1 })),
    AUDIENCE: message(z.object({ only: z.string() }), (s: Feed, { only }) => ({ ...s, audience: only })),
    LATER: message(z.object({ headline: z.string() }), (s: Feed, { headline }, ctx) => {
      ctx.schedule("publish", { in: "1m", payload: { headline } });
      return s;
    }),
  },
  timers: {
    publish: timer(z.object({ headline: z.string() }), (s: Feed, { headline }) => ({ ...s, headline })),
  },
  views: {
    subscriber: view.perCaller(schema({ headline: string, for: string }), (s: Feed, caller: string) => ({
      headline: s.headline,
      for: caller,
    })),
    reader: view.shared(schema({ reads: uint32 }), (s: Feed) => ({ reads: s.reads })),
  },
});

type Wall = { got: unknown[] };
const WallContract = defineActor("wall", {
  input: z.object({ feedId: z.string().optional() }),
  init: async (
    { feedId }: { feedId?: string },
    ctx: { link(name: string, id: string): Promise<unknown> },
  ): Promise<Wall> => {
    if (feedId !== undefined) await ctx.link("feed", feedId);
    return { got: [] };
  },
  roles: { any: () => true },
  links: {
    feed: link(FeedContract, {
      onUpdate: (s: Wall, linked: unknown, id: string | undefined) => ({ got: [...s.got, { id, linked }] }),
    }),
  },
  messages: {
    FOLLOW: message(z.object({ id: z.string() }), (s: Wall, { id }, ctx) => {
      ctx.link("feed", id);
      return s;
    }),
    UNFOLLOW: message(z.object({ id: z.string() }), (s: Wall, { id }, ctx) => {
      ctx.unlink("feed", id);
      return s;
    }),
    UNFOLLOW_ALL: message(z.object({}), (s: Wall, _p, ctx) => {
      ctx.unlink("feed");
      return s;
    }),
  },
  views: { any: view.shared(schema({ n: uint32 }), (s: Wall) => ({ n: s.got.length })) },
});

async function feedAndWall() {
  const sim = simulate({ contracts: [FeedContract, WallContract] });
  const feed = await sim.spawn(FeedContract, "f1", { headline: "Hello" });
  const wall = await sim.spawn(WallContract, "w1", {});
  return { sim, feed, wall };
}

describe("simulate: link pushes", () => {
  it("projects the view for the subscriber as a service caller `${source}:${subscriberId}`, role added", async () => {
    const { wall } = await feedAndWall();
    wall.send("u", { type: "FOLLOW", id: "f1" });
    expect(wall.state.got).toEqual([{ id: "f1", linked: { headline: "Hello", for: "feed:w1", role: "subscriber" } }]);
  });

  it("pushes only when the subscriber's view changed", async () => {
    const { feed, wall } = await feedAndWall();
    wall.send("u", { type: "FOLLOW", id: "f1" });
    feed.send("u", { type: "READ" });
    feed.send("u", { type: "PUBLISH", headline: "Hello" });
    expect(wall.state.got).toHaveLength(1);
    feed.send("u", { type: "PUBLISH", headline: "News" });
    expect(wall.state.got).toHaveLength(2);
  });

  it("pushes after timer transitions too, in virtual time", async () => {
    const { sim, feed, wall } = await feedAndWall();
    wall.send("u", { type: "FOLLOW", id: "f1" });
    feed.send("u", { type: "LATER", headline: "At noon" });
    sim.advance("59s");
    expect(wall.state.got).toHaveLength(1);
    sim.advance("1s");
    expect(wall.state.got.at(-1)).toEqual({
      id: "f1",
      linked: { headline: "At noon", for: "feed:w1", role: "subscriber" },
    });
  });

  it("a role change is pushed, with the new role's view", async () => {
    const { feed, wall } = await feedAndWall();
    wall.send("u", { type: "FOLLOW", id: "f1" });
    feed.send("u", { type: "AUDIENCE", only: "someone-else" });
    expect(wall.state.got.at(-1)).toEqual({ id: "f1", linked: { reads: 0, role: "reader" } });
  });

  it("an init link subscribes: the view the init read is pushed, then later changes", async () => {
    const sim = simulate({ contracts: [FeedContract, WallContract] });
    const feed = await sim.spawn(FeedContract, "f1", { headline: "Hello" });
    const wall = await sim.spawn(WallContract, "w2", { feedId: "f1" });
    expect(wall.state.got).toEqual([{ id: "f1", linked: { headline: "Hello", for: "feed:w2", role: "subscriber" } }]);
    feed.send("u", { type: "PUBLISH", headline: "News" });
    expect(wall.state.got).toHaveLength(2);
    expect((await replayJournal(WallContract, wall.journal)).state).toEqual(wall.state);
  });

  it("unlink(id) unsubscribes: a later link gets the current view again even if unchanged", async () => {
    const { feed, wall } = await feedAndWall();
    wall.send("u", { type: "FOLLOW", id: "f1" });
    wall.send("u", { type: "UNFOLLOW", id: "f1" });
    feed.send("u", { type: "PUBLISH", headline: "Missed" });
    expect(wall.state.got).toHaveLength(1);
    feed.send("u", { type: "PUBLISH", headline: "Hello" });
    wall.send("u", { type: "FOLLOW", id: "f1" });
    expect(wall.state.got).toHaveLength(2);
  });

  it("unlink(name) stops the pushes", async () => {
    const { feed, wall } = await feedAndWall();
    wall.send("u", { type: "FOLLOW", id: "f1" });
    wall.send("u", { type: "UNFOLLOW_ALL" });
    feed.send("u", { type: "PUBLISH", headline: "Missed" });
    expect(wall.state.got).toHaveLength(1);
  });

  it("each subscriber gets its own projection; a link to an actor not spawned yet waits for it", async () => {
    const sim = simulate({ contracts: [FeedContract, WallContract] });
    const a = await sim.spawn(WallContract, "a", {});
    a.send("u", { type: "FOLLOW", id: "later" });
    expect(a.state.got).toEqual([]);
    const feed = await sim.spawn(FeedContract, "later", { headline: "First" });
    const b = await sim.spawn(WallContract, "b", { feedId: "later" });
    feed.send("u", { type: "PUBLISH", headline: "Second" });
    expect(a.state.got).toEqual([{ id: "later", linked: { headline: "Second", for: "feed:a", role: "subscriber" } }]);
    expect(b.state.got.at(-1)).toEqual({
      id: "later",
      linked: { headline: "Second", for: "feed:b", role: "subscriber" },
    });
  });

  it("branches push independently", async () => {
    const { sim, wall } = await feedAndWall();
    wall.send("u", { type: "FOLLOW", id: "f1" });
    const other = sim.branch();
    other.send(FeedContract, "f1", "u", { type: "PUBLISH", headline: "Elsewhere" });
    expect(wall.state.got).toHaveLength(1);
    expect(other.actor(WallContract, "w1").state.got).toHaveLength(2);
  });
});
