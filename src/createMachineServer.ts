// Import necessary dependencies and types
import { DurableObject } from "cloudflare:workers";
import { compare } from "fast-json-patch";
import {
  Actor,
  AnyEventObject,
  createActor,
  InputFrom,
  matchesState,
  SnapshotFrom,
  StateValueFrom,
  Subscription,
} from "xstate";
import { xstateMigrate } from "xstate-migrate";
import { z } from "zod";
import { PERSISTED_SNAPSHOT_KEY } from "./constants";
import { CallerSchema } from "./schemas";
import {
  ActorKitInputProps,
  ActorKitStateMachine,
  ActorKitSystemEvent,
  ActorServer,
  Caller,
  CallerSnapshotFrom,
  ClientEventFrom,
  EnvFromMachine,
  MachineServerOptions,
  ServiceEventFrom,
  WithActorKitContext,
  WithActorKitEvent,
} from "./types";
import { assert, getCallerFromRequest } from "./utils";

// Define schemas for storage and WebSocket attachments
const StorageSchema = z.object({
  actorType: z.string(),
  actorId: z.string(),
  initialCaller: CallerSchema,
  input: z.record(z.unknown()),
});

const WebSocketAttachmentSchema = z.object({
  caller: CallerSchema,
  lastSentChecksum: z.string().optional(),
});
type WebSocketAttachment = z.infer<typeof WebSocketAttachmentSchema>;

/**
 * Creates a MachineServer class that extends DurableObject and implements ActorServer.
 * This function is the main entry point for creating a machine server.
 */
export const createMachineServer = <
  TClientEvent extends AnyEventObject,
  TServiceEvent extends AnyEventObject,
  TInputSchema extends z.ZodObject<z.ZodRawShape>,
  TMachine extends ActorKitStateMachine<
    (
      | WithActorKitEvent<TClientEvent, "client">
      | WithActorKitEvent<TServiceEvent, "service">
      | ActorKitSystemEvent
    ) & {
      storage: DurableObjectStorage;
      env: EnvFromMachine<TMachine>;
    },
    z.infer<TInputSchema> & {
      id: string;
      caller: Caller;
      storage: DurableObjectStorage;
    },
    WithActorKitContext<any, any, any>
  >
