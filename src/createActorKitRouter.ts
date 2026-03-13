import { z } from "zod";
import { AnyEventSchema } from "./schemas";
import {
  AnyEvent,
  Caller,
  ActorKitEnv,
  KebabToScreamingSnake,
  ScreamingSnakeToKebab,
} from "./types";
import { getCallerFromRequest } from "./utils";

const SnapshotRequestSearchSchema = z.object({
  waitForEvent: z.string().optional(),
  waitForState: z.string().optional(),
  timeout: z
    .string()
    .transform((value) => Number.parseInt(value, 10))
    .pipe(z.number().int().positive())
    .optional(),
  errorOnWaitTimeout: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
});

type ActorKitDurableObjectStub = {
  spawn(props: {
    actorType: string;
    actorId: string;
    caller: Caller;
    input: Record<string, unknown>;
  }): Promise<void> | void;
  getSnapshot(
    caller: Caller,
    options?: {
      waitForEvent?: unknown;
      waitForState?: unknown;
      timeout?: number;
      errorOnWaitTimeout?: boolean;
    }
  ): Promise<{
    checksum: string;
    snapshot: unknown;
  }>;
  send(event: { caller: Caller; type: string }): void;
  fetch(request: Request): Promise<Response>;
};

type ActorKitNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): ActorKitDurableObjectStub;
};

export const createActorKitRouter = <Env extends ActorKitEnv>(
  routes: Array<ScreamingSnakeToKebab<Extract<keyof Env, string>>>
) => {
  type ActorType = ScreamingSnakeToKebab<Extract<keyof Env, string>>;

  // Add a Set to keep track of spawned actors
  const spawnedActors = new Set<string>();

  function getDurableObjectNamespace<
    T extends ScreamingSnakeToKebab<Extract<keyof Env, string>>
  >(
    env: Env,
    key: T
  ): ActorKitNamespace | undefined {
    const envKey = key.toUpperCase() as KebabToScreamingSnake<T> & keyof Env;
    const namespace = env[envKey];
    if (
      namespace &&
      typeof namespace === "object" &&
      "get" in namespace &&
      "idFromName" in namespace
    ) {
      return namespace as unknown as ActorKitNamespace;
    }
    return undefined;
  }

  return async (
    request: Request,
    env: Env,
    _ctx?: unknown
  ): Promise<Response> => {
    const url = new URL(request.url);
    const pathParts = url.pathname.split("/").filter(Boolean);
    if (pathParts.length !== 3 || pathParts[0] !== "api") {
      return new Response("Not Found", { status: 404 });
    }
    const [, actorType, actorId] = pathParts;

    if (!routes.includes(actorType as ActorType)) {
      return new Response(`Unknown actor type: ${actorType}`, { status: 400 });
    }

    const durableObjectNamespace = getDurableObjectNamespace<ActorType>(
      env,
      actorType as ActorType
    );

    if (!durableObjectNamespace) {
      return new Response(
        `Durable Object namespace not found for actor type: ${actorType}`,
        { status: 500 }
      );
    }

    const durableObjectId = durableObjectNamespace.idFromName(actorId);
    const durableObjectStub = durableObjectNamespace.get(durableObjectId);

    // Parse the auth header to get the caller token
    let caller: Caller;
    try {
      caller = await getCallerFromRequest(
        request,
        actorType,
        actorId,
        env.ACTOR_KIT_SECRET
      );
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      return new Response(
        `Error: ${errorMessage}. API requests must specify a valid caller in Bearer token in the Authorization header using fetch method created from 'createActorFetch' or use 'createAccessToken' directly.`,
        { status: 401 }
      );
    }

    // Create a unique key for the actor
    const actorKey = `${actorType}:${actorId}`;

    // Check if the actor has already been spawned
    if (!spawnedActors.has(actorKey)) {
      // If not, spawn it and mark it as spawned
      await durableObjectStub.spawn({
        actorType,
        actorId,
        caller,
        input: {},
      });
      spawnedActors.add(actorKey);
    }

    if (request.headers.get("Upgrade") === "websocket") {
      return durableObjectStub.fetch(request);
    }

    if (request.method === "GET") {
      const searchParams = SnapshotRequestSearchSchema.parse(
        Object.fromEntries(new URL(request.url).searchParams)
      );

      const result = await durableObjectStub.getSnapshot(caller, {
        waitForEvent: searchParams.waitForEvent
          ? AnyEventSchema.parse(JSON.parse(searchParams.waitForEvent))
          : undefined,
        waitForState: searchParams.waitForState
          ? JSON.parse(searchParams.waitForState)
          : undefined,
        timeout: searchParams.timeout,
        errorOnWaitTimeout: searchParams.errorOnWaitTimeout,
      });
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    } else if (request.method === "POST") {
      let event: AnyEvent;
      try {
        const json = await request.json();
        event = AnyEventSchema.parse(json);
      } catch (ex: unknown) {
        const errorMessage = ex instanceof Error ? ex.message : "Invalid JSON";
        return new Response(JSON.stringify({ error: errorMessage }), {
          status: 400,
        });
      }

      durableObjectStub.send({
        ...event,
        caller,
      });
      return new Response(JSON.stringify({ success: true }));
    } else {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
      });
    }
  };
};
