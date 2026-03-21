import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import type { Caller, CallerType } from "./types";

const CallerIdTypeSchema = z.enum(["client", "service"]);

const CallerStringSchema = z.string().transform((val, ctx) => {
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
  const id = parts.slice(1).join("-");

  const callerTypeParseResult = CallerIdTypeSchema.safeParse(typeStr);
  if (!callerTypeParseResult.success) {
    callerTypeParseResult.error.issues.forEach(ctx.addIssue);
    return z.NEVER;
  }
  const type = callerTypeParseResult.data;

  if (id.length > 0) {
    return { type, id };
  } else {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `The ID part cannot be empty after the type prefix. Received '${id}' for value '${val}'.`,
    });
    return z.NEVER;
  }
});

export function assert<T>(
  expression: T,
  errorMessage: string
): asserts expression {
  if (!expression) {
    const error = new Error(errorMessage);
    const stack = error.stack?.split("\n");
    const assertLine =
      stack && stack.length >= 3 ? stack[2] : "unknown location";
    throw new Error(`${errorMessage} (Assert failed at ${assertLine?.trim()})`);
  }
}

export async function getCallerFromRequest(
  request: Request,
  actorType: string,
  actorId: string,
  secret: string
): Promise<Caller> {
  let accessToken: string;
  if (request.headers.get("Upgrade") !== "websocket") {
    const authHeader = request.headers.get("Authorization");
    const stringPart = authHeader?.split(" ")[1];
    assert(stringPart, "Expected authorization header to be set");
    accessToken = stringPart;
  } else {
    const searchParams = new URLSearchParams(request.url.split("?")[1]);
    const paramString = searchParams.get("accessToken");
    assert(paramString, "expected accessToken when connecting to socket");
    accessToken = paramString;
  }

  return parseAccessTokenForCaller({
    accessToken,
    type: actorType,
    id: actorId,
    secret,
  });
}

export async function parseAccessTokenForCaller({
  accessToken,
  type,
  id,
  secret,
}: {
  accessToken: string;
  type: string;
  id: string;
  secret: string;
}): Promise<Caller> {
  const verified = await jwtVerify(
    accessToken,
    new TextEncoder().encode(secret)
  );
  if (!verified.payload.jti) {
    throw new Error("Expected JTI on accessToken");
  }
  if (verified.payload.jti !== id) {
    throw new Error(`Expected JTI on accessToken to match actor id: ${id}`);
  }
  if (!verified.payload.aud) {
    throw new Error(
      `Expected accessToken audience to match actor type: ${type}`
    );
  }
  const audience = Array.isArray(verified.payload.aud)
    ? verified.payload.aud
    : [verified.payload.aud];
  if (!audience.includes(type)) {
    throw new Error(
      `Expected accessToken audience to match actor type: ${type}`
    );
  }
  if (!verified.payload.sub) {
    throw new Error("Expected accessToken to have subject");
  }
  return CallerStringSchema.parse(verified.payload.sub);
}

export async function createAccessToken({
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
}): Promise<string> {
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
}
