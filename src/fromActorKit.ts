import { applyPatch } from "fast-json-patch";
import type { Operation } from "fast-json-patch";
import { produce } from "immer";
import type { CallbackLogicFunction } from "xstate";
import { fromCallback } from "xstate";
import type { z } from "zod";
import { createAccessToken } from "./createAccessToken";
import type {
  ActorKitEmittedEvent,
  ActorServer,
  AnyActorKitStateMachine,
  Caller,
  CallerSnapshotFrom,
} from "./types";

// --- Type utilities ---

/** Convert kebab-case to SCREAMING_SNAKE_CASE: "my-actor" → "MY_ACTOR" */
type KebabToScreamingSnake<S extends string> = string extends S
  ? string
  : S extends `${infer T}-${infer U}`
    ? `${Uppercase<T>}_${KebabToScreamingSnake<U>}`
    : Uppercase<S>;

/** Events emitted back to the parent machine by the fromActorKit callback */
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

/** Input required to invoke a fromActorKit callback actor */
export type FromActorKitInput<
  TMachine extends AnyActorKitStateMachine,
  TEventSchema extends z.ZodTypeAny = z.ZodTypeAny,
> = {
  /** DurableObject namespace binding for the remote actor (e.g., env.ZONE) */
  server: DurableObjectNamespace<ActorServer<TMachine>>;
  /** ID of the remote actor instance */
  actorId: string;
  /** Input props to pass when spawning the remote actor */
  actorInput: Record<string, unknown>;
  /** Caller identity for JWT signing */
  caller: Caller;
  /** Secret key for JWT signing */
  signingKey: string;
  /** Zod schema to validate outbound events before forwarding */
  eventSchema: TEventSchema;
};

/** Convert kebab-case to SCREAMING_SNAKE_CASE at runtime */
function toScreamingSnake(str: string): string {
  return str.replace(/-/g, "_").toUpperCase();
}

/**
 * Creates an XState callback actor that connects to a remote actor-kit
 * Durable Object via WebSocket.
 *
 * The callback:
 * 1. Creates a JWT access token for the remote actor
 * 2. Opens a WebSocket to the remote DO via stub.fetch()
 * 3. Receives snapshot patches and emits {ACTOR_TYPE}_UPDATED events
 * 4. Forwards events from the parent to the remote DO (validated via eventSchema)
 * 5. Emits {ACTOR_TYPE}_ERROR on WebSocket errors
 *
 * @example
 * ```typescript
 * const sessionMachine = setup({
 *   actors: {
 *     zoneConnection: fromActorKit<ZoneMachine>("zone"),
 *   },
 * }).createMachine({
 *   invoke: {
 *     id: "zoneConnection",
 *     src: "zoneConnection",
 *     input: ({ context }) => ({
 *       server: context.env.ZONE,
 *       actorId: context.public.zoneId,
 *       actorInput: {},
 *       caller: { id: context.public.playerId, type: "service" },
 *       signingKey: context.env.ACTOR_KIT_SECRET,
 *       eventSchema: ZoneServiceEventSchema,
 *     }),
 *   },
 *   on: {
 *     ZONE_UPDATED: { actions: "updateZoneSnapshot" },
 *   },
 * });
 * ```
 */
export function fromActorKit<
  TMachine extends AnyActorKitStateMachine,
  TActorType extends string = string,
