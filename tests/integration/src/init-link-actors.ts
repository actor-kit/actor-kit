/**
 * Kiosk: an actor whose init() links to a Bulletin (tests/integration/init-links.test.ts).
 * `via` picks the link: "bulletin" (declared, reachable), "ghost" (declared, but no actor answers
 * on it) or "missing" (not declared).
 */

import { schema, string, view } from "@actor-kit/core";
import { createActorClass, defineActor, link } from "@actor-kit/worker";
import { z } from "zod";
import { BulletinContract } from "./studio-effects";

type KioskState = { headline: string; linkedRole: string };

const GhostContract = defineActor("ghost", {
  input: z.object({}),
  init: () => ({}),
  roles: { any: () => true },
  views: {},
});

const LinkedHeadline = z.object({ role: z.string(), headline: z.string() });
const keepHeadline = (state: KioskState, linked: unknown) => ({
  ...state,
  headline: LinkedHeadline.parse(linked).headline,
});

export const KioskContract = defineActor("kiosk", {
  input: z.object({ bulletinId: z.string(), via: z.enum(["bulletin", "ghost", "missing"]) }),
  init: async (
    { bulletinId, via }: { bulletinId: string; via: string },
    ctx: { link(name: string, id: string): Promise<unknown> },
  ): Promise<KioskState> => {
    const linked = LinkedHeadline.parse(await ctx.link(via, bulletinId));
    return { headline: linked.headline, linkedRole: linked.role };
  },
  roles: { viewer: () => true },
  links: {
    bulletin: link(BulletinContract, { onUpdate: keepHeadline }),
    ghost: link(GhostContract, { onUpdate: keepHeadline }),
  },
  views: {
    viewer: view.shared(schema({ headline: string }), (state: KioskState) => ({ headline: state.headline })),
  },
});

export const Kiosk = createActorClass(KioskContract);
