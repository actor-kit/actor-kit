import type { LinkedView } from "@actor-kit/core";
import { float32, schema, string, uint32, view } from "@actor-kit/core";
import { testActor } from "@actor-kit/test";
import { defineActor, link, message } from "@actor-kit/worker/testing";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

// --- Target contracts (actors we link TO) ---

const ProfileView = schema({ name: string, level: uint32 });
const ProfilePublicView = schema({ name: string });

const ProfileContract = defineActor("profile", {
  input: z.object({ name: z.string() }),
  init: (input: { name: string }) => ({ name: input.name, level: 1, email: "test@test.com" }),
  roles: {
    self: (state: unknown, caller: string) => caller === "owner",
    actor: () => true,
  },
  messages: {},
  views: {
    self: view(ProfileView, (state: { name: string; level: number }) => ({
      name: state.name,
      level: state.level,
    })),
    actor: view(ProfilePublicView, (state: { name: string }) => ({
      name: state.name,
    })),
  },
});

const AdminGameView = schema({ count: uint32, revenue: float32 });
const PlayerGameView = schema({ count: uint32, score: uint32 });
const SpectatorGameView = schema({ count: uint32 });

const GameContract = defineActor("game", {
  input: z.object({}),
  init: () => ({ count: 0, revenue: 100, score: 42 }),
  roles: {
    admin: () => true,
    player: () => true,
    spectator: () => true,
  },
  messages: {},
  views: {
    admin: view(AdminGameView, (state: { count: number; revenue: number }) => ({
      count: state.count,
      revenue: state.revenue,
    })),
    player: view(PlayerGameView, (state: { count: number; score: number }) => ({
      count: state.count,
      score: state.score,
    })),
    spectator: view(SpectatorGameView, (state: { count: number }) => ({
      count: state.count,
    })),
  },
});

// --- Phase 1: link() declaration ---

describe("link() declaration", () => {
  it("creates a LinkDef with contract and handlers", () => {
    const profileLink = link(ProfileContract, {
      onUpdate: (state: unknown, view: unknown) => state,
    });

    expect(profileLink.contract).toBe(ProfileContract);
    expect(typeof profileLink.onUpdate).toBe("function");
    expect(profileLink.onError).toBeUndefined();
    expect(profileLink.onUnlink).toBeUndefined();
  });

  it("creates a LinkDef with all handlers", () => {
    const gameLink = link(GameContract, {
      onUpdate: (state: unknown, view: unknown, id?: string) => state,
      onError: (state: unknown, error: { message: string; code: string }, id?: string) => state,
      onUnlink: (state: unknown, id?: string) => state,
    });

    expect(gameLink.contract).toBe(GameContract);
    expect(typeof gameLink.onUpdate).toBe("function");
    expect(typeof gameLink.onError).toBe("function");
    expect(typeof gameLink.onUnlink).toBe("function");
  });

  it("onUpdate handler receives state and view", () => {
    type State = { profile: unknown };
    const profileLink = link(ProfileContract, {
      onUpdate: (state: State, view: unknown) => ({ ...state, profile: view }),
    });

    const result = profileLink.onUpdate({ profile: null }, { role: "actor", name: "Alice" });
    expect(result).toEqual({ profile: { role: "actor", name: "Alice" } });
  });

  it("onUpdate handler receives optional id for collections", () => {
    type State = { games: Record<string, unknown> };
    const gameLink = link(GameContract, {
      onUpdate: (state: State, view: unknown, gameId?: string) => ({
        ...state,
        games: { ...state.games, [gameId ?? "default"]: view },
      }),
    });

    const result = gameLink.onUpdate({ games: {} }, { role: "player", count: 5, score: 100 }, "game-1");
    expect(result).toEqual({
      games: { "game-1": { role: "player", count: 5, score: 100 } },
    });
  });

  it("onError handler receives error object", () => {
    type State = { error: string | null };
    const profileLink = link(ProfileContract, {
      onUpdate: (state: State, view: unknown) => state,
      onError: (state: State, error: { message: string; code: string }) => ({
        ...state,
        error: error.message,
      }),
    });

    const result = profileLink.onError!({ error: null }, { message: "Actor not found", code: "not_found" });
    expect(result).toEqual({ error: "Actor not found" });
  });

  it("onUnlink handler cleans up state", () => {
    type State = { games: Record<string, unknown> };
    const gameLink = link(GameContract, {
      onUpdate: (state: State, view: unknown, id?: string) => state,
      onUnlink: (state: State, id?: string) => {
        if (!id) return { ...state, games: {} };
        const { [id]: _, ...rest } = state.games;
        return { ...state, games: rest };
      },
    });

    const state: State = { games: { "game-1": { count: 5 }, "game-2": { count: 10 } } };

    // Unlink specific game
    const afterUnlinkOne = gameLink.onUnlink!(state, "game-1");
    expect(afterUnlinkOne).toEqual({ games: { "game-2": { count: 10 } } });

    // Unlink all
    const afterUnlinkAll = gameLink.onUnlink!(state);
    expect(afterUnlinkAll).toEqual({ games: {} });
  });
});

