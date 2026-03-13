import { type PlatformProxy } from "wrangler";

type GetLoadContextArgs = {
  request: Request;
  context: {
    cloudflare: Omit<PlatformProxy<Env>, "dispose" | "caches" | "cf"> & {
      caches: PlatformProxy<Env>["caches"] | CacheStorage;
      cf: Request["cf"];
      env: Env;
    };
  };
};

declare module "@remix-run/cloudflare" {
  interface AppLoadContext extends ReturnType<typeof getLoadContext> {
    // This will merge the result of `getLoadContext` into the `AppLoadContext`
  }
}

export function getLoadContext({ context, request }: GetLoadContextArgs) {
  return {
    ...context,
    // Extract env from cloudflare context
    env: context.cloudflare.env,
    // Add our custom properties for actor-kit
    sessionId: getSessionIdFromRequest(request),
    userId: getUserIdFromRequest(request),
    pageSessionId: crypto.randomUUID(),
  };
}

// Helper functions to extract session/user info from request
function getSessionIdFromRequest(_request: Request): string {
  // This would typically come from cookies or headers
  // For now, generate a random one
  return crypto.randomUUID();
}

function getUserIdFromRequest(_request: Request): string {
  // This would typically come from authentication
  // For now, generate a random one
  return crypto.randomUUID();
} 
