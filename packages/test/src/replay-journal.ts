/**
 * replayJournal() — replay an actor's journal through a contract's current handlers and
 * verify every event's after-state checksum (ADR-013). Use it on journals read from a real
 * DO with readJournal() to catch handlers that aren't deterministic.
 */

import type { Journal, ReplayableDef } from "@actor-kit/worker/testing";
import { foldJournal } from "@actor-kit/worker/testing";

export { JournalDivergenceError, JournalNondeterminismError } from "@actor-kit/worker/testing";

type MessageSlot = { handler(state: unknown, payload: unknown, ctx: unknown): unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMessageSlot(value: unknown): value is MessageSlot {
  return isRecord(value) && typeof value["handler"] === "function";
}

/** Runtime check that a contract def has the shape replay calls; type safety comes from defineActor(). */
function isReplayableDef(def: unknown): def is ReplayableDef & { roles?: Record<string, unknown> } {
  return isRecord(def) && typeof def["init"] === "function";
}

/** Flat messages ({ NAME: message(...) }) apply to every role, as in the runtime. */
function roleNestedMessages(
  messages: unknown,
  roles: Record<string, unknown> | undefined,
): Record<string, Record<string, MessageSlot>> | undefined {
  if (!isRecord(messages)) return undefined;
  const entries = Object.entries(messages);
  const flat: Record<string, MessageSlot> = {};
  for (const [name, slot] of entries) {
    if (!isMessageSlot(slot)) return undefined;
    flat[name] = slot;
  }
  return Object.fromEntries(Object.keys(roles ?? {}).map((role) => [role, flat]));
}

export async function replayJournal(
  contract: { readonly name: string; readonly def: unknown },
  journal: Journal,
  options: { env?: unknown } = {},
): Promise<{ state: unknown; replayed: number }> {
  const def = contract.def;
  if (!isReplayableDef(def)) {
    throw new Error(`replayJournal: "${contract.name}" is not an actor contract`);
  }
  const flat = roleNestedMessages(def.messages, def.roles);
  const replayable: ReplayableDef = flat === undefined ? def : { ...def, messages: flat };
  return foldJournal(replayable, journal, options);
}
