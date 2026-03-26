import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { callback } from "../../packages/actor-kit/src/core/callback";

describe("callback()", () => {
  it("creates a callback def with name and result schema", () => {
    const PriceReceived = callback("PRICE_RECEIVED", z.object({ total: z.number() }));

    expect(PriceReceived.key).toBe("PRICE_RECEIVED");
    expect(PriceReceived.resultSchema).toBeDefined();
  });

  it("infers the key as a literal type", () => {
    const PriceReceived = callback("PRICE_RECEIVED", z.object({ total: z.number() }));

    expectTypeOf(PriceReceived.key).toEqualTypeOf<"PRICE_RECEIVED">();
  });

  it("infers result type from Zod schema", () => {
    const PriceReceived = callback("PRICE_RECEIVED", z.object({ total: z.number() }));

    type Result = z.infer<typeof PriceReceived.resultSchema>;
    expectTypeOf<Result>().toEqualTypeOf<{ total: number }>();
  });

  it("creates a callback def with meta schema", () => {
    const PriceReceived = callback("PRICE_RECEIVED", z.object({ total: z.number() }), z.object({ itemId: z.string() }));

    expect(PriceReceived.key).toBe("PRICE_RECEIVED");
    expect(PriceReceived.resultSchema).toBeDefined();
    expect(PriceReceived.metaSchema).toBeDefined();
  });

  it("infers meta type from Zod schema", () => {
    const PriceReceived = callback(
      "PRICE_RECEIVED",
      z.object({ total: z.number() }),
      z.object({ itemId: z.string(), requestedBy: z.string() }),
    );

    type Meta = z.infer<NonNullable<typeof PriceReceived.metaSchema>>;
    expectTypeOf<Meta>().toEqualTypeOf<{ itemId: string; requestedBy: string }>();
  });

  it("without meta, metaSchema is undefined", () => {
    const PriceReceived = callback("PRICE_RECEIVED", z.object({ total: z.number() }));

    expect(PriceReceived.metaSchema).toBeUndefined();
  });

  it("validates result at runtime via resultSchema", () => {
    const PriceReceived = callback("PRICE_RECEIVED", z.object({ total: z.number() }));

    const valid = PriceReceived.resultSchema.safeParse({ total: 42 });
    expect(valid.success).toBe(true);

    const invalid = PriceReceived.resultSchema.safeParse({ total: "not a number" });
    expect(invalid.success).toBe(false);
  });

  it("validates meta at runtime via metaSchema", () => {
    const PriceReceived = callback("PRICE_RECEIVED", z.object({ total: z.number() }), z.object({ itemId: z.string() }));

    const valid = PriceReceived.metaSchema!.safeParse({ itemId: "widget-1" });
    expect(valid.success).toBe(true);

    const invalid = PriceReceived.metaSchema!.safeParse({ itemId: 123 });
    expect(invalid.success).toBe(false);
  });
});
