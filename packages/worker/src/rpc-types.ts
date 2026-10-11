/**
 * What the Durable Object's RPC methods resolve to, typed from the contract (Run Set Jimmy feedback 18).
 * Cloudflare's RPC types (`DurableObjectStub<T>`) map `unknown` to `never`, so a binding typed from the
 * actor class (`DurableObjectNamespace<InstanceType<typeof RoomActor>>`) needs every result spelled out:
 * views by role, the persisted state, and JSON where the library cannot know more.
 */
import type { ContractState, Infer, JsonValue, Refusal, SchemaDefinition } from "@actor-kit/core";
import type { JournalEntry, JournalEntryEmitted, JournalPage } from "./runtime/journal-query";

/** The data of a view: its schema's type (JSON for a view without one). */
export type ViewData<V> = V extends { readonly schema: SchemaDefinition<infer TShape> }
  ? Infer<SchemaDefinition<TShape>>
  : JsonValue;

type ViewsOf<T> = T extends { readonly def: { readonly views: infer V } } ? V : never;

/** One member per role with a view: `role` narrows the view's data. */
type PerRole<T, Member> = [keyof ViewsOf<T> & string] extends [never] ? Member : never;

/**
 * What `getSnapshot(caller, callerType)` resolves to: the caller's role and its view, one member per role
 * (`if (snap.role === "host") snap.snapshot.secret`), and the checksum of the view's JSON.
 */
export type ContractSnapshot<T> =
  | PerRole<T, { checksum: string; role: string; snapshot: JsonValue }>
  | {
      [K in keyof ViewsOf<T> & string]: { checksum: string; role: K; snapshot: ViewData<ViewsOf<T>[K]> };
    }[keyof ViewsOf<T> & string];

/** What `__getView({ role })` resolves to: the role's view (one member per role), or why it has none. */
export type ContractViewResult<T> =
  | { type: "studio.view"; role: string; caller: string | null; error: string }
  | PerRole<T, { type: "studio.view"; role: string; caller: string | null; callerRole: string | null; data: JsonValue }>
  | {
      [K in keyof ViewsOf<T> & string]: {
        type: "studio.view";
        role: K;
        caller: string | null;
        callerRole: string | null;
        data: ViewData<ViewsOf<T>[K]>;
      };
    }[keyof ViewsOf<T> & string];

/** The persisted state `__inspect()` returns: the contract's (with states, the path shape), else JSON. */
export type InspectedState<T> = unknown extends ContractState<T> ? JsonValue : ContractState<T>;

/** A refusal as it crosses RPC: `details` is JSON. */
export type RpcRefusal = Omit<Refusal, "details"> & { readonly details?: JsonValue };

/** A journal page as it crosses RPC: causes and emitted payloads are JSON. */
export type RpcJournalPage = Omit<JournalPage, "entries"> & {
  readonly entries: Array<
    Omit<JournalEntry, "cause" | "emitted"> & {
      readonly cause: { [key: string]: JsonValue };
      readonly emitted: ReadonlyArray<Omit<JournalEntryEmitted, "payload"> & { readonly payload: JsonValue }>;
    }
  >;
};
