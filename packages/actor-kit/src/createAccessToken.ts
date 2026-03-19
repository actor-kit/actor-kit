import { SignJWT } from "jose";
import { CallerStringSchema } from "./schemas";
import { CallerType } from "./types";

// Export utility functions
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