>({
  machine,
  schemas,
  options,
}: {
  machine: TMachine;
  schemas: {
    clientEvent: z.ZodSchema<TClientEvent>;
    serviceEvent: z.ZodSchema<TServiceEvent>;
    inputProps: TInputSchema;
  };
  options?: MachineServerOptions;
}): new (
  state: DurableObjectState,
  env: EnvFromMachine<TMachine>
) => ActorServer<TMachine> =>
  class MachineServerImpl
    extends DurableObject
    implements ActorServer<TMachine>
  {
    // Class properties
    actor: Actor<TMachine> | undefined;
    actorType: string | undefined;
    actorId: string | undefined;
    input: Record<string, unknown> | undefined;
    initialCaller: Caller | undefined;
    lastPersistedSnapshot: SnapshotFrom<TMachine> | null = null;
    lastSnapshotChecksum: string | null = null;
    snapshotCache: Map<
      string,
      { snapshot: SnapshotFrom<TMachine>; timestamp: number }
    > = new Map();
    state: DurableObjectState;
    storage: DurableObjectStorage;
    attachments: Map<WebSocket, WebSocketAttachment>;
    subscriptions: Map<WebSocket, Subscription>;
    env: EnvFromMachine<TMachine>;
    currentChecksum: string | null = null;

    /**
     * Constructor for the MachineServerImpl class.
     * Initializes the server and sets up WebSocket connections.
     */
    constructor(
      state: DurableObjectState,
      env: EnvFromMachine<TMachine>
    ) {
      super(state, env);
      this.state = state;
      this.storage = state.storage;
      this.env = env;
      this.attachments = new Map();
      this.subscriptions = new Map();

      // Initialize actor data from storage
      this.state.blockConcurrencyWhile(async () => {
        const [actorType, actorId, initialCallerString, inputString] =
          await Promise.all([
            this.storage.get("actorType"),
            this.storage.get("actorId"),
            this.storage.get("initialCaller"),
            this.storage.get("input"),
          ]);

        if (actorType && actorId && initialCallerString && inputString) {
          try {
            const parsedData = StorageSchema.parse({
              actorType,
              actorId,
              initialCaller: JSON.parse(
                initialCallerString as string
              ) as Caller,
              input: JSON.parse(inputString as string),
            });

            this.actorType = parsedData.actorType;
            this.actorId = parsedData.actorId;
            this.initialCaller = parsedData.initialCaller;
            this.input = parsedData.input;

            if (options?.persisted) {
              const persistedSnapshot = await this.loadPersistedSnapshot();
              if (persistedSnapshot) {
                this.restorePersistedActor(persistedSnapshot);
              } else {
                this.#ensureActorRunning();
              }
            } else {
              this.#ensureActorRunning();
            }
          } catch (error) {
            // Error handling without logging
          }
        }

        // Resume all existing WebSockets
        const existingWebSockets = this.state.getWebSockets();
        existingWebSockets.forEach((ws) => {
          this.#subscribeSocketToActor(ws);
        });
      });

      this.#startPeriodicCacheCleanup();
    }

    /**
     * Ensures that the actor is running. If not, it creates and initializes the actor.
     * @private
     */
    #ensureActorRunning() {
      assert(this.actorId, "actorId is not set");
      assert(this.actorType, "actorType is not set");
      assert(this.input, "input is not set");
      assert(this.initialCaller, "initialCaller is not set");

      if (!this.actor) {
        const input = {
          id: this.actorId,
          caller: this.initialCaller,
          env: this.env,
          storage: this.storage,
          ...this.input,
        } satisfies ActorKitInputProps;
        
        this.actor = createActor(machine, { input } as any);

        if (options?.persisted) {
          this.#setupStatePersistence(this.actor);
        }

        this.actor.start();
      }
      return this.actor;
    }

    #subscribeSocketToActor(ws: WebSocket) {
      try {
        const attachment = WebSocketAttachmentSchema.parse(
          ws.deserializeAttachment()
        );
        this.attachments.set(ws, attachment);

        // Send initial state update
        this.#sendStateUpdate(ws);

        // Set up subscription for this WebSocket
        const sub = this.actor!.subscribe(() => {
          this.#sendStateUpdate(ws);
        });
        this.subscriptions.set(ws, sub);
      } catch (error) {
        // Error handling without logging
      }
    }

    #sendStateUpdate(ws: WebSocket) {
      assert(this.actor, "actor is not running");
      const attachment = this.attachments.get(ws);
      assert(attachment, "Attachment missing for WebSocket");

      const fullSnapshot = this.actor.getSnapshot();
      const currentChecksum = this.#calculateChecksum(fullSnapshot);

      // Store snapshot in cache with timestamp
      this.snapshotCache.set(currentChecksum, {
        snapshot: fullSnapshot,
        timestamp: Date.now(),
      });

      // Schedule cleanup for this snapshot
      this.#scheduleSnapshotCacheCleanup(currentChecksum);

      // Update current checksum
      this.currentChecksum = currentChecksum;

      // Only send updates if the checksum has changed
      if (attachment.lastSentChecksum !== currentChecksum) {
        const nextSnapshot = this.#createCallerSnapshot(
          fullSnapshot,
          attachment.caller.id
        );
        let lastSnapshot = {};
        if (attachment.lastSentChecksum) {
          const cachedData = this.snapshotCache.get(
            attachment.lastSentChecksum
          );
          if (cachedData) {
            lastSnapshot = this.#createCallerSnapshot(
              cachedData.snapshot,
              attachment.caller.id
            );
          }
        }

        const operations = compare(lastSnapshot, nextSnapshot);

        if (operations.length) {
          ws.send(JSON.stringify({ operations, checksum: currentChecksum }));
          attachment.lastSentChecksum = currentChecksum;
          ws.serializeAttachment(attachment);
        }
      }
    }

    /**
     * Sets up state persistence for the actor if the persisted option is enabled.
     * @private
     */
    #setupStatePersistence(actor: Actor<TMachine>) {
      actor.subscribe(() => {
        const fullSnapshot = actor.getSnapshot();
        if (fullSnapshot) {
          this.#persistSnapshot(fullSnapshot);
        }
      });
    }

    /**
     * Persists the given snapshot if it's different from the last persisted snapshot.
     * @private
     */
    async #persistSnapshot(snapshot: SnapshotFrom<TMachine>) {
      try {
        if (
          !this.lastPersistedSnapshot ||
          compare(this.lastPersistedSnapshot, snapshot).length > 0
        ) {
          await this.storage.put(
            PERSISTED_SNAPSHOT_KEY,
            JSON.stringify(snapshot)
          );
          this.lastPersistedSnapshot = snapshot;
        }
      } catch (error) {
        // Error handling without logging
      }
    }

    /**
     * Validates and sets up the actor with input from the request
     * @private
     */
    async #setupActorFromRequest(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      const inputString = url.searchParams.get("input");
      const pathParts = url.pathname.split("/").filter(Boolean);
      const [, actorType, actorId] = pathParts;
      
      if (!actorType || !actorId) {
        return new Response("Invalid actor path", { status: 400 });
      }

      // Check if input is required by looking at the schema
      const inputSchema = schemas.inputProps;
      const hasRequiredFields = Object.values(inputSchema.shape).some(
        (field) => !field.isOptional()
      );

      // If input is required but not provided, return error
      if (hasRequiredFields && !inputString) {
        return new Response("Input parameters required for initial actor setup", { status: 400 });
      }

      try {
        const input = inputString ? JSON.parse(inputString) : {};

        // Validate input against schema if provided
        if (inputString) {
          try {
            inputSchema.parse(input);
          } catch (error: any) {
            return new Response(`Invalid input: ${error.message}`, { status: 400 });
          }
        }

        // Get caller from request
        const caller = await this.#getValidatedCaller(request, actorType, actorId);
        if (!caller) {
          return new Response("Unauthorized", { status: 401 });
        }

        // Store actor data
        await this.#storeActorData(actorType, actorId, caller, input);

        // Update instance properties
        this.actorType = actorType;
        this.actorId = actorId;
        this.initialCaller = caller;
        this.input = input;

        return null;
      } catch (error: any) {
        return new Response(`Error parsing input: ${error.message}`, { status: 400 });
      }
    }

    /**
     * Validates and returns the caller from the request
     * @private
     */
    async #getValidatedCaller(
      request: Request,
      actorType: string,
      actorId: string
    ): Promise<Caller | null> {
      try {
        const caller = await getCallerFromRequest(
          request,
          actorType,
          actorId,
          this.env.ACTOR_KIT_SECRET
        );
        return caller;
      } catch (error: any) {
        return null;
      }
    }

    /**
     * Stores actor data in storage
     * @private
     */
    async #storeActorData(
      actorType: string,
      actorId: string,
      caller: Caller,
      input: Record<string, unknown>
    ): Promise<void> {
      await Promise.all([
        this.storage.put("actorType", actorType),
        this.storage.put("actorId", actorId),
        this.storage.put("initialCaller", JSON.stringify(caller)),
        this.storage.put("input", JSON.stringify(input)),
      ]);
    }

    /**
     * Checks if the actor is already running
     * @private
     */
    #isActorRunning(): boolean {
      return !!this.actorType;
    }

    /**
     * Handles incoming HTTP requests and sets up WebSocket connections.
     */
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const clientChecksum = url.searchParams.get("checksum");

      // If actor is not running yet, set it up
      if (!this.#isActorRunning()) {
        const setupError = await this.#setupActorFromRequest(request);
        if (setupError) {
          return setupError;
        }
      }

      this.#ensureActorRunning();
      assert(this.actorType, "actorType is not set");
      assert(this.actorId, "actorId is not set");

      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);

      // Get caller for this connection
      const caller = await this.#getValidatedCaller(
        request,
        this.actorType,
        this.actorId
      );
      if (!caller) {
        return new Response("Unauthorized", { status: 401 });
      }

      this.state.acceptWebSocket(server);
      const initialAttachment = {
        caller,
        lastSentChecksum: clientChecksum ?? undefined,
      };
      server.serializeAttachment(initialAttachment);

      // Subscribe the new WebSocket to the actor
      this.#subscribeSocketToActor(server);

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    /**
     * Handles incoming WebSocket messages.
     */
    async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
      const attachment = this.attachments.get(ws);
      assert(attachment, "Attachment missing for WebSocket");

      let event: ClientEventFrom<TMachine> | ServiceEventFrom<TMachine>;

      const { caller } = attachment;
      if (caller.type === "client") {
        const clientEvent = schemas.clientEvent.parse(
          JSON.parse(message as string)
        );
        event = {
          ...clientEvent,
          caller,
        } as ClientEventFrom<TMachine>;
      } else if (caller.type === "service") {
        const serviceEvent = schemas.serviceEvent.parse(
          JSON.parse(message as string)
        );
        event = {
          ...serviceEvent,
          caller,
        } as ServiceEventFrom<TMachine>;
      } else {
        throw new Error(`Unknown caller type: ${caller.type}`);
      }

      this.send(event);
    }

    /**
     * Handles WebSocket errors.
     */
    async webSocketError(_ws: WebSocket, _error: Error) {
      // Error handling without logging
    }

    /**
     * Handles WebSocket closure.
     */
    async webSocketClose(
      ws: WebSocket,
      code: number,
      _reason: string,
      _wasClean: boolean
    ) {
      ws.close(code, "Durable Object is closing WebSocket");
      // Remove the subscription for the socket
      const subscription = this.subscriptions.get(ws);
      if (subscription) {
        subscription.unsubscribe();
        this.subscriptions.delete(ws);
      }
      // Remove the attachment for the socket
      this.attachments.delete(ws);
    }

    /**
     * Sends an event to the actor.
     */
    send(event: ClientEventFrom<TMachine> | ServiceEventFrom<TMachine>): void {
      assert(this.actor, "Actor is not running");
      this.actor.send({
        ...event,
        env: this.env,
        storage: this.storage,
      });
    }

    /**
     * Retrieves a snapshot of the actor's state for a specific caller.
     * @param caller The caller requesting the snapshot.
     * @returns An object containing the caller-specific snapshot and a checksum for the full snapshot.
     */
    async getSnapshot(
      caller: Caller,
      options?: {
        waitForEvent?: ClientEventFrom<TMachine>;
        waitForState?: StateValueFrom<TMachine>;
        timeout?: number;
        errorOnWaitTimeout?: boolean;
      }
    ): Promise<{
      checksum: string;
      snapshot: CallerSnapshotFrom<TMachine>;
    }> {
      this.#ensureActorRunning();

      if (options?.waitForEvent || options?.waitForState) {
        const timeoutPromise = new Promise((resolve, reject) => {
          setTimeout(() => {
            if (options.errorOnWaitTimeout !== false) {
              reject(new Error("Timeout waiting for event or state"));
            } else {
              resolve(this.#getCurrentSnapshot(caller));
            }
          }, options.timeout || 5000);
        });

        const waitPromise: Promise<{
          checksum: string;
          snapshot: CallerSnapshotFrom<TMachine>;
        }> = new Promise((resolve) => {
          const sub = this.actor!.subscribe((state) => {
            if (
              (options.waitForEvent &&
                this.#matchesEvent(state, options.waitForEvent)) ||
              (options.waitForState &&
                this.#matchesState(state, options.waitForState))
            ) {
              sub && sub.unsubscribe();
              resolve(this.#getCurrentSnapshot(caller));
            }
          });
        });

        return Promise.race([waitPromise, timeoutPromise]) as Promise<{
          checksum: string;
          snapshot: CallerSnapshotFrom<TMachine>;
        }>;
      }

      // const checksum =
      return this.#getCurrentSnapshot(caller);
    }

    #getCurrentSnapshot(caller: Caller) {
      const fullSnapshot = this.actor!.getSnapshot();
      const callerSnapshot = this.#createCallerSnapshot(
        fullSnapshot,
        caller.id
      );
      const checksum = this.#calculateChecksum(fullSnapshot);
      return { snapshot: callerSnapshot, checksum };
    }

    #matchesEvent(
      _snapshot: SnapshotFrom<TMachine>,
      _event: ClientEventFrom<TMachine>
    ): boolean {
      // todo implement later
      return true;
    }

    #matchesState(
      snapshot: SnapshotFrom<TMachine>,
      stateValue: StateValueFrom<TMachine>
    ): boolean {
      return matchesState(stateValue, snapshot);
    }

    /**
     * Calculates a checksum for the given snapshot.
     * @private
     */
    #calculateChecksum(snapshot: SnapshotFrom<TMachine>): string {
      const snapshotString = JSON.stringify(snapshot);
      return this.#hashString(snapshotString);
    }

    /**
     * Generates a simple hash for a given string.
     * @private
     */
    #hashString(str: string): string {
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash = hash & hash; // Convert to 32-bit integer
      }
      return hash.toString(16); // Convert to hexadecimal
    }

    /**
     * Creates a caller-specific snapshot from the full snapshot.
     * @private
     */
    #createCallerSnapshot(
      fullSnapshot: SnapshotFrom<TMachine>,
      callerId: string
    ): CallerSnapshotFrom<TMachine> {
      const snap = fullSnapshot as any;
      assert(snap.value, "expected value");
      assert(snap.context.public, "expected public key in context");
      assert(snap.context.private, "expected private key in context");
      return {
        public: snap.context.public,
        private: snap.context.private[callerId] || {},
        value: snap.value,
      };
    }

    /**
     * Spawns a new actor with the given properties.
     */
    async spawn(props: {
      actorType: string;
      actorId: string;
      caller: Caller;
      input: Record<string, unknown>;
    }) {
      if (!this.actorType && !this.actorId && !this.initialCaller) {
        // Store actor data
        await this.#storeActorData(
          props.actorType,
          props.actorId,
          props.caller,
          props.input
        );

        // Update instance properties
        this.actorType = props.actorType;
        this.actorId = props.actorId;
        this.initialCaller = props.caller;
        this.input = props.input;

        this.#ensureActorRunning();
      }
    }

    // New method for scheduling snapshot cache cleanup
    #scheduleSnapshotCacheCleanup(checksum: string) {
      const CLEANUP_DELAY = 300000; // 5 minutes, adjust as needed
      setTimeout(() => {
        this.#cleanupSnapshotCache(checksum);
      }, CLEANUP_DELAY);
    }

    // New method for periodic cache cleanup
    #startPeriodicCacheCleanup() {
      const CLEANUP_INTERVAL = 300000; // 5 minutes, adjust as needed
      setInterval(() => {
        const now = Date.now();
        for (const [checksum, { timestamp }] of this.snapshotCache.entries()) {
          if (now - timestamp > CLEANUP_INTERVAL) {
            this.snapshotCache.delete(checksum);
          }
        }
      }, CLEANUP_INTERVAL);
    }

    // New method for cleaning up snapshot cache
    #cleanupSnapshotCache(checksum: string) {
      if (checksum !== this.currentChecksum) {
        const cachedData = this.snapshotCache.get(checksum);
        if (cachedData) {
          const now = Date.now();
          if (now - cachedData.timestamp > 300000) {
            // 5 minutes, same as CLEANUP_DELAY
            this.snapshotCache.delete(checksum);
          }
        }
      }
    }

    // Add this method to load the persisted snapshot
    async loadPersistedSnapshot(): Promise<SnapshotFrom<TMachine> | null> {
      const snapshotString = await this.storage.get(PERSISTED_SNAPSHOT_KEY);
      if (snapshotString) {
        return JSON.parse(snapshotString as string);
      }
      return null;
    }

    // Add this method to restore the persisted actor
    restorePersistedActor(persistedSnapshot: SnapshotFrom<TMachine>) {
      assert(this.actorId, "actorId is not set");
      assert(this.actorType, "actorType is not set");
      assert(this.initialCaller, "initialCaller is not set");
      assert(this.input, "input is not set");

      const input = {
        id: this.actorId,
        caller: this.initialCaller,
        storage: this.storage,
        env: this.env,
        ...this.input,
      } as InputFrom<TMachine>;

      const migrations = xstateMigrate.generateMigrations(
        machine,
        persistedSnapshot,
        input
      );
      const restoredSnapshot = xstateMigrate.applyMigrations(
        persistedSnapshot,
        migrations
      );

      this.actor = createActor(machine, {
        snapshot: restoredSnapshot,
        input,
      });

      if (options?.persisted) {
        this.#setupStatePersistence(this.actor);
      }

      this.actor.start();

      this.actor.send({
        type: "RESUME",
        caller: { id: this.actorId, type: "system" },
        env: this.env,
        storage: this.storage,
      } as any);

      this.lastPersistedSnapshot = restoredSnapshot as any;
    }
  };
