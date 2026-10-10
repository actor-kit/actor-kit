/**
 * Studio's outbox projection and typed service errors (ADR-016 §2): a declared error's text is its JSON, an
 * application value, so `studio.redact` applies to it like to a payload. Built-in errors and untagged
 * text are runtime messages and pass as they are.
 */
import { describe, expect, it } from "vitest";
import { projectOutboxRow, type StudioProjection } from "../../packages/worker/src/runtime/studio-project";
import { compileRedaction, REDACTED } from "../../packages/worker/src/runtime/studio-redact";

const human = (patterns: string[]): StudioProjection => ({ redactor: compileRedaction(patterns), hashCaller: null });

const row = (lastError: string | null, lastErrorTag?: string) => ({
  id: "2:0",
  service: "charge",
  payload: "{}",
  status: "failed",
  attempts: 1,
  createdAt: 1,
  nextAttemptAt: null,
  lastError,
  ...(lastErrorTag === undefined ? {} : { lastErrorTag }),
});

describe("projectOutboxRow and the last error", () => {
  it("redacts a declared error's fields like any application value", () => {
    const projected = projectOutboxRow(
      row('{"_tag":"CardDeclined","holder":"Juneau"}', "CardDeclined"),
      human(["holder"]),
    );
    expect(JSON.parse(projected.lastError ?? "")).toEqual({ _tag: "CardDeclined", holder: REDACTED });
    expect(projected.lastErrorTag).toBe("CardDeclined");
  });

  it("leaves built-in errors, untagged errors and rows without an error alone", () => {
    const redact = human(["holder"]);
    expect(projectOutboxRow(row("holder Juneau", "Defect"), redact).lastError).toBe("holder Juneau");
    expect(projectOutboxRow(row("timed out after 5ms", "Timeout"), redact).lastError).toBe("timed out after 5ms");
    expect(projectOutboxRow(row("cancelled"), redact).lastError).toBe("cancelled");
    expect(projectOutboxRow(row(null, "CardDeclined"), redact).lastError).toBeNull();
  });

  it("without redaction a declared error passes as it is", () => {
    const text = '{"_tag":"CardDeclined","holder":"Juneau"}';
    expect(projectOutboxRow(row(text, "CardDeclined"), human([])).lastError).toBe(text);
  });
});
