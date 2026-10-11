/**
 * Roles on messages (Run Set Jimmy feedback): a message may name the roles that may send it. Every name
 * must be one of the actor's roles; this checks it when the actor is defined (the runtime, simulate()
 * and testActor all call it), so a typo fails at once instead of refusing every sender.
 */

import { ActorKitError } from "@actor-kit/core";

interface RoledSlot {
  readonly roles?: readonly string[] | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSlot(value: unknown): value is RoledSlot & Record<string, unknown> {
  return isRecord(value) && "schema" in value && "handler" in value;
}

/** Every message definition in a `messages` record, flat (`{ NAME: slot }`) or role-nested (`{ role: { NAME: slot } }`). */
function slotsOf(messages: unknown): Array<[string, RoledSlot]> {
  if (!isRecord(messages)) return [];
  return Object.entries(messages).flatMap(([key, value]): Array<[string, RoledSlot]> => {
    if (isSlot(value)) return [[key, value]];
    if (!isRecord(value)) return [];
    return Object.entries(value).flatMap(
      ([name, slot]): Array<[string, RoledSlot]> => (isSlot(slot) ? [[name, slot]] : []),
    );
  });
}

/** Throws when a message (top-level or in a state) names a role the actor does not declare. */
export function checkMessageRoles(def: {
  readonly roles?: Readonly<Record<string, unknown>>;
  readonly messages?: unknown;
  readonly states?: Readonly<Record<string, { readonly messages?: unknown }>>;
}): void {
  const declared = Object.keys(def.roles ?? {});
  const placed: Array<[string, string, RoledSlot]> = [
    ...slotsOf(def.messages).map(([name, slot]): [string, string, RoledSlot] => [name, "", slot]),
    ...Object.entries(def.states ?? {}).flatMap(([phase, state]) =>
      slotsOf(state.messages).map(([name, slot]): [string, string, RoledSlot] => [name, ` (state "${phase}")`, slot]),
    ),
  ];
  for (const [name, where, slot] of placed) {
    const unknown = (slot.roles ?? []).find((role) => !declared.includes(role));
    if (unknown !== undefined) {
      throw new ActorKitError(
        "invalid_actor_definition",
        `Message "${name}"${where} names role "${unknown}", which this actor does not declare. Its roles are: ${declared.join(", ")}.`,
      );
    }
  }
}
