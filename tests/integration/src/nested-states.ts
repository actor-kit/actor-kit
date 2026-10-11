/** The nested-states fixture (ADR-019 A, ./rounds.ts) hosted in the integration Worker. */
import { createActorClass } from "@actor-kit/worker";
import { Rounds } from "./rounds";

export { Rounds };
export const RoundsActor = createActorClass(Rounds);
