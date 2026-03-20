import { jwtVerify } from "jose";
import {
  CallerStringSchema,
  type Caller,
  type BaseActorKitStateMachine,
} from "@actor-kit/types";
import { Actor, SnapshotFrom } from "xstate";

// Define log levels
export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
}

// Declare a global variable to control debug level
declare global {
  var DEBUG_LEVEL: LogLevel | undefined;
}

// Set the current log level based on the global DEBUG_LEVEL variable
// Default to INFO if not set
const getCurrentLogLevel = (): LogLevel => {
  return globalThis.DEBUG_LEVEL !== undefined
    ? globalThis.DEBUG_LEVEL
    : LogLevel.INFO;
};

/**
 * Debug logging function
 * @param message The message to log
 * @param level The log level (default: DEBUG)
 * @param data Additional data to log (optional)
 */
export function debug(
  message: string,
  level: LogLevel = LogLevel.DEBUG,
  data?: unknown
) {
  const currentLogLevel = getCurrentLogLevel();
  if (level <= currentLogLevel) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${LogLevel[level]}: ${message}`;

    if (data) {
      console.log(logMessage, data);
    } else {
      console.log(logMessage);
    }

    // You can extend this to send logs to a service if needed
    // For example:
    // if (typeof fetch !== 'undefined') {
    //   fetch('https://your-logging-service.com', {
    //     method: 'POST',
    //     body: JSON.stringify({ message: logMessage, level, data }),
    //   });
    // }
  }
}

// Convenience methods for different log levels
export const logError = (message: string, data?: unknown) =>
  debug(message, LogLevel.ERROR, data);
export const logWarn = (message: string, data?: unknown) =>
  debug(message, LogLevel.WARN, data);
export const logInfo = (message: string, data?: unknown) =>
  debug(message, LogLevel.INFO, data);

export const json = <T>(data: T, status = 200) =>
  Response.json(data, { status });

export const ok = () => json({ ok: true });

export const error = (err: string | { message: string }, status = 500) => {
  console.error("Error response", err);
  return json(
    {
      ok: false,
      error: typeof err === "string" ? err : err.message ?? "Unknown error",
    },
    status
  );
};

export const notFound = () => error("Not found", 404);

/**
 * Parses query parameters from a URL string.
 * @param url The URL to parse.
 * @returns A URLSearchParams object containing the parsed query parameters.
 */
export const parseQueryParams = (url: string) => {
  const index = url.indexOf("?");
  const search = index !== -1 ? url.substring(index + 1) : "";
  return new URLSearchParams(search);
};

export function assert<T>(
  expression: T,
  errorMessage: string
): asserts expression {
  if (!expression) {
    const error = new Error(errorMessage);
    const stack = error.stack?.split("\n");

    // Find the line in the stack trace that corresponds to where the assert was called.
    // This is typically the third line in the stack, but this may vary depending on the JS environment.
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
  const verified = await jwtVerify(accessToken, new TextEncoder().encode(secret));
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

export function getSnapshot<TMachine extends BaseActorKitStateMachine>(
  actor: Actor<TMachine>
): SnapshotFrom<TMachine> | undefined {
  return actor.getSnapshot();
}
