import { testActor } from "@actor-kit/test";
import { callback, message } from "@actor-kit/worker/testing";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

// --- Callback definitions ---

const PriceReceived = callback("PRICE_RECEIVED", z.object({ total: z.number() }), z.object({ itemId: z.string() }));

const PriceFailed = callback("PRICE_FAILED", z.object({ message: z.string() }), z.object({ itemId: z.string() }));

const SimpleCallback = callback("SIMPLE_DONE", z.object({ ok: z.boolean() }));

// --- Actor definition for testing ---

type PriceState = {
  prices: Record<string, number>;
  errors: string[];
  status: string;
};

const fetchPrice = message(z.object({ itemId: z.string() }), (state: PriceState, { itemId }, { request }) => {
  request({
    fetch: `https://api.example.com/prices/${itemId}`,
    onDone: PriceReceived,
    onError: PriceFailed,
    meta: { itemId },
  });
  return { ...state, status: "loading" };
});

const simpleAction = message(z.object({}), (state: PriceState, _payload, { request }) => {
  // No meta — SimpleCallback has void meta
  request({
    fetch: "https://api.example.com/ping",
    onDone: SimpleCallback,
    onError: PriceFailed,
    meta: { itemId: "fallback" },
  });
  return state;
});

const priceDef = {
  input: z.object({}),
  init: (): PriceState => ({ prices: {}, errors: [], status: "idle" }),
  roles: { user: () => true },
  messages: {
    user: { FETCH_PRICE: fetchPrice, SIMPLE: simpleAction },
  },
  on: {
    PRICE_RECEIVED: (state: PriceState, result: unknown) => {
      const r = result as { total: number };
      return { ...state, prices: { ...state.prices, widget: r.total }, status: "loaded" };
    },
    PRICE_FAILED: (state: PriceState, error: unknown) => {
      const e = error as { message: string };
      return { ...state, errors: [...state.errors, e.message], status: "failed" };
    },
    SIMPLE_DONE: (state: PriceState) => {
      return { ...state, status: "pinged" };
    },
  },
  views: {},
};

describe("typed request() with callback defs", () => {
  it("request() accepts CallbackDef objects for onDone/onError", () => {
    const t = testActor(priceDef);
    const state = t.init({});

    // This should not throw — callback defs are accepted
    expect(async () => {
      await t.sendWithEffects(state, "alice", { type: "FETCH_PRICE", itemId: "widget" });
    }).not.toThrow();
  });

  it("sendWithEffects captures requests with callback keys", async () => {
    const t = testActor(priceDef);
    const state = t.init({});

    const { requests } = await t.sendWithEffects(state, "alice", {
      type: "FETCH_PRICE",
      itemId: "widget",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      effect: { fetch: "https://api.example.com/prices/widget" },
      onDone: "PRICE_RECEIVED",
      onError: "PRICE_FAILED",
    });
  });

  it("sendWithEffects captures meta from request", async () => {
    const t = testActor(priceDef);
    const state = t.init({});

    const { requests } = await t.sendWithEffects(state, "alice", {
      type: "FETCH_PRICE",
      itemId: "widget",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toHaveProperty("meta", { itemId: "widget" });
  });

  it("request without meta works (void meta callback)", async () => {
    const t = testActor(priceDef);
    const state = t.init({});

    const { requests } = await t.sendWithEffects(state, "alice", { type: "SIMPLE" });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      onDone: "SIMPLE_DONE",
    });
  });
});
