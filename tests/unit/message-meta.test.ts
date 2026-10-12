/**
 * A message's RPC metadata carries two things across actors: the forward's delivery (ADR-016 §1:
 * actor, effect id, idempotency key, try) and the flow it continues (ADR-017 §4: correlation and
 * causation ids). A forward sends both in one object; a direct send sends neither.
 *
 * Delivery is checked strictly (a target dedupes on it, so a malformed one is refused); a trace
 * that does not parse only starts a new flow.
 */

import { forwardMeta, parseMessageMeta } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";

const delivery = {
  actorType: "teller",
  actorId: "t-1",
  effectId: "4:0",
  idempotencyKey: "teller/t-1/4:0",
  attempt: 2,
};
const trace = { correlationId: "teller/t-1/3", causationId: "teller/t-1/4:0" };

describe("parseMessageMeta", () => {
  it("no metadata: no delivery, no trace", () => {
    expect(parseMessageMeta(undefined)).toEqual({ ok: true, delivery: undefined, trace: undefined });
  });

  it("a forward's metadata: both its delivery and its trace", () => {
    expect(parseMessageMeta({ ...delivery, ...trace })).toEqual({ ok: true, delivery, trace });
  });

  it("delivery alone (no trace): the delivery, a new flow", () => {
    expect(parseMessageMeta(delivery)).toEqual({ ok: true, delivery, trace: undefined });
  });

  it("a trace alone: no delivery, the trace", () => {
    expect(parseMessageMeta(trace)).toEqual({ ok: true, delivery: undefined, trace });
  });

  it("a trace that does not parse starts a new flow, but the message is still taken", () => {
    expect(parseMessageMeta({ correlationId: "" })).toEqual({ ok: true, delivery: undefined, trace: undefined });
    expect(parseMessageMeta({ ...delivery, correlationId: "x" })).toEqual({ ok: true, delivery, trace: undefined });
  });

  it("refuses metadata that claims a delivery but does not parse", () => {
    const refused = parseMessageMeta({ ...delivery, idempotencyKey: "" });
    expect(refused).toMatchObject({ ok: false, error: "invalid_delivery" });
    expect(parseMessageMeta({ effectId: "1:0" })).toMatchObject({ ok: false, error: "invalid_delivery" });
    expect(parseMessageMeta({ attempt: 1, ...trace })).toMatchObject({ ok: false, error: "invalid_delivery" });
  });

  it("refuses metadata that is not an object", () => {
    for (const meta of ["teller/t-1/4:0", 3, null, [delivery]]) {
      expect(parseMessageMeta(meta)).toMatchObject({ ok: false, error: "invalid_delivery" });
    }
  });

  it("says why metadata that is not an object is refused", () => {
    expect(parseMessageMeta("teller/t-1/4:0")).toEqual({
      ok: false,
      error: "invalid_delivery",
      detail: "message metadata must be an object",
    });
  });

  it("keeps only the delivery's own fields", () => {
    const parsed = parseMessageMeta({ ...delivery, ...trace, extra: 1 });
    expect(parsed).toEqual({ ok: true, delivery, trace });
  });
});

describe("forwardMeta", () => {
  it("is the delivery and the trace in one object, and parses back to both", () => {
    const meta = forwardMeta(delivery, trace);
    expect(meta).toEqual({ ...delivery, ...trace });
    expect(parseMessageMeta(meta)).toEqual({ ok: true, delivery, trace });
  });
});
