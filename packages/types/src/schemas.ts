import type { Operation } from "fast-json-patch";
import { z } from "zod";

export const BotManagementSchema = z.object({
  corporateProxy: z.boolean(),
  verifiedBot: z.boolean(),
  jsDetection: z.object({
    passed: z.boolean(),
  }),
  staticResource: z.boolean(),
  detectionIds: z.record(z.any()),
  score: z.number(),
});

export const EnvironmentSchema = z.object({
  ACTOR_KIT_SECRET: z.string(),
  ACTOR_KIT_HOST: z.string(),
});

export const RequestInfoSchema = z.object({
  longitude: z.string(),
  latitude: z.string(),
  continent: z.string(),
  country: z.string(),
  city: z.string(),
  timezone: z.string(),
  postalCode: z.string(),
  region: z.string(),
  regionCode: z.string(),
  metroCode: z.string(),
  botManagement: BotManagementSchema,
});

export const CallerSchema = z.object({
  id: z.string(),
  type: z.enum(["client", "system", "service"]),
});

export const AnyEventSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

export const SystemEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("INITIALIZE"),
    caller: z.object({ type: z.literal("system"), id: z.string() }),
  }),
  z.object({
    type: z.literal("CONNECT"),
    caller: z.object({ type: z.literal("system"), id: z.string() }),
    connectingCaller: CallerSchema,
  }),
  z.object({
    type: z.literal("DISCONNECT"),
    caller: z.object({ type: z.literal("system"), id: z.string() }),
    disconnectingCaller: CallerSchema,
  }),
  z.object({
    type: z.literal("RESUME"),
    caller: z.object({ type: z.literal("system"), id: z.string() }),
  }),
  z.object({
    type: z.literal("MIGRATE"),
    caller: z.object({ type: z.literal("system"), id: z.string() }),
    operations: z.array(z.any()),
  }),
]);

/**
 * Validates an emitted event from the actor-kit WebSocket protocol.
 *
 * The Zod schema validates `op` is a valid JSON Patch operation string,
 * then transforms the output to `Operation[]` from fast-json-patch.
 * This is safe because Zod has validated the `op` values match the
 * discriminated union variants — the transform bridges Zod's flat
 * object output to fast-json-patch's discriminated union type.
 */
export const EmittedEventSchema = z.object({
  operations: z
    .array(
      z.object({
        op: z.enum([
          "add",
          "remove",
          "replace",
          "move",
          "copy",
          "test",
          "_get",
        ]),
        path: z.string(),
        value: z.unknown().optional(),
        from: z.string().optional(),
      })
    )
    .transform((ops): Operation[] => ops as unknown as Operation[]),
  checksum: z.string(),
});

export const CallerIdTypeSchema = z.enum(["client", "service", "system"]);

export const CallerStringSchema = z.string().transform((val, ctx) => {
  if (val === "anonymous") {
    return { type: "client" as const, id: "anonymous" };
  }

  const parts = val.split("-");
  if (parts.length < 2) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Caller string must be in the format 'type-id' or 'anonymous'. Received '${val}'.`,
    });
    return z.NEVER;
  }

  const typeStr = parts[0];
  const id = parts.slice(1).join("-"); // Rejoin in case id contains hyphens

  const callerTypeParseResult = CallerIdTypeSchema.safeParse(typeStr);
  if (!callerTypeParseResult.success) {
    callerTypeParseResult.error.issues.forEach(ctx.addIssue);
    return z.NEVER;
  }
  const type = callerTypeParseResult.data;

  // Basic validation: Ensure the ID part is not empty
  if (id.length > 0) {
    return { type, id };
  } else {
    // If the ID part is empty, add a custom issue
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `The ID part cannot be empty after the type prefix. Received '${id}' for value '${val}'.`,
    });
    // Return the special NEVER symbol to indicate a validation failure
    return z.NEVER;
  }
});
