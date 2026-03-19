/**
 * fromActorKit — XState callback actor for DO-to-DO communication.
 *
 * Creates an XState `fromCallback` actor that connects a parent actor-kit
 * Durable Object to a remote child actor-kit DO via WebSocket. The callback:
 *
 * 1. Spawns the remote DO (idempotent)
 * 2. Creates a JWT for the remote actor
 * 3. Opens a WebSocket via stub.fetch() with Upgrade header
 * 4. Receives JSON Patch snapshot updates → emits {TYPE}_UPDATED to parent
 * 5. Forwards events from parent → remote DO (validated via Zod schema)
 * 6. Queues events sent before WebSocket is ready
 * 7. Cleans up WebSocket on actor stop
 *
 * @example
 * ```ts
 * const sessionMachine = setup({
 *   actors: {
 *     zone: fromActorKit<ZoneMachine>("zone"),
 *   },
 * }).createMachine({
 *   invoke: {
 *     id: "zone",
 *     src: "zone",
 *     input: ({ context }) => ({
 *       server: context.env.ZONE,
 *       actorId: context.public.zoneId,
 *       actorInput: {},
 *       caller: { id: context.public.playerId, type: "service" as const },
 *       signingKey: context.env.ACTOR_KIT_SECRET,
 *       eventSchema: ZoneServiceEventSchema,
 *     }),
 *   },
 *   on: { ZONE_UPDATED: { actions: "syncZoneSnapshot" } },
 * });
 * ```
 *
 * @module
 */
import { applyPatch } from "fast-json-patch";
import type { Operation } from "fast-json-patch";
import { produce } from "immer";
import type { CallbackLogicFunction } from "xstate";
import { fromCallback } from "xstate";
import type { z } from "zod";
import { createAccessToken } from "./createAccessToken";
import type {
  ActorKitEmittedEvent,
  AnyActorKitStateMachine,
  Caller,
  CallerSnapshotFrom,
} from "./types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Convert kebab-case to SCREAMING_SNAKE: `"my-actor"` → `"MY_ACTOR"` */
type KebabToScreamingSnake<S extends string> = string extends S
  ? string
  : S extends `${infer Head}-${infer Tail}`
    ? `${Uppercase<Head>}_${KebabToScreamingSnake<Tail>}`
    : Uppercase<S>;

/** Events emitted back to the parent machine. */
export type FromActorKitEmitted<
  TActorType extends string,
  TMachine extends AnyActorKitStateMachine,
> =
  | {
      type: `${KebabToScreamingSnake<TActorType>}_UPDATED`;
      actorType: TActorType;
      actorId: string;
      snapshot: CallerSnapshotFrom<TMachine>;
      operations: Operation[];
    }
  | {
      type: `${KebabToScreamingSnake<TActorType>}_ERROR`;
      actorType: TActorType;
      actorId: string;
      error: Error;
    };

/**
 * Minimal interface for a DO namespace — compatible with both
 * `DurableObjectNamespace` (untyped) and `DurableObjectNamespace<T>` (RPC-typed).
 */
export interface ActorKitNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): {
    fetch(request: Request): Promise<Response>;
    spawn?(props: {
      actorType: string;
      actorId: string;
      caller: Caller;
      input: Record<string, unknown>;
    }): Promise<void> | void;
    [key: string]: unknown;
  };
}

/** Input the parent must provide when invoking the callback actor. */
export interface FromActorKitInput<
  TEventSchema extends z.ZodTypeAny = z.ZodTypeAny,
