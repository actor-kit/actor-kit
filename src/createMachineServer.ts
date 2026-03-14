import { DurableObject } from "cloudflare:workers";
import { compare } from "fast-json-patch";
import {
  Actor,
  AnyEventObject,
  createActor,
  EventFromLogic,
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
import type {
  ActorKitInputProps,
  ActorKitStateMachine,
  ActorKitStorage,
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

type ActorKitWebSocket = WebSocket & {
  serializeAttachment(value: WebSocketAttachment): void;
  deserializeAttachment(): unknown;
};

type WebSocketResponseInit = ResponseInit & {
  webSocket: WebSocket;
};

type ActorKitSnapshotView<TMachine extends ActorKitStateMachine<any, any, any>> = {
  value: CallerSnapshotFrom<TMachine>["value"];
  context: {
    public: CallerSnapshotFrom<TMachine>["public"];
    private: Record<string, CallerSnapshotFrom<TMachine>["private"]>;
  };
};

const InputSearchSchema = z.object({
  input: z.string().optional(),
});

const ParsedMessageSchema = z.string().transform((value, context) => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Expected valid JSON payload",
    });
    return z.NEVER;
  }
});

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function parseStoredJson<T>(value: unknown, fallbackSchema: z.ZodType<T>): T {
  const parsedString = z.string().parse(value);
  return fallbackSchema.parse(JSON.parse(parsedString));
}

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
      storage: ActorKitStorage;
      env: EnvFromMachine<TMachine>;
    },
    z.infer<TInputSchema> & {
      id: string;
      caller: Caller;
      storage: ActorKitStorage;
    },
    WithActorKitContext<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
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
  class MachineServerImpl extends DurableObject implements ActorServer<TMachine> {
    actor: Actor<TMachine> | undefined;
    actorType: string | undefined;
    actorId: string | undefined;
    input: Record<string, unknown> | undefined;
    initialCaller: Caller | undefined;
    lastPersistedSnapshot: SnapshotFrom<TMachine> | null = null;
    snapshotCache = new Map<
      string,
      { snapshot: SnapshotFrom<TMachine>; timestamp: number }
    >();
    state: DurableObjectState;
    storage: DurableObjectStorage;
    attachments = new Map<WebSocket, WebSocketAttachment>();
    subscriptions = new Map<WebSocket, Subscription>();
    env: EnvFromMachine<TMachine>;
    currentChecksum: string | null = null;

    constructor(state: DurableObjectState, env: EnvFromMachine<TMachine>) {
      super(state, env);
      this.state = state;
      this.storage = state.storage;
      this.env = env;

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
              initialCaller: parseStoredJson(initialCallerString, CallerSchema),
              input: parseStoredJson(inputString, z.record(z.unknown())),
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
          } catch {
            // Ignore corrupt startup state and wait for a fresh spawn.
          }
        }

        for (const socket of this.state.getWebSockets()) {
          this.#subscribeSocketToActor(socket);
        }
      });

      this.#startPeriodicCacheCleanup();
    }

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

        this.actor = createActor(machine, {
          input: input as InputFrom<TMachine>,
        });

        if (options?.persisted) {
          this.#setupStatePersistence(this.actor);
        }

        this.actor.start();
      }

      return this.actor;
    }

    #subscribeSocketToActor(ws: WebSocket) {
      try {
        const socket = ws as ActorKitWebSocket;
        const attachment = WebSocketAttachmentSchema.parse(
          socket.deserializeAttachment()
        );
        this.attachments.set(socket, attachment);
        this.#sendStateUpdate(socket);

        const subscription = this.actor?.subscribe(() => {
          this.#sendStateUpdate(socket);
        });

        if (subscription) {
          this.subscriptions.set(socket, subscription);
        }
      } catch {
        // Ignore malformed socket state.
      }
    }

    #sendStateUpdate(ws: ActorKitWebSocket) {
      assert(this.actor, "actor is not running");
      const attachment = this.attachments.get(ws);
      assert(attachment, "Attachment missing for WebSocket");

      const fullSnapshot = this.actor.getSnapshot();
      const currentChecksum = this.#calculateChecksum(fullSnapshot);

      this.snapshotCache.set(currentChecksum, {
        snapshot: fullSnapshot,
        timestamp: Date.now(),
      });
      this.#scheduleSnapshotCacheCleanup(currentChecksum);
      this.currentChecksum = currentChecksum;

      if (attachment.lastSentChecksum === currentChecksum) {
        return;
      }

      const nextSnapshot = this.#createCallerSnapshot(
        fullSnapshot,
        attachment.caller.id
      );

      let lastSnapshot: Partial<typeof nextSnapshot> = {};
      if (attachment.lastSentChecksum) {
        const cachedSnapshot = this.snapshotCache.get(attachment.lastSentChecksum);
        if (cachedSnapshot) {
          lastSnapshot = this.#createCallerSnapshot(
            cachedSnapshot.snapshot,
            attachment.caller.id
          );
        }
      }

      const operations = compare(lastSnapshot, nextSnapshot);
      if (operations.length === 0) {
        return;
      }

      ws.send(JSON.stringify({ operations, checksum: currentChecksum }));
      attachment.lastSentChecksum = currentChecksum;
      ws.serializeAttachment(attachment);
    }

    #setupStatePersistence(actor: Actor<TMachine>) {
      actor.subscribe(() => {
        const fullSnapshot = actor.getSnapshot();
        this.#persistSnapshot(fullSnapshot).catch(() => {
          // Ignore persistence errors.
        });
      });
    }

    async #persistSnapshot(snapshot: SnapshotFrom<TMachine>) {
      if (
        this.lastPersistedSnapshot &&
        compare(this.lastPersistedSnapshot, snapshot).length === 0
      ) {
        return;
      }

      await this.storage.put(PERSISTED_SNAPSHOT_KEY, JSON.stringify(snapshot));
      this.lastPersistedSnapshot = snapshot;
    }

    async #setupActorFromRequest(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      const searchParams = InputSearchSchema.parse(
        Object.fromEntries(url.searchParams)
      );
      const pathParts = url.pathname.split("/").filter(Boolean);
      const [, actorType, actorId] = pathParts;

      if (!actorType || !actorId) {
        return new Response("Invalid actor path", { status: 400 });
      }

      const hasRequiredFields = Object.values(schemas.inputProps.shape).some(
        (field) => !field.isOptional()
      );

      if (hasRequiredFields && !searchParams.input) {
        return new Response("Input parameters required for initial actor setup", {
          status: 400,
        });
      }

      let input: Record<string, unknown> = {};
      if (searchParams.input) {
        try {
          input = schemas.inputProps.parse(JSON.parse(searchParams.input));
        } catch (error: unknown) {
          return new Response(`Invalid input: ${getErrorMessage(error)}`, {
            status: 400,
          });
        }
      }

      const caller = await this.#getValidatedCaller(request, actorType, actorId);
      if (!caller) {
        return new Response("Unauthorized", { status: 401 });
      }

      await this.#storeActorData(actorType, actorId, caller, input);
      this.actorType = actorType;
      this.actorId = actorId;
      this.initialCaller = caller;
      this.input = input;

      return null;
    }

    async #getValidatedCaller(
      request: Request,
      actorType: string,
      actorId: string
    ): Promise<Caller | null> {
      try {
        return await getCallerFromRequest(
          request,
          actorType,
          actorId,
          this.env.ACTOR_KIT_SECRET
        );
      } catch {
        return null;
      }
    }

    async #storeActorData(
      actorType: string,
      actorId: string,
      caller: Caller,
      input: Record<string, unknown>
    ) {
      await Promise.all([
        this.storage.put("actorType", actorType),
        this.storage.put("actorId", actorId),
        this.storage.put("initialCaller", JSON.stringify(caller)),
        this.storage.put("input", JSON.stringify(input)),
      ]);
    }

    #isActorRunning() {
      return Boolean(this.actorType);
    }

    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const clientChecksum = url.searchParams.get("checksum");

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
      const client = webSocketPair[0];
      const server = webSocketPair[1] as ActorKitWebSocket;

      const caller = await this.#getValidatedCaller(
        request,
        this.actorType,
        this.actorId
      );
      if (!caller) {
        return new Response("Unauthorized", { status: 401 });
      }

      this.state.acceptWebSocket(server);
      server.serializeAttachment({
        caller,
        lastSentChecksum: clientChecksum ?? undefined,
      });
      this.#subscribeSocketToActor(server);

      return new Response(null, {
        status: 101,
        webSocket: client,
      } as WebSocketResponseInit);
    }

    async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
      const attachment = this.attachments.get(ws);
      assert(attachment, "Attachment missing for WebSocket");

      const messageString =
        typeof message === "string"
          ? message
          : new TextDecoder().decode(message);
      const parsedMessage = ParsedMessageSchema.parse(messageString);

      if (attachment.caller.type === "client") {
        const clientEvent = schemas.clientEvent.parse(parsedMessage);
        this.send({
          ...clientEvent,
          caller: attachment.caller,
        } as ClientEventFrom<TMachine>);
        return;
      }

      if (attachment.caller.type === "service") {
        const serviceEvent = schemas.serviceEvent.parse(parsedMessage);
        this.send({
          ...serviceEvent,
          caller: attachment.caller,
        } as ServiceEventFrom<TMachine>);
        return;
      }

      throw new Error(`Unknown caller type: ${attachment.caller.type}`);
    }

    async webSocketError(_ws: WebSocket, _error: Error) {
      // No-op; the runtime closes the socket for us.
    }

    async webSocketClose(
      ws: WebSocket,
      code: number,
      _reason: string,
      _wasClean: boolean
    ) {
      ws.close(code, "Durable Object is closing WebSocket");
      const subscription = this.subscriptions.get(ws);
      if (subscription) {
        subscription.unsubscribe();
        this.subscriptions.delete(ws);
      }
      this.attachments.delete(ws);
    }

    send(event: ClientEventFrom<TMachine> | ServiceEventFrom<TMachine>) {
      assert(this.actor, "Actor is not running");
      this.actor.send({
        ...event,
        env: this.env,
        storage: this.storage,
      });
    }

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

      if (!options?.waitForEvent && !options?.waitForState) {
        return this.#getCurrentSnapshot(caller);
      }

      const timeoutPromise = new Promise<{
        checksum: string;
        snapshot: CallerSnapshotFrom<TMachine>;
      }>((resolve, reject) => {
        setTimeout(() => {
          if (options.errorOnWaitTimeout !== false) {
            reject(new Error("Timeout waiting for event or state"));
          } else {
            resolve(this.#getCurrentSnapshot(caller));
          }
        }, options.timeout ?? 5000);
      });

      const waitPromise = new Promise<{
        checksum: string;
        snapshot: CallerSnapshotFrom<TMachine>;
      }>((resolve) => {
        const subscription = this.actor?.subscribe((snapshot) => {
          if (
            (options.waitForEvent &&
              this.#matchesEvent(snapshot, options.waitForEvent)) ||
            (options.waitForState &&
              this.#matchesState(snapshot, options.waitForState))
          ) {
            subscription?.unsubscribe();
            resolve(this.#getCurrentSnapshot(caller));
          }
        });
      });

      return Promise.race([waitPromise, timeoutPromise]);
    }

    #getCurrentSnapshot(caller: Caller) {
      const fullSnapshot = this.actor?.getSnapshot();
      assert(fullSnapshot, "Actor snapshot is not available");
      return {
        snapshot: this.#createCallerSnapshot(fullSnapshot, caller.id),
        checksum: this.#calculateChecksum(fullSnapshot),
      };
    }

    #matchesEvent(
      _snapshot: SnapshotFrom<TMachine>,
      _event: ClientEventFrom<TMachine>
    ) {
      return true;
    }

    #matchesState(
      snapshot: SnapshotFrom<TMachine>,
      stateValue: StateValueFrom<TMachine>
    ) {
      return matchesState(stateValue, snapshot);
    }

    #calculateChecksum(snapshot: SnapshotFrom<TMachine>) {
      return this.#hashString(JSON.stringify(snapshot));
    }

    #hashString(value: string) {
      let hash = 0;
      for (let index = 0; index < value.length; index += 1) {
        const character = value.charCodeAt(index);
        hash = (hash << 5) - hash + character;
        hash &= hash;
      }
      return hash.toString(16);
    }

    #createCallerSnapshot(
      fullSnapshot: SnapshotFrom<TMachine>,
      callerId: string
    ): CallerSnapshotFrom<TMachine> {
      const snapshot = fullSnapshot as unknown as ActorKitSnapshotView<TMachine>;
      assert(snapshot.value, "expected value");
      assert(snapshot.context.public, "expected public key in context");
      assert(snapshot.context.private, "expected private key in context");
      return {
        public: snapshot.context.public,
        private:
          snapshot.context.private[callerId] ??
          ({} as CallerSnapshotFrom<TMachine>["private"]),
        value: snapshot.value,
      };
    }

    async spawn(props: {
      actorType: string;
      actorId: string;
      caller: Caller;
      input: Record<string, unknown>;
    }) {
      if (this.actorType || this.actorId || this.initialCaller) {
        return;
      }

      await this.#storeActorData(
        props.actorType,
        props.actorId,
        props.caller,
        props.input
      );
      this.actorType = props.actorType;
      this.actorId = props.actorId;
      this.initialCaller = props.caller;
      this.input = props.input;
      this.#ensureActorRunning();
    }

    #scheduleSnapshotCacheCleanup(checksum: string) {
      setTimeout(() => {
        this.#cleanupSnapshotCache(checksum);
      }, 300000);
    }

    #startPeriodicCacheCleanup() {
      setInterval(() => {
        const now = Date.now();
        for (const [checksum, { timestamp }] of this.snapshotCache.entries()) {
          if (now - timestamp > 300000) {
            this.snapshotCache.delete(checksum);
          }
        }
      }, 300000);
    }

    #cleanupSnapshotCache(checksum: string) {
      if (checksum === this.currentChecksum) {
        return;
      }

      const cachedData = this.snapshotCache.get(checksum);
      if (cachedData && Date.now() - cachedData.timestamp > 300000) {
        this.snapshotCache.delete(checksum);
      }
    }

    async loadPersistedSnapshot(): Promise<SnapshotFrom<TMachine> | null> {
      const snapshotString = await this.storage.get(PERSISTED_SNAPSHOT_KEY);
      return snapshotString
        ? (JSON.parse(z.string().parse(snapshotString)) as SnapshotFrom<TMachine>)
        : null;
    }

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
      } as EventFromLogic<TMachine>);

      this.lastPersistedSnapshot = restoredSnapshot as SnapshotFrom<TMachine>;
    }
  };
