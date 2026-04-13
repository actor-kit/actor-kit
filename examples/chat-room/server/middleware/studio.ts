// Nitro middleware: intercepts /__studio/* requests for Actor Kit Studio.
// Must be loaded before actor-kit.ts middleware.

import { actorKitStudio } from "@actor-kit/studio";
import { getActorRuntimeEnv } from "../../src/server-env";

interface MiddlewareEvent {
  req: Request;
}

export default function studioMiddleware(event: MiddlewareEvent) {
  const url = new URL(event.req.url);
  if (!url.pathname.startsWith("/__studio")) {
    return undefined;
  }

  const env = getActorRuntimeEnv();
  const result = actorKitStudio(event.req, env, { waitUntil: () => {}, passThroughOnException: () => {} });
  return result ?? undefined;
}
