// Server-only: access Cloudflare Worker env bindings via globalThis.__env__
// Set by nitro's cloudflare_module preset at runtime.

declare global {
  // biome-ignore lint/style/noVar: globalThis augmentation requires var
  var __env__: unknown;
}

// Structural types for DO RPC — avoids importing @cloudflare/workers-types in shared code.
// The runtime DO stubs satisfy these interfaces via Cloudflare's RPC proxy.

interface DurableObjectIdLike {
  toString(): string;
}

export interface ActorStub {
  spawn(input: Record<string, unknown>): Promise<void>;
  getSnapshot(
    caller: string,
    callerType: string,
  ): Promise<{ checksum: string; snapshot: unknown; role: string }>;
  send(
    caller: string,
    callerType: string,
    event: Record<string, unknown>,
  ): Promise<unknown>;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface ActorNamespace {
  idFromName(name: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): ActorStub;
}

export interface ActorEnv {
  TODO_LIST: ActorNamespace;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isActorNamespace(value: unknown): value is ActorNamespace {
  return (
    isRecord(value) &&
    typeof value.idFromName === "function" &&
    typeof value.get === "function"
  );
}

function isActorEnv(value: unknown): value is ActorEnv {
  return isRecord(value) && isActorNamespace(value.TODO_LIST);
}

export function getActorRuntimeEnv(): ActorEnv {
  if (!isActorEnv(globalThis.__env__)) {
    throw new Error("Cloudflare runtime bindings unavailable — is this running in a Worker?");
  }
  return globalThis.__env__;
}
