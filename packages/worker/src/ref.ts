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

// Minimal DO namespace interface — compatible with CF's DurableObjectNamespace
interface DONamespace {
  idFromName(name: string): DOId;
  get(id: DOId): DOStub;
}

interface DOId {
  toString(): string;
}

interface DOStub {
  spawn?(input: unknown): Promise<void>;
  send?(caller: string, callerType: string, event: unknown): Promise<{ ok: boolean; error?: string }>;
  getSnapshot?(caller: string, callerType: string): Promise<{ snapshot: unknown; role: string; checksum: string }>;
}

export interface ActorRef<TEvent extends { type: string } = { type: string; [key: string]: unknown }> {
  readonly actorType: string;
  readonly actorId: string;
  spawn(input: { actorId?: string; caller: string; callerType: "user" | "service"; input: unknown }): Promise<void>;
  send(caller: string, callerType: "user" | "service", event: TEvent): Promise<{ ok: boolean; error?: string }>;
  getSnapshot(
    caller: string,
    callerType: "user" | "service",
  ): Promise<{ snapshot: unknown; role: string; checksum: string }>;
}

/**
 * Extract the event union from a contract's flat messages.
 * Each message name K becomes { type: K } & payload.
 * Payload is inferred from the Zod schema's _output type.
 *
 * Only matches flat messages (values have `schema` property).
 * Nested role-based messages fall through to loose event typing.
 */
type ContractEvents<T> = T extends {
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

/** Contract overload — event types inferred from contract messages. */
export function createRef<
  T extends ActorContract<string, { messages: Record<string, { schema: { _output: unknown } }> }>,
>(contract: T, env: Record<string, unknown>, actorId: string): ActorRef<ContractEvents<T>>;

/** Legacy overload — untyped events. */
export function createRef(env: Record<string, unknown>, actorType: string, actorId: string): ActorRef;

export function createRef(
  contractOrEnv: ActorContract | Record<string, unknown>,
  envOrActorType: Record<string, unknown> | string,
  actorId: string,
): ActorRef {
  let env: Record<string, unknown>;
  let actorType: string;

  if (isActorContract(contractOrEnv)) {
    if (typeof envOrActorType === "string") {
      throw new Error("createRef(contract, env, id): second argument must be env object, not string");
    }
    env = envOrActorType;
    actorType = contractOrEnv.name.toUpperCase().replace(/-/g, "_");
  } else {
    env = contractOrEnv;
    actorType = String(envOrActorType);
  }

  const namespaceValue: unknown = env[actorType];
  if (!isDONamespace(namespaceValue)) {
    throw new Error(`DO namespace "${actorType}" not found in env`);
  }

  const id = namespaceValue.idFromName(actorId);
  const stub = namespaceValue.get(id);

  return {
    actorType,
    actorId,

    async spawn(input) {
      if (typeof stub.spawn === "function") {
        await stub.spawn(input);
      }
    },

    async send(caller, callerType, event) {
      if (typeof stub.send === "function") {
        return stub.send(caller, callerType, event);
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
