/**
 * ref() — creates a typed reference to another actor (DO) for RPC communication.
 *
 * Usage:
 *   const zone = createRef(env, "ZONE", "forest-north");
 *   await zone.send("service-1", "service", { type: "ACCEPT_TRANSFER", ... });
 *   await zone.spawn({ actorId: "forest-north", caller: "service", callerType: "service", input: {} });
 */

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

export interface ActorRef {
  readonly actorType: string;
  readonly actorId: string;
  spawn(input: { actorId?: string; caller: string; callerType: "user" | "service"; input: unknown }): Promise<void>;
  send(
    caller: string,
    callerType: "user" | "service",
    event: { type: string; [key: string]: unknown },
  ): Promise<{ ok: boolean; error?: string }>;
  getSnapshot(
    caller: string,
    callerType: "user" | "service",
  ): Promise<{ snapshot: unknown; role: string; checksum: string }>;
}

export function createRef(env: Record<string, unknown>, actorType: string, actorId: string): ActorRef {
  const namespace = env[actorType] as DONamespace | undefined;
  if (!namespace) {
    throw new Error(`DO namespace "${actorType}" not found in env`);
  }

  const id = namespace.idFromName(actorId);
  const stub = namespace.get(id);

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
