/**
 * Typed refusals (ADR-018 C): why a message was not accepted, as a `Refusal` whose message is a full
 * sentence naming the fix. The runtime's `send()`, the `__error` frame, simulate() and testActor all
 * build them here, so a refusal reads the same everywhere.
 */

import { type Refusal, type RefusalCode, refusal } from "@actor-kit/core";
import { phasedState, stateDef } from "./phases";

/** One issue of a failed parse (Zod's shape). */
export interface ParseIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/** A refused admission from the step core (`admitStepMessage`). */
export type RefusedAdmission =
  | { readonly ok: false; readonly error: "message_not_found" | "guard_failed" }
  | {
      readonly ok: false;
      readonly error: "wrong_state";
      readonly phase: string;
      readonly acceptedIn: readonly string[];
    }
  | {
      readonly ok: false;
      readonly error: "validation_failed";
      readonly detail: string;
      readonly issues?: readonly ParseIssue[] | undefined;
    };

export type AdmissionError = RefusedAdmission["error"];

/** The admission errors of the step core, by refusal code. */
const ADMISSION_CODES = {
  message_not_found: "unknown_message",
  validation_failed: "invalid_payload",
  guard_failed: "guard_failed",
  wrong_state: "wrong_state",
} as const satisfies Record<AdmissionError, RefusalCode>;

export function refusalCode(error: AdmissionError): RefusalCode {
  return ADMISSION_CODES[error];
}

/** What a refusal reads from the definition: role-nested messages and the states. */
export interface RefusalDef {
  readonly messages?: Readonly<Record<string, Readonly<Record<string, unknown>> | undefined>> | undefined;
  readonly states?: Readonly<Record<string, { readonly messages?: Readonly<Record<string, unknown>> | undefined }>>;
}

/** Who sent the message (guard_failed names them). */
export interface RefusedCaller {
  readonly caller: string;
  readonly callerType: "user" | "service";
}

function issuesText(issues: readonly ParseIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return path === "" ? issue.message : `${path}: ${issue.message}`;
    })
    .join("; ");
}

/** The phase an actor with states is in, and the messages that phase declares; null without states. */
function placeOf(def: RefusalDef, state: unknown): { phase: string; messages: string[] } | null {
  if (def.states === undefined) return null;
  const { phase } = phasedState(state);
  return { phase, messages: Object.keys(stateDef(def.states, phase).messages ?? {}) };
}

function unknownMessage(def: RefusalDef, state: unknown, role: string, name: string): Refusal {
  const place = placeOf(def, state);
  const expected = [...new Set([...(place?.messages ?? []), ...Object.keys(def.messages?.[role] ?? {})])];
  const where = place === null ? "" : ` in state "${place.phase}"`;
  const can = expected.length === 0 ? " no messages (a read-only role)" : `: ${expected.join(", ")}`;
  return refusal("unknown_message", `Message "${name}" not found for role "${role}"${where}. It can send${can}.`, {
    expected,
  });
}

function invalidPayload(admission: Extract<RefusedAdmission, { error: "validation_failed" }>, name: string): Refusal {
  const issues = admission.issues;
  const why = issues === undefined ? admission.detail : issuesText(issues);
  const message = `Validation failed for "${name}": ${why}. Fix the payload to match its schema and send it again.`;
  return refusal("invalid_payload", message, issues === undefined ? {} : { details: issues });
}

/**
 * The refusal for an admission the step core refused. `state` is the actor's persisted state (read for
 * its phase when the actor has states); `who` names the caller for guard_failed.
 */
export function refuseAdmission(
  def: RefusalDef,
  state: unknown,
  role: string,
  name: string,
  admission: RefusedAdmission,
  who?: RefusedCaller,
): Refusal {
  switch (admission.error) {
    case "message_not_found":
      return unknownMessage(def, state, role, name);
    case "wrong_state": {
      const { phase, acceptedIn } = admission;
      return refusal("wrong_state", `${name} is accepted in ${acceptedIn.join(" or ")}; the actor is in ${phase}.`, {
        expected: acceptedIn,
        details: { phase },
      });
    }
    case "validation_failed":
      return invalidPayload(admission, name);
    case "guard_failed": {
      const caller = who === undefined ? "" : ` for caller "${who.caller}"`;
      return refusal(
        "guard_failed",
        `Guard rejected "${name}"${caller} (role "${role}"). Send it only when the guard allows it.`,
      );
    }
  }
}

/** No role matched the caller. */
export function refuseNoRole(caller: string, callerType: "user" | "service"): Refusal {
  return refusal(
    "no_role",
    `No role matched for caller "${caller}" (${callerType}). Add a catch-all role last in roles (e.g. viewer: () => true), or check the token's sub and act claims.`,
  );
}

/** A message sent before the actor was spawned. */
export function refuseNotInitialized(): Refusal {
  return refusal(
    "not_initialized",
    "The actor is not initialized. Spawn it with spawn({ input }) before sending messages.",
  );
}

/** A forward whose delivery metadata does not parse. */
export function refuseInvalidDelivery(detail: string): Refusal {
  return refusal(
    "invalid_delivery",
    `The forward's delivery metadata is invalid (${detail}). Send forwards only through ctx.forward().`,
  );
}
