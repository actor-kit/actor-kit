/// <reference types="@remix-run/cloudflare" />
/// <reference types="@remix-run/cloudflare-workers" />
/// <reference types="@remix-run/server-runtime" />

// Import ActorKitEnv type
import type { ActorKitEnv } from "actor-kit";

// Declare the global Env interface
declare global {
  interface Env extends ActorKitEnv {
    REMIX: DurableObjectNamespace;
    TODO: DurableObjectNamespace;
    SESSION: DurableObjectNamespace;
    NODE_ENV: string;
    ACTOR_KIT_HOST: string;
    ACTOR_KIT_SECRET: string;
  }
}

declare module "@remix-run/cloudflare" {
  interface AppLoadContext {
    env: Env;
    sessionId: string;
    userId: string;
    pageSessionId: string;
  }

  // Re-export types that should be available
  export interface LoaderFunctionArgs {
    request: Request;
    params: Record<string, string | undefined>;
    context: AppLoadContext;
  }

  export interface LinksFunction {
    (): Array<{
      rel: string;
      href: string;
    }>;
  }

  export interface EntryContext {
    manifest: any;
    routeModules: any;
    staticHandlerContext: any;
    future: any;
    isSpaMode: boolean;
  }
}

declare module "@remix-run/server-runtime" {
  interface AppLoadContext {
    env: Env;
    sessionId: string;
    userId: string;
    pageSessionId: string;
  }
} 