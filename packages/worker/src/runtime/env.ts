/**
 * Typed `env` (ADR-016 §4).
 *
 * An actor may declare `env: z.object({ ... })`. The binding helpers below check a binding's runtime
 * shape and type it; plain Zod schemas check vars and secrets. The Durable Object parses the env once,
 * before it serves anything; if it does not parse, the actor refuses every request with a 500 naming
 * each missing or wrong binding, logs one structured line, and never runs a handler.
 */

import { z } from "zod";

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;

/** Whether `value` has every one of `methods` as a function. */
function hasMethods(value: unknown, methods: readonly string[]): boolean {
  return isObject(value) && methods.every((name) => typeof Reflect.get(value, name) === "function");
}

/** A binding schema: passes the binding through unchanged when it has the methods, typed as T. */
function binding<T>(kind: string, methods: readonly string[]) {
  return z.custom<T>((value) => hasMethods(value, methods), `expected ${kind} binding`);
}

/** A service binding (another Worker): typed as `T`, checked to have `fetch`. */
export function service<T = Fetcher>() {
  return binding<T>("a service", ["fetch"]);
}

/** A Durable Object namespace whose objects are `T`. */
export function durableObject<T extends Rpc.DurableObjectBranded | undefined = undefined>() {
  return binding<DurableObjectNamespace<T>>("a Durable Object namespace", ["idFromName", "get"]);
}

/** A Queue producer for messages of type `T`. */
export function queue<T = unknown>() {
  return binding<Queue<T>>("a Queue", ["send", "sendBatch"]);
}

export function kv() {
  return binding<KVNamespace>("a KV namespace", ["get", "put", "delete", "list"]);
}

export function r2() {
  return binding<R2Bucket>("an R2 bucket", ["get", "put", "head", "delete", "list"]);
}

export function d1() {
  return binding<D1Database>("a D1 database", ["prepare", "batch", "exec"]);
}

/** The structural slice of a Zod object schema the runtime parses the env with. */
export interface EnvParser {
  safeParse(
    env: unknown,
  ):
    | { success: true; data: unknown }
    | { success: false; error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> } };
}

/** One binding that did not parse: its name (the first path segment) and why. */
export interface EnvIssue {
  readonly binding: string;
  readonly message: string;
}

export type ParsedEnv =
  | { readonly ok: true; readonly env: unknown }
  | { readonly ok: false; readonly issues: EnvIssue[] };

/** Parse the Worker env against the actor's `env` schema. Without one, the env passes as it is. */
export function parseActorEnv(schema: EnvParser | undefined, env: unknown): ParsedEnv {
  if (schema === undefined) return { ok: true, env };
  const parsed = schema.safeParse(env);
  if (parsed.success) return { ok: true, env: parsed.data };
  const issues = parsed.error.issues.map((issue) => ({
    binding: issue.path.length === 0 ? "(env)" : String(issue.path[0]),
    message: issue.message,
  }));
  return { ok: false, issues };
}

/** The text of the 500 every request gets from an actor whose env did not parse. */
export function envErrorMessage(actorType: string, issues: readonly EnvIssue[]): string {
  const lines = issues.map((issue) => `- ${issue.binding}: ${issue.message}`);
  return [`Actor "${actorType}" cannot run: its env does not match its schema.`, ...lines].join("\n");
}

/** The one structured log line for an env that did not parse (binding names and reasons, never values). */
export function envInvalidEvent(actorType: string, issues: readonly EnvIssue[]) {
  return { event: "actor_kit.env.invalid", actorType, bindings: issues.map((issue) => issue.binding), issues };
}
