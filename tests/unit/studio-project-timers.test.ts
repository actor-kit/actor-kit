import { describe, expect, it } from "vitest";
import { projectTimerRow, type StudioProjection } from "../../packages/worker/src/runtime/studio-project";
import { compileRedaction, REDACTED } from "../../packages/worker/src/runtime/studio-redact";

const row = {
  id: "4:1",
  name: "roundEnd",
  key: "round-1",
  payload: JSON.stringify({ round: 1, secret: "s3" }),
  fireAt: 900,
  createdAt: 100,
};

describe("projectTimerRow (ADR-014 redaction, ADR-015 D2)", () => {
  it("redacts the payload relative to its own root and keeps the rest", () => {
    const projection: StudioProjection = { redactor: compileRedaction(["secret"]), hashCaller: null };
    const projected = projectTimerRow(row, projection);
    expect({ ...projected, payload: JSON.parse(projected.payload) }).toEqual({
      ...row,
      payload: { round: 1, secret: REDACTED },
    });
  });

  it("passes the payload through untouched when nothing is redacted", () => {
    const projection: StudioProjection = { redactor: compileRedaction(undefined), hashCaller: null };
    expect(projectTimerRow(row, projection)).toEqual(row);
  });
});
