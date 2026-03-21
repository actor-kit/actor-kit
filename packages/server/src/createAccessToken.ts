import { SignJWT } from "jose";
import { z } from "zod";

type CallerType = "client" | "service";

const CallerIdTypeSchema = z.enum(["client", "service"]);

const CallerStringSchema = z.string().transform((val, ctx) => {
  const parts = val.split("-");
  if (parts.length < 2) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Caller string must be in format 'type-id'. Received '${val}'.`,
    });
    return z.NEVER;
  }
  const typeStr = parts[0];
  const id = parts.slice(1).join("-");
  const callerTypeResult = CallerIdTypeSchema.safeParse(typeStr);
  if (!callerTypeResult.success) {
    callerTypeResult.error.issues.forEach(ctx.addIssue);
    return z.NEVER;
  }
  if (id.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `ID part cannot be empty. Received '${val}'.`,
    });
    return z.NEVER;
  }
  return { type: callerTypeResult.data, id };
});

export const createAccessToken = async ({
  signingKey,
  actorId,
  actorType,
  callerId,
  callerType,
}: {
  signingKey: string;
  actorId: string;
  actorType: string;
  callerId: string;
  callerType: CallerType;
}) => {
  const subject = `${callerType}-${callerId}`;
  CallerStringSchema.parse(subject);
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setJti(actorId)
    .setSubject(subject)
    .setAudience(actorType)
    .setExpirationTime("30d")
    .sign(new TextEncoder().encode(signingKey));
  return token;
};
