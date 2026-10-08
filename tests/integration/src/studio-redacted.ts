/**
 * Actor for tests/integration/studio-redaction.test.ts (ADR-014).
 *
 * Holds children's names in state, message payloads, service input/output and views, and
 * declares `studio.redact` so none of them may leave the DO through Studio.
 */

import { array, schema, string, view } from "@actor-kit/core";
import { createActorClass, defineActor, message } from "@actor-kit/worker";
import { z } from "zod";

export type Player = { id: string; name: string };
export type RedactedState = { players: Player[]; round: number; lastSaved: string };

const RosterView = schema({ names: array(string) });
const SelfView = schema({ name: string });

const StudioRedactedContract = defineActor("studio-redacted", {
  input: z.object({}),
  init: (): RedactedState => ({ players: [], round: 0, lastSaved: "" }),
  roles: {
    host: (_s: RedactedState, _c: string, { callerType }: { callerType: "user" | "service" }) =>
      callerType === "service",
    kid: (_s: RedactedState, caller: string) => caller.startsWith("kid-"),
  },
  services: {
    SAVE: {
      fn: async (input: { name: string }) => ({ saved: input.name }),
      onDone: (state: RedactedState, result: { saved: string }) => ({ ...state, lastSaved: result.saved }),
    },
  },
  messages: {
    JOIN: message(z.object({ name: z.string() }), (state: RedactedState, { name }, { caller }) => ({
      ...state,
      players: [...state.players, { id: caller, name }],
    })),
    SAVE_NAME: message(
      z.object({ name: z.string() }),
      (state: RedactedState, { name }, ctx: { execute: (service: string, input: unknown) => void }) => {
        ctx.execute("SAVE", { name });
        return { ...state, round: state.round + 1 };
      },
    ),
  },
  views: {
    host: view.shared(RosterView, (state: RedactedState) => ({ names: state.players.map((p) => p.name) })),
    kid: view.perCaller(SelfView, (state: RedactedState, caller: string) => ({
      name: state.players.find((p) => p.id === caller)?.name ?? "",
    })),
  },
  studio: { enabled: true, redact: ["players.*.id", "players.*.name", "**.name", "names", "saved", "lastSaved"] },
});

export const StudioRedacted = createActorClass(StudioRedactedContract);
