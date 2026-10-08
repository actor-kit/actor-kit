/**
 * Roster: a version chain whose version 2 rebuilds by replay (ADR-015 D5). Version 1 stored player
 * names; version 2 stores { name, avatar } and JOIN payloads gained `avatar` (upcast to null).
 */

import { schema, uint32, view } from "@actor-kit/core";
import { createActorClass, defineActor, message, version } from "@actor-kit/worker";
import { z } from "zod";

const V1 = z.object({ players: z.array(z.string()) });
const V2 = z.object({ players: z.array(z.object({ name: z.string(), avatar: z.string().nullable() })) });
type Roster = z.infer<typeof V2>;

const RosterContract = defineActor("roster", {
  versions: [version(1, V1), version(2, V2, { rebuild: "replay", events: { JOIN: (p) => ({ ...p, avatar: null }) } })],
  input: z.object({}),
  init: (): Roster => ({ players: [] }),
  roles: { any: () => true },
  messages: {
    JOIN: message(z.object({ name: z.string(), avatar: z.string().nullable() }), (s: Roster, p) => ({
      players: [...s.players, { name: p.name, avatar: p.avatar }],
    })),
  },
  views: { any: view.shared(schema({ players: uint32 }), (s: Roster) => ({ players: s.players.length })) },
  journal: { checkpointEvery: 100 },
});

export const RosterActor = createActorClass(RosterContract);
export { RosterContract };
