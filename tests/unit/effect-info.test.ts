/**
 * ADR-016 §1: the effect a service runs for carries its actor. Effect ids (`seq:index`) are unique only
 * within one actor; the idempotency key `${actorType}/${actorId}/${effectId}` is unique across a
 * deployment. Forwards carry the same fields (minus the signal) to their target.
 */

import { DeliveryInfoSchema, deliveryInfo, effectInfo, idempotencyKey } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";

describe("idempotencyKey", () => {
  it("is actorType/actorId/effectId", () => {
    expect(idempotencyKey("checkout", "room-7", "812:0")).toBe("checkout/room-7/812:0");
  });

  it("differs for two actors at the same journal position", () => {
    expect(idempotencyKey("checkout", "a", "1:0")).not.toBe(idempotencyKey("checkout", "b", "1:0"));
    expect(idempotencyKey("checkout", "a", "1:0")).not.toBe(idempotencyKey("refund", "a", "1:0"));
  });
});

describe("effectInfo", () => {
  it("carries the actor, the effect id, its idempotency key, the try number and the signal", () => {
    const signal = new AbortController().signal;
    const info = effectInfo({
      actorType: "checkout",
      actorId: "room-7",
      effectId: "3:1",
      attempt: 2,
      signal,
      audit: {},
    });
    expect(info).toEqual({
      actorType: "checkout",
      actorId: "room-7",
      effectId: "3:1",
      idempotencyKey: "checkout/room-7/3:1",
      attempt: 2,
      signal,
      record: expect.any(Function),
    });
    expect(info.signal).toBe(signal);
  });
});

describe("deliveryInfo", () => {
  it("is the effect info a forward's target gets: the same fields without the signal", () => {
    expect(deliveryInfo({ actorType: "courier", actorId: "c-1", effectId: "4:0", attempt: 3 })).toEqual({
      actorType: "courier",
      actorId: "c-1",
      effectId: "4:0",
      idempotencyKey: "courier/c-1/4:0",
      attempt: 3,
    });
  });

  it("parses at the target's boundary and refuses anything else", () => {
    const valid = deliveryInfo({ actorType: "courier", actorId: "c-1", effectId: "4:0", attempt: 1 });
    expect(DeliveryInfoSchema.parse(valid)).toEqual(valid);
    expect(DeliveryInfoSchema.safeParse({ ...valid, attempt: 0 }).success).toBe(false);
    expect(DeliveryInfoSchema.safeParse({ ...valid, attempt: 1.5 }).success).toBe(false);
    expect(DeliveryInfoSchema.safeParse({ ...valid, idempotencyKey: "" }).success).toBe(false);
    expect(DeliveryInfoSchema.safeParse({ ...valid, actorType: "" }).success).toBe(false);
    expect(DeliveryInfoSchema.safeParse({ ...valid, actorId: "" }).success).toBe(false);
    expect(DeliveryInfoSchema.safeParse({ ...valid, effectId: "" }).success).toBe(false);
    expect(DeliveryInfoSchema.safeParse("courier/c-1/4:0").success).toBe(false);
  });
});
