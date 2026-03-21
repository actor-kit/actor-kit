import { DurableObject } from "cloudflare:workers";
import { compare } from "fast-json-patch";
import { z } from "zod";
import { assert, getCallerFromRequest } from "./auth";
import type {
  BaseEnv,
  Caller,
  DurableActorConfig,
  DurableActorMethods,
} from "./types";

const PERSISTED_SNAPSHOT_KEY = "persistedSnapshot";
const PERSISTED_VERSION_KEY = "persistedVersion";

const CallerSchema = z.object({
  id: z.string(),
  type: z.enum(["client", "service"]),
});

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

export function createDurableActor<
  TState,
  TEvent extends { type: string },
  TView,
  TEnv extends BaseEnv,
  TInput,
>(
  config: DurableActorConfig<TState, TEvent, TView, TEnv, TInput>
): new (
  state: DurableObjectState,
  env: TEnv
) => DurableActorMethods<TView> & DurableObject {
  const { logic, events, persisted } = config;

  return class DurableActorImpl
    extends DurableObject
    implements DurableActorMethods<TView>
  {
    #currentState: TState | undefined;
    #actorType: string | undefined;
    #actorId: string | undefined;
    #input: Record<string, unknown> | undefined;
    #initialCaller: Caller | undefined;
    #lastPersistedSerialized: unknown = null;
    #viewCache = new Map<
      string,
      { serialized: unknown; timestamp: number }
    >();
    #doState: DurableObjectState;
    #storage: DurableObjectStorage;
    #attachments = new Map<WebSocket, WebSocketAttachment>();
    #sendQueues = new Map<WebSocket, Promise<void>>();
    #env: TEnv;
    #currentChecksum: string | null = null;

    constructor(state: DurableObjectState, env: TEnv) {
      super(state, env);
      this.#doState = state;
      this.#storage = state.storage;
      this.#env = env;

      this.#doState.blockConcurrencyWhile(async () => {
        const [actorType, actorId, initialCallerString, inputString] =
          await Promise.all([
            this.#storage.get("actorType"),
            this.#storage.get("actorId"),
            this.#storage.get("initialCaller"),
            this.#storage.get("input"),
          ]);

        if (actorType && actorId && initialCallerString && inputString) {
          try {
            const parsedData = StorageSchema.parse({
              actorType,
              actorId,
              initialCaller: parseStoredJson(initialCallerString, CallerSchema),
              input: parseStoredJson(inputString, z.record(z.unknown())),
            });

            this.#actorType = parsedData.actorType;
            this.#actorId = parsedData.actorId;
            this.#initialCaller = parsedData.initialCaller;
            this.#input = parsedData.input;

            if (persisted) {
              const restored = await this.#loadPersistedSnapshot();
              if (restored) {
                this.#restorePersistedActor(restored);
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

        for (const socket of this.#doState.getWebSockets()) {
          this.#subscribeSocketToActor(socket);
        }
      });

      this.#startPeriodicCacheCleanup();
    }

    #ensureActorRunning() {
      assert(this.#actorId, "actorId is not set");
      assert(this.#actorType, "actorType is not set");
      assert(this.#input, "input is not set");
      assert(this.#initialCaller, "initialCaller is not set");

      if (!this.#currentState) {
        const inputProps = config.input.parse(this.#input);
        this.#currentState = logic.create(inputProps, {
          id: this.#actorId,
          caller: this.#initialCaller,
          env: this.#env,
        });

        if (persisted) {
          this.#persistSnapshot().catch(() => {
            // Ignore persistence errors.
          });
        }
      }

      return this.#currentState;
    }

    #applyTransition(event: TEvent & { caller: Caller; env: TEnv }) {
      assert(this.#currentState, "Actor state is not initialized");
      this.#currentState = logic.transition(this.#currentState, event);

      if (persisted) {
        this.#persistSnapshot().catch(() => {
          // Ignore persistence errors.
        });
      }

      // Notify all connected WebSockets
      for (const ws of this.#attachments.keys()) {
        this.#enqueueSendStateUpdate(ws as ActorKitWebSocket);
      }
    }

    #subscribeSocketToActor(ws: WebSocket) {
      try {
        const socket = ws as ActorKitWebSocket;
        const attachment = WebSocketAttachmentSchema.parse(
          socket.deserializeAttachment()
        );
        this.#attachments.set(socket, attachment);
        this.#enqueueSendStateUpdate(socket);
      } catch {
        // Ignore malformed socket state.
      }
    }

    #enqueueSendStateUpdate(ws: ActorKitWebSocket) {
      const prev = this.#sendQueues.get(ws);
      const sendTask = prev
        ? prev.then(() => this.#sendStateUpdate(ws))
        : this.#sendStateUpdate(ws);
      const next = sendTask.catch(() => {
        // Errors in send are non-fatal; the next update will retry.
      });
      this.#sendQueues.set(ws, next);
    }

    async #sendStateUpdate(ws: ActorKitWebSocket) {
      assert(this.#currentState, "Actor state is not initialized");
      const attachment = this.#attachments.get(ws);
      assert(attachment, "Attachment missing for WebSocket");

      const serialized = logic.serialize(this.#currentState);
      const currentChecksum = await this.#calculateChecksum(serialized);

      this.#viewCache.set(currentChecksum, {
        serialized,
        timestamp: Date.now(),
      });
      this.#scheduleViewCacheCleanup(currentChecksum);
      this.#currentChecksum = currentChecksum;

      if (attachment.lastSentChecksum === currentChecksum) {
        return;
      }

      const nextView = logic.getView(this.#currentState, attachment.caller);

      let lastView: Partial<TView> = {} as Partial<TView>;
      if (attachment.lastSentChecksum) {
        const cached = this.#viewCache.get(attachment.lastSentChecksum);
        if (cached) {
          const cachedState = logic.restore(cached.serialized);
          lastView = logic.getView(
            cachedState,
            attachment.caller
          ) as Partial<TView>;
        }
      }

      const operations = compare(
        lastView as Record<string, unknown>,
        nextView as Record<string, unknown>
      );
      if (operations.length === 0) {
        return;
      }

      ws.send(JSON.stringify({ operations, checksum: currentChecksum }));
      attachment.lastSentChecksum = currentChecksum;
      ws.serializeAttachment(attachment);
    }

    async #persistSnapshot() {
      assert(this.#currentState, "Actor state is not initialized");
      const serialized = logic.serialize(this.#currentState);

      if (
        this.#lastPersistedSerialized &&
        compare(
          this.#lastPersistedSerialized as Record<string, unknown>,
          serialized as Record<string, unknown>
        ).length === 0
      ) {
        return;
      }

      await Promise.all([
        this.#storage.put(
          PERSISTED_SNAPSHOT_KEY,
          JSON.stringify(serialized)
        ),
        this.#storage.put(
          PERSISTED_VERSION_KEY,
          logic.version ?? 0
        ),
      ]);
      this.#lastPersistedSerialized = serialized;
    }

    async #loadPersistedSnapshot(): Promise<{
      serialized: unknown;
      version: number;
    } | null> {
      const [snapshotString, version] = await Promise.all([
        this.#storage.get(PERSISTED_SNAPSHOT_KEY),
        this.#storage.get(PERSISTED_VERSION_KEY),
      ]);
      if (!snapshotString) {
        return null;
      }
      return {
        serialized: JSON.parse(z.string().parse(snapshotString)),
        version: typeof version === "number" ? version : 0,
      };
    }

    #restorePersistedActor(persisted: {
      serialized: unknown;
      version: number;
    }) {
      assert(this.#actorId, "actorId is not set");
      assert(this.#actorType, "actorType is not set");
      assert(this.#initialCaller, "initialCaller is not set");
      assert(this.#input, "input is not set");

      // Always try migrate first if provided — adapters like XState
      // use structural comparison (not version numbers) for migration.
      // Version-based migration is a secondary check for non-XState users.
      if (logic.migrate) {
        this.#currentState = logic.migrate(
          persisted.serialized,
          persisted.version
        );
      } else {
        this.#currentState = logic.restore(persisted.serialized);
      }

      this.#lastPersistedSerialized = persisted.serialized;

      // Fire onResume lifecycle hook
      if (logic.onResume && this.#currentState) {
        this.#currentState = logic.onResume(this.#currentState);

        if (config.persisted) {
          this.#persistSnapshot().catch(() => {
            // Ignore persistence errors.
          });
        }
      }
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

      let input: Record<string, unknown> = {};
      if (searchParams.input) {
        try {
          input = JSON.parse(searchParams.input) as Record<string, unknown>;
          config.input.parse(input);
        } catch (error: unknown) {
          return new Response(`Invalid input: ${getErrorMessage(error)}`, {
            status: 400,
          });
        }
      }

      const caller = await this.#getValidatedCaller(
        request,
        actorType,
        actorId
      );
      if (!caller) {
        return new Response("Unauthorized", { status: 401 });
      }

      await this.#storeActorData(actorType, actorId, caller, input);
      this.#actorType = actorType;
      this.#actorId = actorId;
      this.#initialCaller = caller;
      this.#input = input;

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
          this.#env.ACTOR_KIT_SECRET
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
        this.#storage.put("actorType", actorType),
        this.#storage.put("actorId", actorId),
        this.#storage.put("initialCaller", JSON.stringify(caller)),
        this.#storage.put("input", JSON.stringify(input)),
      ]);
    }

    #isActorRunning() {
      return Boolean(this.#actorType);
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
      assert(this.#actorType, "actorType is not set");
      assert(this.#actorId, "actorId is not set");

      const webSocketPair = new WebSocketPair();
      const client = webSocketPair[0];
      const server = webSocketPair[1] as ActorKitWebSocket;

      const caller = await this.#getValidatedCaller(
        request,
        this.#actorType,
        this.#actorId
      );
      if (!caller) {
        return new Response("Unauthorized", { status: 401 });
      }

      this.#doState.acceptWebSocket(server);
      server.serializeAttachment({
        caller,
        lastSentChecksum: clientChecksum ?? undefined,
      });

      // Subscribe the new socket first so it receives updates
      this.#subscribeSocketToActor(server);

      // Fire onConnect lifecycle hook — may change shared state
      if (logic.onConnect && this.#currentState) {
        this.#currentState = logic.onConnect(this.#currentState, caller);
        if (persisted) {
          this.#persistSnapshot().catch(() => {
            // Ignore persistence errors.
          });
        }
        // Broadcast to ALL connected sockets (including the new one)
        // so existing clients see the state change from onConnect
        for (const ws of this.#doState.getWebSockets()) {
          this.#enqueueSendStateUpdate(ws as ActorKitWebSocket);
        }
      }

      return new Response(null, {
        status: 101,
        webSocket: client,
      } as WebSocketResponseInit);
    }

    async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
      const attachment = this.#attachments.get(ws);
      assert(attachment, "Attachment missing for WebSocket");

      const messageString =
        typeof message === "string"
          ? message
          : new TextDecoder().decode(message);
      const parsedMessage = ParsedMessageSchema.parse(messageString);

      if (attachment.caller.type === "client") {
        const clientEvent = events.client.parse(parsedMessage);
        this.send({
          ...clientEvent,
          caller: attachment.caller,
        });
        return;
      }

      if (attachment.caller.type === "service") {
        const serviceEvent = events.service.parse(parsedMessage);
        this.send({
          ...serviceEvent,
          caller: attachment.caller,
        });
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
      // Fire onDisconnect lifecycle hook
      const attachment = this.#attachments.get(ws);
      if (logic.onDisconnect && this.#currentState && attachment) {
        this.#currentState = logic.onDisconnect(
          this.#currentState,
          attachment.caller
        );
        if (persisted) {
          this.#persistSnapshot().catch(() => {
            // Ignore persistence errors.
          });
        }
        // Notify remaining sockets of state change
        for (const otherWs of this.#attachments.keys()) {
          if (otherWs !== ws) {
            this.#enqueueSendStateUpdate(otherWs as ActorKitWebSocket);
          }
        }
      }

      ws.close(code, "Durable Object is closing WebSocket");
      this.#attachments.delete(ws);
      this.#sendQueues.delete(ws);
    }

    send(event: { type: string; caller: Caller; [key: string]: unknown }) {
      assert(this.#currentState, "Actor state is not initialized");
      this.#applyTransition({
        ...event,
        env: this.#env,
      } as TEvent & { caller: Caller; env: TEnv });
    }

    async getSnapshot(
      caller: Caller
    ): Promise<{
      checksum: string;
      snapshot: TView;
    }> {
      this.#ensureActorRunning();
      assert(this.#currentState, "Actor state is not initialized");

      const view = logic.getView(this.#currentState, caller);
      const serialized = logic.serialize(this.#currentState);
      const checksum = await this.#calculateChecksum(serialized);

      return { checksum, snapshot: view };
    }

    async spawn(props: {
      actorType: string;
      actorId: string;
      caller: Caller;
      input: Record<string, unknown>;
    }) {
      if (this.#actorType || this.#actorId || this.#initialCaller) {
        return;
      }

      // Validate input BEFORE persisting — prevents storing invalid state
      // that can't be recovered from on subsequent requests.
      config.input.parse(props.input);

      await this.#storeActorData(
        props.actorType,
        props.actorId,
        props.caller,
        props.input
      );
      this.#actorType = props.actorType;
      this.#actorId = props.actorId;
      this.#initialCaller = props.caller;
      this.#input = props.input;
      this.#ensureActorRunning();
    }

    async #calculateChecksum(serialized: unknown) {
      const str = JSON.stringify(serialized);
      const buffer = new TextEncoder().encode(str);
      const hash = await crypto.subtle.digest("SHA-256", buffer);
      const array = new Uint8Array(hash);
      return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
    }

    #scheduleViewCacheCleanup(checksum: string) {
      setTimeout(() => {
        this.#cleanupViewCache(checksum);
      }, 300000);
    }

    #startPeriodicCacheCleanup() {
      setInterval(() => {
        const now = Date.now();
        for (const [checksum, { timestamp }] of this.#viewCache.entries()) {
          if (now - timestamp > 300000) {
            this.#viewCache.delete(checksum);
          }
        }
      }, 300000);
    }

    #cleanupViewCache(checksum: string) {
      if (checksum === this.#currentChecksum) {
        return;
      }

      const cachedData = this.#viewCache.get(checksum);
      if (cachedData && Date.now() - cachedData.timestamp > 300000) {
        this.#viewCache.delete(checksum);
      }
    }
  };
}
