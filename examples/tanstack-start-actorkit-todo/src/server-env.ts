import { getRequestHost } from "@tanstack/react-start/server";
import { z } from "zod";
import type { ActorEnv } from "./actor-env";

declare global {
  var __env__: unknown;
}

const DevServerEnvSchema = z.object({
  ACTOR_KIT_HOST: z.string().min(1).default("127.0.0.1:8790"),
  ACTOR_KIT_SECRET: z.string().min(1).default("actor-kit-dev-secret"),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDurableObjectNamespace(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.get === "function" &&
    typeof value.idFromName === "function"
  );
}

function isActorEnv(value: unknown): value is ActorEnv {
  return (
    isRecord(value) &&
    typeof value.ACTOR_KIT_SECRET === "string" &&
    isDurableObjectNamespace(value.TODO)
  );
}

export function getActorRuntimeEnv(): ActorEnv {
  if (!isActorEnv(globalThis.__env__)) {
    throw new Error("Actor Kit Cloudflare runtime bindings are unavailable");
  }

  return globalThis.__env__;
}

export function getServerEnv() {
  if (isActorEnv(globalThis.__env__)) {
    return {
      ACTOR_KIT_HOST: getRequestHost({ xForwardedHost: true }),
      ACTOR_KIT_SECRET: globalThis.__env__.ACTOR_KIT_SECRET,
    };
  }

  return DevServerEnvSchema.parse({
    ACTOR_KIT_HOST: process.env.ACTOR_KIT_HOST,
    ACTOR_KIT_SECRET: process.env.ACTOR_KIT_SECRET,
  });
}
