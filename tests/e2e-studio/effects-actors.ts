/**
 * Actors with real side effects, so Studio's Outbox and Links panels have
 * something to show in the browser.
 *
 * AuctionRoom closes with a NOTIFY_WINNER service (slow on purpose, so the
 * pending execution is visible; `fail: true` routes through onError) and can
 * link to a Lobby, whose public view (its name) it mirrors.
 */

import { nullable, schema, string, uint32, view } from "@actor-kit/core";
import { createActorClass, defineActor, link, message } from "@actor-kit/worker";
import { z } from "zod";

// --- Lobby (link target) ---

type LobbyState = { name: string; renames: number };

const LobbyViewSchema = schema({ name: string, renames: uint32 });

export const LobbyContract = defineActor("lobby", {
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
    member: view.shared(LobbyViewSchema, (state: LobbyState) => ({ name: state.name, renames: state.renames })),
  },
  studio: { enabled: true },
});

export const Lobby = createActorClass(LobbyContract);

// --- AuctionRoom (runs a service, links to a lobby) ---

type AuctionState = { item: string; notice: string; lobbyName: string | null };

const AuctionViewSchema = schema({ item: string, notice: string, lobbyName: nullable(string) });

const NotifyInputSchema = z.object({ winner: z.string(), delayMs: z.number().int().min(0), fail: z.boolean() });
type NotifyInput = z.infer<typeof NotifyInputSchema>;

/** The lobby view as it arrives over a link (role discriminant added by the runtime). */
const LinkedLobbySchema = z.object({ name: z.string() });

export const AuctionRoomContract = defineActor("auction-room", {
  input: z.object({ item: z.string() }),
  init: ({ item }: { item: string }): AuctionState => ({ item, notice: "", lobbyName: null }),
  roles: { bidder: () => true },
  services: {
    NOTIFY_WINNER: {
      // One try: the spec watches pending → failed without waiting out retries (ADR-015 D1).
      retry: { attempts: 1 },
      fn: async (input: NotifyInput): Promise<{ sentTo: string }> => {
        await new Promise((resolve) => setTimeout(resolve, input.delayMs));
        if (input.fail) throw new Error(`mailbox full for ${input.winner}`);
        return { sentTo: input.winner };
      },
      onDone: (state: AuctionState, result: { sentTo: string }) => ({ ...state, notice: `notified ${result.sentTo}` }),
      onError: (state: AuctionState, error: { message: string }) => ({
        ...state,
        notice: `notify failed: ${error.message}`,
      }),
    },
  },
  links: {
    lobby: link(LobbyContract, {
      onUpdate: (state: AuctionState, linked: unknown) => ({
        ...state,
        lobbyName: LinkedLobbySchema.parse(linked).name,
      }),
      onUnlink: (state: AuctionState) => ({ ...state, lobbyName: null }),
    }),
  },
  messages: {
    CLOSE: message(NotifyInputSchema, (state: AuctionState, input, ctx) => {
      ctx.execute("NOTIFY_WINNER", input);
      return { ...state, notice: `closing for ${input.winner}` };
    }),
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
    bidder: view.shared(AuctionViewSchema, (state: AuctionState) => ({
      item: state.item,
      notice: state.notice,
      lobbyName: state.lobbyName,
    })),
  },
  studio: { enabled: true },
});

export const AuctionRoom = createActorClass(AuctionRoomContract);