> {
  /** DO namespace binding for the remote actor (e.g. `env.ZONE`). */
  server: ActorKitNamespaceLike;
  /** ID of the remote actor instance. */
  actorId: string;
  /** Input props forwarded to the remote actor on spawn. */
  actorInput: Record<string, unknown>;
  /** Caller identity used for JWT signing. */
  caller: Caller;
  /** Secret key used to sign the JWT. */
  signingKey: string;
  /** Zod schema that validates events before forwarding to the remote DO. */
  eventSchema: TEventSchema;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toScreamingSnake(s: string): string {
  return s.replace(/-/g, "_").toUpperCase();
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Creates an XState callback actor that bridges a parent actor-kit DO
 * to a remote child actor-kit DO via WebSocket.
 *
 * @param actorType — kebab-case actor type name (e.g. `"zone"`)
 */
export function fromActorKit<
  TMachine extends AnyActorKitStateMachine,
  TActorType extends string = string,
>(actorType: TActorType) {
  type TEmitted = FromActorKitEmitted<TActorType, TMachine>;

  const TYPE = toScreamingSnake(actorType);

  const callback: CallbackLogicFunction<
    Record<string, unknown> & { type: string }, // events parent can send
    TEmitted, // events sent back to parent
    FromActorKitInput // input
  > = ({ sendBack, receive, input }) => {
    let ws: WebSocket | null = null;
    const pendingEvents: string[] = [];

    // Async setup — spawn, auth, connect
    (async () => {
      try {
        const id = input.server.idFromName(input.actorId);
        const stub = input.server.get(id);

        // 1. Spawn remote actor (idempotent) via RPC
        if (stub.spawn) {
          await Promise.resolve(
            stub.spawn({
              actorType,
              actorId: input.actorId,
              caller: input.caller,
              input: input.actorInput,
            })
          );
        }

        // 2. Create JWT
        const accessToken = await createAccessToken({
          signingKey: input.signingKey,
          actorId: input.actorId,
          actorType,
          callerId: input.caller.id,
          callerType: input.caller.type,
        });

        // 3. Open WebSocket via fetch upgrade
        const response = await stub.fetch(
          new Request(
            `https://internal/api/${actorType}/${input.actorId}/?accessToken=${accessToken}`,
            { headers: { Upgrade: "websocket" } }
          )
        );

        const webSocket = (response as unknown as { webSocket?: WebSocket })
          .webSocket;
        if (!webSocket) {
          throw new Error(
            `WebSocket upgrade failed for ${actorType}/${input.actorId}`
          );
        }

        webSocket.accept();
        ws = webSocket;

        // 4. Track snapshot via patches
        let currentSnapshot = {} as CallerSnapshotFrom<TMachine>;

        ws.addEventListener("message", (event: MessageEvent) => {
          try {
            const raw =
              typeof event.data === "string"
                ? event.data
                : new TextDecoder().decode(
                    event.data as ArrayBuffer | Uint8Array
                  );
            const data = JSON.parse(raw) as ActorKitEmittedEvent;

            currentSnapshot = produce(currentSnapshot, (draft) => {
              applyPatch(draft, data.operations);
            });

            sendBack({
              type: `${TYPE}_UPDATED`,
              actorType,
              actorId: input.actorId,
              snapshot: currentSnapshot,
              operations: data.operations,
            } as TEmitted);
          } catch (err) {
            console.error(
              `[fromActorKit:${actorType}] message error:`,
              err
            );
          }
        });

        ws.addEventListener("error", () => {
          sendBack({
            type: `${TYPE}_ERROR`,
            actorType,
            actorId: input.actorId,
            error: new Error(`WebSocket error for ${actorType}/${input.actorId}`),
          } as TEmitted);
        });

        // Handle normal close (e.g., child DO eviction/restart)
        ws.addEventListener("close", (event: CloseEvent) => {
          ws = null;
          sendBack({
            type: `${TYPE}_ERROR`,
            actorType,
            actorId: input.actorId,
            error: new Error(
              `WebSocket closed for ${actorType}/${input.actorId}: code=${event.code} reason=${event.reason}`
            ),
          } as TEmitted);
        });

        // 5. Flush queued events
        while (pendingEvents.length > 0) {
          ws.send(pendingEvents.shift()!);
        }
      } catch (err) {
        console.error(`[fromActorKit:${actorType}] setup error:`, err);
        sendBack({
          type: `${TYPE}_ERROR`,
          actorType,
          actorId: input.actorId,
          error:
            err instanceof Error
              ? err
              : new Error(`Setup failed for ${actorType}/${input.actorId}`),
        } as TEmitted);
      }
    })();

    // 6. Forward validated events from parent → remote DO
    receive((event) => {
      const result = input.eventSchema.safeParse(event);
      if (!result.success) return; // not meant for this actor

      const serialized = JSON.stringify(result.data);
      if (ws) {
        ws.send(serialized);
      } else {
        pendingEvents.push(serialized);
      }
    });

    // 7. Cleanup
    return () => {
      if (ws) {
        try {
          ws.close(1000, "Actor stopped");
        } catch {
          // ignore
        }
        ws = null;
      }
    };
  };

  return fromCallback(callback);
}