// --- Phase 2: links in actor definition ---

describe("links in actor definition", () => {
  type PlayerState = {
    profileId: string;
    profile: LinkedView<typeof ProfileContract> | null;
    games: Record<string, LinkedView<typeof GameContract>>;
    errors: Record<string, string>;
  };

  const PlayerContract = defineActor("player", {
    input: z.object({ profileId: z.string() }),
    init: (input: { profileId: string }): PlayerState => ({
      profileId: input.profileId,
      profile: null,
      games: {},
      errors: {},
    }),
    roles: {
      owner: (state: PlayerState, caller: string) => caller === "owner",
    },
    messages: {
      JOIN_GAME: message(z.object({ gameId: z.string() }), (state: PlayerState, { gameId }, { link }) => {
        link("game", gameId);
        return { ...state };
      }),
      LEAVE_GAME: message(z.object({ gameId: z.string() }), (state: PlayerState, { gameId }, { unlink }) => {
        unlink("game", gameId);
        const { [gameId]: _, ...rest } = state.games;
        return { ...state, games: rest };
      }),
      LEAVE_ALL_GAMES: message(z.object({}), (state: PlayerState, _, { unlink }) => {
        unlink("game");
        return { ...state, games: {} };
      }),
    },
    views: {
      owner: view(schema({ profileId: string }), (state: PlayerState) => ({ profileId: state.profileId })),
    },
    links: {
      profile: link(ProfileContract, {
        onUpdate: (state: PlayerState, view: LinkedView<typeof ProfileContract>) => ({
          ...state,
          profile: view,
        }),
        onError: (state: PlayerState, error: { message: string; code: string }) => ({
          ...state,
          errors: { ...state.errors, profile: error.message },
        }),
      }),
      game: link(GameContract, {
        onUpdate: (state: PlayerState, view: LinkedView<typeof GameContract>, gameId?: string) => ({
          ...state,
          games: { ...state.games, [gameId ?? "default"]: view },
        }),
        onError: (state: PlayerState, error: { message: string; code: string }, gameId?: string) => ({
          ...state,
          errors: { ...state.errors, [gameId ?? "game"]: error.message },
        }),
        onUnlink: (state: PlayerState, gameId?: string) => {
          if (!gameId) return { ...state, games: {} };
          const { [gameId]: _, ...rest } = state.games;
          return { ...state, games: rest };
        },
      }),
    },
  });

  it("contract preserves links in def", () => {
    expect(PlayerContract.def.links).toBeDefined();
    expect(PlayerContract.def.links.profile).toBeDefined();
    expect(PlayerContract.def.links.game).toBeDefined();
  });

  it("link declaration has correct contract reference", () => {
    expect(PlayerContract.def.links.profile.contract).toBe(ProfileContract);
    expect(PlayerContract.def.links.game.contract).toBe(GameContract);
  });
});

// --- Phase 3: testActor captures link/unlink calls ---

