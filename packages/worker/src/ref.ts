/**
 * ref() — creates a typed reference to another actor (DO) for RPC communication.
 *
 * Usage (v3 — contract-derived):
 *   const counter = createRef(Counter, env, "counter-1");
 *   await counter.send("service-1", "service", { type: "INCREMENT", amount: 1 });
 *
 * Usage (legacy):
 *   const zone = createRef(env, "ZONE", "forest-north");
 *   await zone.send("service-1", "service", { type: "ACCEPT_TRANSFER", ... });
 */

import type { ActorContract } from "./define";
import { resolveNamespace } from "./runtime/resolve-namespace";

// Minimal DO namespace interface — compatible with CF's DurableObjectNamespace
interface DONamespace {
  idFromName(name: string): DOId;
  get(id: DOId, options?: { locationHint?: string }): DOStub;
}

interface DOId {
  toString(): string;
}

interface DOStub {
  spawn?(input: unknown): Promise<void>;
  send?(caller: string, callerType: string, message: unknown): Promise<{ ok: boolean; error?: string }>;
  getSnapshot?(caller: string, callerType: string): Promise<{ snapshot: unknown; role: string; checksum: string }>;
}

export interface ActorRef<TMessage extends { type: string } = { type: string; [key: string]: unknown }> {
  readonly actorType: string;
  readonly actorId: string;
  spawn(input: { actorId?: string; caller: string; callerType: "user" | "service"; input: unknown }): Promise<void>;
  send(caller: string, callerType: "user" | "service", message: TMessage): Promise<{ ok: boolean; error?: string }>;
  getSnapshot(
    caller: string,
    callerType: "user" | "service",
  ): Promise<{ snapshot: unknown; role: string; checksum: string }>;
}

/**
 * CF location hint for influencing where a DO is created.
 * See https://developers.cloudflare.com/durable-objects/reference/data-location/
 */
export type LocationHint = "wnam" | "enam" | "sam" | "weur" | "eeur" | "apac" | "oc" | "afr" | "me";

/**
 * Extract the message union from a contract's flat messages.
 * Each message name K becomes { type: K } & payload.
 * Payload is inferred from the Zod schema's _output type.
 *
 * Only matches flat messages (values have `schema` property).
 * Nested role-based messages fall through to loose message typing.
 */
type ContractMessages<T> = T extends {
  def: { messages: Record<string, { schema: { _output: unknown } }> };
}
  ? {
      [K in keyof T["def"]["messages"] & string]: T["def"]["messages"][K] extends {
        schema: { _output: infer P };
      }
        ? { type: K } & P
        : { type: K };
    }[keyof T["def"]["messages"] & string]
  : { type: string; [key: string]: unknown };

/** Type guard: is this an ActorContract (has name + def)? */
function isActorContract(value: unknown): value is ActorContract {
  if (typeof value !== "object" || value === null) return false;
  if (!("name" in value) || typeof value.name !== "string") return false;
  if (!("def" in value)) return false;
  return true;
}

/** Type guard: is this a DONamespace (has idFromName + get)? */
function isDONamespace(value: unknown): value is DONamespace {
  if (typeof value !== "object" || value === null) return false;
  if (!("idFromName" in value) || typeof value.idFromName !== "function") return false;
  if (!("get" in value) || typeof value.get !== "function") return false;
  return true;
}

/** Contract overload with ctx.exports — resolves namespace from exports, falls back to env. */
export function createRef<
  T extends ActorContract<string, { messages: Record<string, { schema: { _output: unknown } }> }>,
>(
  contract: T,
  exports: Record<string, unknown>,
  env: Record<string, unknown>,
  actorId: string,
  locationHint?: LocationHint,
): ActorRef<ContractMessages<T>>;

/** Contract overload — message types inferred from contract messages. */
export function createRef<
  T extends ActorContract<string, { messages: Record<string, { schema: { _output: unknown } }> }>,
>(
  contract: T,
  env: Record<string, unknown>,
  actorId: string,
  locationHint?: LocationHint,
): ActorRef<ContractMessages<T>>;

/** Legacy overload — untyped messages. */
export function createRef(
  env: Record<string, unknown>,
  actorType: string,
  actorId: string,
  locationHint?: LocationHint,
): ActorRef;

export function createRef(
  contractOrEnv: ActorContract | Record<string, unknown>,
  exportsOrEnvOrActorType: Record<string, unknown> | string,
  envOrActorId: Record<string, unknown> | string,
  actorIdOrLocationHint?: string | LocationHint,
  maybeLocationHint?: LocationHint,
): ActorRef {
  // Dispatch: contract-based vs legacy
  if (isActorContract(contractOrEnv)) {
    const contract = contractOrEnv;

    if (typeof exportsOrEnvOrActorType === "object" && typeof envOrActorId === "object") {
      // createRef(contract, exports, env, actorId, locationHint?)
      const exports = exportsOrEnvOrActorType;
      const env = envOrActorId;
      const actorId = actorIdOrLocationHint;
      if (typeof actorId !== "string") {
        throw new Error("createRef(contract, exports, env, actorId): actorId must be a string");
      }
      const locationHint = maybeLocationHint;
      const namespaceValue: unknown = resolveNamespace(contract.name, exports, env);
      if (!isDONamespace(namespaceValue)) {
        throw new Error(`Resolved namespace for "${contract.name}" is not a valid DO namespace`);
      }
      const id = namespaceValue.idFromName(actorId);
      const stub = namespaceValue.get(id, locationHint ? { locationHint } : undefined);
      return buildRef(contract.name, actorId, stub);
    }

    if (typeof exportsOrEnvOrActorType === "object" && typeof envOrActorId === "string") {
      // createRef(contract, env, actorId, locationHint?)
      const env = exportsOrEnvOrActorType;
      const actorId = envOrActorId;
      const locationHint = actorIdOrLocationHint;
      const actorType = contract.name.toUpperCase().replace(/-/g, "_");
      const namespaceValue: unknown = env[actorType];
      if (!isDONamespace(namespaceValue)) {
        throw new Error(`DO namespace "${actorType}" not found in env`);
      }
      const id = namespaceValue.idFromName(actorId);
      const stub = namespaceValue.get(id, locationHint ? { locationHint } : undefined);
      return buildRef(actorType, actorId, stub);
    }

    throw new Error("createRef(contract, ...): second argument must be an env or exports object");
  }

  // Legacy: createRef(env, actorType, actorId, locationHint?)
  const env = contractOrEnv;
  const actorType = String(exportsOrEnvOrActorType);
  const actorId = String(envOrActorId);
  const locationHint = actorIdOrLocationHint;
  const namespaceValue: unknown = env[actorType];
  if (!isDONamespace(namespaceValue)) {
    throw new Error(`DO namespace "${actorType}" not found in env`);
  }
  const id = namespaceValue.idFromName(actorId);
  const stub = namespaceValue.get(id, locationHint ? { locationHint } : undefined);
  return buildRef(actorType, actorId, stub);
}

function buildRef(actorType: string, actorId: string, stub: DOStub): ActorRef {
  return {
    actorType,
    actorId,

    async spawn(input) {
      if (typeof stub.spawn === "function") {
        await stub.spawn(input);
      }
    },

    async send(caller, callerType, message) {
      if (typeof stub.send === "function") {
        return stub.send(caller, callerType, message);
      }
      return { ok: false, error: "stub.send not available" };
    },

    async getSnapshot(caller, callerType) {
      if (typeof stub.getSnapshot === "function") {
        return stub.getSnapshot(caller, callerType);
      }
      throw new Error("stub.getSnapshot not available");
    },
  };
}
