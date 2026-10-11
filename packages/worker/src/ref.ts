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

import { ActorKitError, type ContractMessages, type Refusal, refusal } from "@actor-kit/core";
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
  send?(caller: string, callerType: string, message: unknown): Promise<{ ok: true } | Refusal>;
  getSnapshot?(caller: string, callerType: string): Promise<{ snapshot: unknown; role: string; checksum: string }>;
}

export interface ActorRef<TMessage extends { type: string } = { type: string; [key: string]: unknown }> {
  readonly actorType: string;
  readonly actorId: string;
  spawn(input: { actorId?: string; caller: string; callerType: "user" | "service"; input: unknown }): Promise<void>;
  /** Accepted, or a typed refusal (ADR-018 C). */
  send(caller: string, callerType: "user" | "service", message: TMessage): Promise<{ ok: true } | Refusal>;
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
export function createRef<T extends ActorContract>(
  contract: T,
  exports: Record<string, unknown>,
  env: Record<string, unknown>,
  actorId: string,
  locationHint?: LocationHint,
): ActorRef<ContractMessages<T>>;

/** Contract overload — message types inferred from contract messages. */
export function createRef<T extends ActorContract>(
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
    return contractRef(contractOrEnv, exportsOrEnvOrActorType, envOrActorId, actorIdOrLocationHint, maybeLocationHint);
  }

  // Legacy: createRef(env, actorType, actorId, locationHint?)
  const actorType = String(exportsOrEnvOrActorType);
  const actorId = String(envOrActorId);
  const stub = openStub(
    contractOrEnv[actorType],
    `DO namespace "${actorType}" not found in env`,
    actorId,
    actorIdOrLocationHint,
  );
  return buildRef(actorType, actorId, stub);
}

function contractRef(
  contract: ActorContract,
  exportsOrEnv: Record<string, unknown> | string,
  envOrActorId: Record<string, unknown> | string,
  actorIdOrLocationHint: string | undefined,
  maybeLocationHint: LocationHint | undefined,
): ActorRef {
  if (typeof exportsOrEnv === "object" && typeof envOrActorId === "object") {
    // createRef(contract, exports, env, actorId, locationHint?)
    const actorId = actorIdOrLocationHint;
    if (typeof actorId !== "string") {
      throw new ActorKitError("invalid_ref", "createRef(contract, exports, env, actorId): actorId must be a string");
    }
    const namespaceValue: unknown = resolveNamespace(contract.name, exportsOrEnv, envOrActorId);
    const error = `Resolved namespace for "${contract.name}" is not a valid DO namespace`;
    return buildRef(contract.name, actorId, openStub(namespaceValue, error, actorId, maybeLocationHint));
  }

  if (typeof exportsOrEnv === "object" && typeof envOrActorId === "string") {
    // createRef(contract, env, actorId, locationHint?)
    const actorType = contract.name.toUpperCase().replace(/-/g, "_");
    const error = `DO namespace "${actorType}" not found in env`;
    return buildRef(
      actorType,
      envOrActorId,
      openStub(exportsOrEnv[actorType], error, envOrActorId, actorIdOrLocationHint),
    );
  }

  throw new ActorKitError("invalid_ref", "createRef(contract, ...): second argument must be an env or exports object");
}

/** A stub for one actor in a namespace (throws `error` when the value is not a DO namespace). */
function openStub(namespace: unknown, error: string, actorId: string, locationHint: string | undefined): DOStub {
  if (!isDONamespace(namespace)) throw new ActorKitError("actor_not_found", error);
  return namespace.get(namespace.idFromName(actorId), locationHint ? { locationHint } : undefined);
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
      return refusal(
        "actor_not_found",
        "stub.send not available: this binding is not an actor-kit Durable Object. Bind the class createActorClass() returns.",
      );
    },

    async getSnapshot(caller, callerType) {
      if (typeof stub.getSnapshot === "function") {
        return stub.getSnapshot(caller, callerType);
      }
      throw new ActorKitError(
        "actor_not_found",
        "stub.getSnapshot not available: this binding is not an actor-kit Durable Object. Bind the class createActorClass() returns.",
      );
    },
  };
}