describe("testActor with links", () => {
  type PlayerState = {
    profileId: string;
    profile: LinkedView<typeof ProfileContract> | null;
    games: Record<string, LinkedView<typeof GameContract>>;
  };

  const PlayerContract = defineActor("player", {
    input: z.object({ profileId: z.string() }),
    init: (input: { profileId: string }): PlayerState => ({
      profileId: input.profileId,
      profile: null,
      games: {},
    }),
    roles: {
      owner: (state: PlayerState, caller: string) => caller === "owner",
    },
    messages: {
      JOIN_GAME: message(z.object({ gameId: z.string() }), (state: PlayerState, { gameId }, { link }) => {
        link("game", gameId);
        return state;
      }),
      LEAVE_GAME: message(z.object({ gameId: z.string() }), (state: PlayerState, { gameId }, { unlink }) => {
        unlink("game", gameId);
        const { [gameId]: _, ...rest } = state.games;
        return { ...state, games: rest };
      }),
      LEAVE_ALL: message(z.object({}), (state: PlayerState, _, { unlink }) => {
        unlink("game");
        return { ...state, games: {} };
      }),
    },
    views: {
      owner: view(schema({ profileId: string }), (state: PlayerState) => ({ profileId: state.profileId })),
    },
    links: {
      profile: link(ProfileContract, {
        onUpdate: (state: PlayerState, view: LinkedView<typeof ProfileContract>) => ({
          ...state,
          profile: view,
        }),
      }),
      game: link(GameContract, {
        onUpdate: (state: PlayerState, view: LinkedView<typeof GameContract>, gameId?: string) => ({
          ...state,
          games: { ...state.games, [gameId ?? "default"]: view },
        }),
      }),
    },
  });

  it("captures link() calls in sendWithEffects", async () => {
    const t = testActor(PlayerContract);
    const state = t.init({ profileId: "p1" });

    const { state: next, links } = await t.sendWithEffects(state, "owner", {
      type: "JOIN_GAME",
      gameId: "game-1",
    });

    expect(links).toHaveLength(1);
    expect(links[0]).toEqual({ name: "game", id: "game-1" });
    expect(next).toBe(state); // state unchanged — link is async
  });

  it("captures unlink() with specific id in sendWithEffects", async () => {
    const t = testActor(PlayerContract);
    const state: PlayerState = {
      profileId: "p1",
      profile: null,
      games: { "game-1": { role: "player", count: 5, score: 42 } },
    };

    const { unlinks } = await t.sendWithEffects(state, "owner", {
      type: "LEAVE_GAME",
      gameId: "game-1",
    });

    expect(unlinks).toHaveLength(1);
    expect(unlinks[0]).toEqual({ name: "game", id: "game-1" });
  });

  it("captures unlink() without id (unlink all) in sendWithEffects", async () => {
    const t = testActor(PlayerContract);
    const state: PlayerState = {
      profileId: "p1",
      profile: null,
      games: { "game-1": { role: "player", count: 5, score: 42 } },
    };

    const { unlinks } = await t.sendWithEffects(state, "owner", {
      type: "LEAVE_ALL",
    });

    expect(unlinks).toHaveLength(1);
    expect(unlinks[0]).toEqual({ name: "game", id: undefined });
  });

  it("captures multiple link() calls in one message", async () => {
    // Create contract with multi-link message
    const MultiLinkContract = defineActor("multi", {
      input: z.object({}),
      init: (): { games: Record<string, unknown> } => ({ games: {} }),
      roles: { user: () => true },
      messages: {
        JOIN_MANY: message(
          z.object({ ids: z.array(z.string()) }),
          (state: { games: Record<string, unknown> }, { ids }, { link }) => {
            for (const id of ids) {
              link("game", id);
            }
            return state;
          },
        ),
      },
      views: {
        user: view(schema({ count: uint32 }), () => ({ count: 0 })),
      },
      links: {
        game: link(GameContract, {
          onUpdate: (state: { games: Record<string, unknown> }, view: unknown, id?: string) => ({
            ...state,
            games: { ...state.games, [id ?? "default"]: view },
          }),
        }),
      },
    });

    const t = testActor(MultiLinkContract);
    const state = t.init({});

    const { links } = await t.sendWithEffects(state, "alice", {
      type: "JOIN_MANY",
      ids: ["game-1", "game-2", "game-3"],
    });

    expect(links).toHaveLength(3);
    expect(links[0]).toEqual({ name: "game", id: "game-1" });
    expect(links[1]).toEqual({ name: "game", id: "game-2" });
    expect(links[2]).toEqual({ name: "game", id: "game-3" });
  });

  it("send() still works (ignores link/unlink captures)", async () => {
    const t = testActor(PlayerContract);
    const state = t.init({ profileId: "p1" });

    // send() returns state only, doesn't expose link captures
    const next = await t.send(state, "owner", {
      type: "JOIN_GAME",
      gameId: "game-1",
    });

    expect(next).toBe(state);
  });
});