>(actorType: TActorType) {
  type TEmitted = FromActorKitEmitted<TActorType, TMachine>;
  type TInput = FromActorKitInput<TMachine>;

  const ACTOR_TYPE_SNAKE = toScreamingSnake(actorType);

  const callback: CallbackLogicFunction<
    // Events the parent can send TO this callback
    Record<string, unknown> & { type: string },
    // Events this callback sends BACK to the parent
    TEmitted,
    // Input
    TInput
  > = ({ sendBack, receive, input }) => {
    let websocket: WebSocket | null = null;
    const pendingEvents: string[] = [];

    const id = input.server.idFromName(input.actorId);
    const stub = input.server.get(id);

    createAccessToken({
      signingKey: input.signingKey,
      actorId: input.actorId,
      actorType,
      callerId: input.caller.id,
      callerType: input.caller.type,
    })
      .then(async (accessToken) => {
        // Spawn the remote actor if not already running (idempotent).
        // Cast needed: DurableObjectStub<T> doesn't expose RPC methods in
        // current CF types without Rpc.DurableObjectBranded. TODO: update
        // ActorServer to use proper RPC types.
        await Promise.resolve(
          (stub as unknown as ActorServer<TMachine>).spawn({
            actorType,
            actorId: input.actorId,
            caller: input.caller,
            input: input.actorInput,
          })
        );

        const response = await stub.fetch(
          new Request(
            `https://internal/api/${actorType}/${input.actorId}/?accessToken=${accessToken}`,
            {
              headers: {
                Upgrade: "websocket",
              },
            }
          )
        );

        websocket = (response as unknown as { webSocket: WebSocket }).webSocket;
        if (!websocket) {
          sendBack({
            type: `${ACTOR_TYPE_SNAKE}_ERROR`,
            actorType,
            actorId: input.actorId,
            error: new Error(
              `WebSocket connection failed for ${actorType}/${input.actorId}`
            ),
          } as TEmitted);
          return;
        }

        websocket.accept();

        // Track snapshot state for applying patches
        let currentSnapshot: CallerSnapshotFrom<TMachine> =
          {} as CallerSnapshotFrom<TMachine>;

        websocket.addEventListener("message", (event: MessageEvent) => {
          try {
            const data = JSON.parse(
              typeof event.data === "string"
                ? event.data
                : new TextDecoder().decode(
                    event.data as ArrayBuffer | Uint8Array
                  )
            ) as ActorKitEmittedEvent;

            currentSnapshot = produce(currentSnapshot, (draft) => {
              applyPatch(draft, data.operations);
            });

            sendBack({
              type: `${ACTOR_TYPE_SNAKE}_UPDATED`,
              actorType,
              actorId: input.actorId,
              snapshot: currentSnapshot,
              operations: data.operations,
            } as TEmitted);
          } catch (err) {
            console.error(
              `[fromActorKit:${actorType}] Error processing message:`,
              err
            );
          }
        });

        websocket.addEventListener("error", () => {
          sendBack({
            type: `${ACTOR_TYPE_SNAKE}_ERROR`,
            actorType,
            actorId: input.actorId,
            error: new Error(
              `WebSocket error for ${actorType}/${input.actorId}`
            ),
          } as TEmitted);
        });

        // Flush any events that were queued before WebSocket was ready
        while (pendingEvents.length > 0) {
          const queued = pendingEvents.shift()!;
          websocket.send(queued);
        }
      })
      .catch((error: unknown) => {
        console.error(`[fromActorKit:${actorType}] Setup error:`, error);
        sendBack({
          type: `${ACTOR_TYPE_SNAKE}_ERROR`,
          actorType,
          actorId: input.actorId,
          error:
            error instanceof Error
              ? error
              : new Error(`Setup failed for ${actorType}/${input.actorId}`),
        } as TEmitted);
      });

    // Forward events from parent to remote DO
    receive((event) => {
      const parseResult = input.eventSchema.safeParse(event);
      if (!parseResult.success) {
        return; // Event doesn't match schema — not meant for this actor
      }

      const serialized = JSON.stringify(parseResult.data);
      if (websocket) {
        websocket.send(serialized);
      } else {
        // Queue for delivery when WebSocket is ready
        pendingEvents.push(serialized);
      }
    });

    // Cleanup on actor stop
    return () => {
      if (websocket) {
        try {
          websocket.close(1000, "Actor stopped");
        } catch {
          // Ignore close errors
        }
        websocket = null;
      }
    };
  };

  return fromCallback(callback);
}
