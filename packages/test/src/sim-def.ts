/**
 * A contract's definition as the step core runs it (runtime-shaped: unknown-typed, bivariant
 * methods; messages role-nested). Type safety comes from defineActor() at the definition site;
 * this checks the shape at runtime before simulate() uses it.
 */

import type { JournalOption, RolePredicate, StepDef, StepMessageSlot } from "@actor-kit/worker/testing";
import { toRuntimeDef } from "@actor-kit/worker/testing";

export interface SimDef extends StepDef {
  readonly input: {
    safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: { message: string } };
  };
  readonly roles: Record<string, RolePredicate<unknown>>;
  readonly views: Record<string, { fn(state: unknown, caller: string): unknown }>;
  readonly messages?: Record<string, Record<string, StepMessageSlot>>;
  readonly links?: Record<
    string,
    NonNullable<StepDef["links"]>[string] & { readonly contract: { readonly name: string } }
  >;
  readonly observe?: {
    onTransition?(prev: unknown, next: unknown, event: { type: string }, ctx: { caller: string; role: string }): void;
  };
  readonly journal?: JournalOption;
  readonly version?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMessageSlot(value: unknown): value is StepMessageSlot {
  return isRecord(value) && typeof value["handler"] === "function" && isRecord(value["schema"]);
}

/** Runtime check of the parts simulate() calls; the rest is typed by defineActor(). */
function isSimDef(def: unknown): def is SimDef {
  return (
    isRecord(def) &&
    typeof def["init"] === "function" &&
    isRecord(def["input"]) &&
    typeof def["input"]["safeParse"] === "function" &&
    isRecord(def["roles"]) &&
    isRecord(def["views"])
  );
}

/** Flat messages ({ NAME: message(...) }) apply to every role, as in the runtime. */
function roleNested(
  messages: unknown,
  roles: Record<string, unknown>,
): Record<string, Record<string, StepMessageSlot>> {
  const flat: Record<string, StepMessageSlot> = {};
  for (const [name, slot] of Object.entries(isRecord(messages) ? messages : {})) {
    if (!isMessageSlot(slot)) throw new Error(`simulate: message "${name}" is not a message() definition`);
    flat[name] = slot;
  }
  return Object.fromEntries(Object.keys(roles).map((role) => [role, flat]));
}

/** The definition simulate() runs for a contract. Throws when it is not an actor contract. */
export function toSimDef(contract: { readonly name: string; readonly def: unknown }): SimDef {
  const def = contract.def;
  if (!isSimDef(def)) {
    throw new Error(`simulate: "${contract.name}" is not an actor contract (input, init, roles and views)`);
  }
  // The version chain (ADR-015 D5) compiles into version, migrate and upcast, as in the runtime.
  return { ...toRuntimeDef(def), messages: roleNested(def.messages, def.roles) };
}
