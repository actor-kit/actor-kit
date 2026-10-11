/**
 * Typed refusals (ADR-018 C, D): why a message was not accepted, as a stable code.
 */

export type RefusalCode = "unknown_message" | "invalid_payload" | "guard_failed" | "wrong_state" | "no_role";

/** The admission errors of the step core, by refusal code. */
const ADMISSION_CODES = {
  message_not_found: "unknown_message",
  validation_failed: "invalid_payload",
  guard_failed: "guard_failed",
  wrong_state: "wrong_state",
} as const satisfies Record<string, RefusalCode>;

export type AdmissionError = keyof typeof ADMISSION_CODES;

export function refusalCode(error: AdmissionError): RefusalCode {
  return ADMISSION_CODES[error];
}

/** A refused message, thrown by testActor(): `code` says why. */
export class RefusalError extends Error {
  readonly code: RefusalCode;

  constructor(code: RefusalCode, message: string) {
    super(message);
    this.code = code;
  }
}
