import {
  DurableObjectNamespace,
} from "@cloudflare/workers-types";
import { AnyEventSchema } from "./schemas";
import {
  AnyActorKitStateMachine,
  AnyEvent,
  Caller,
  DurableObjectActor,
  EnvWithDurableObjects,
  KebabToScreamingSnake,
  ScreamingSnakeToKebab,
} from "./types";
import { getCallerFromRequest } from "./utils";

export const createActorKitRouter = <Env extends EnvWithDurableObjects>(
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
  ):
    | DurableObjectNamespace<DurableObjectActor<AnyActorKitStateMachine>>
    | undefined {
    const envKey = key.toUpperCase() as KebabToScreamingSnake<T> & keyof Env;
    const namespace = env[envKey];
    if (
      namespace &&
      typeof namespace === "object" &&
      "get" in namespace &&
      "idFromName" in namespace
    ) {
      return namespace as unknown as DurableObjectNamespace<
        DurableObjectActor<AnyActorKitStateMachine>
      >;
    }
    return undefined;
  }

  return async (
    request: Request,
    env: Env
  ): Promise<Response> => {
    const url = new URL(request.url);
    const pathParts = url.pathname.split("/").filter(Boolean);
    if (pathParts.length !== 3 || pathParts[0] !== "api") {
      return new Response("Not Found", { status: 404 });
    }
    const [, actorType, actorId] = pathParts;

    if (!routes.includes(actorType as any)) {
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
    } catch (error: any) {
      return new Response(
        `Error: ${error.message}. API requests must specify a valid caller in Bearer token in the Authorization header using fetch method created from 'createActorFetch' or use 'createAccessToken' directly.`,
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
      return durableObjectStub.fetch(request as any) as any; // Handle WebSocket upgrade
    }

    if (request.method === "GET") {
      const { waitForEvent, waitForState, timeout, errorOnWaitTimeout } = 
        Object.fromEntries(new URL(request.url).searchParams);
      
      const result = await durableObjectStub.getSnapshot(caller, {
        waitForEvent: waitForEvent ? JSON.parse(waitForEvent) : undefined,
        waitForState: waitForState ? JSON.parse(waitForState) : undefined,
        timeout: timeout ? parseInt(timeout, 10) : undefined,
        errorOnWaitTimeout: errorOnWaitTimeout ? errorOnWaitTimeout === 'true' : undefined,
      });
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    } else if (request.method === "POST") {
      let event: AnyEvent;
      try {
        const json = await request.json();
        event = AnyEventSchema.parse(json);
      } catch (ex: any) {
        return new Response(JSON.stringify({ error: ex.message }), {
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
