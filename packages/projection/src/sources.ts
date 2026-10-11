/**
 * Journal sources for rebuild() (ADR-019 E): the Studio journal route (ADR-019 F) over HTTP, or an
 * actor's `__journal` RPC through its Durable Object namespace (same Worker). Both return what the
 * journal query returns, redacted per ADR-014: fields named by `studio.redact` come back redacted, so
 * a read model must not depend on them.
 */

import { ActorKitError } from "@actor-kit/core";
import type { JournalSource } from "./rebuild";

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface StudioJournalSourceOptions {
  /** The Worker origin that serves `/__studio`. */
  readonly baseUrl: string;
  /** Auth headers, e.g. an Access service token (`CF-Access-Client-Id`, `CF-Access-Client-Secret`). */
  readonly headers?: Record<string, string>;
  readonly fetch?: FetchFn;
}

export function studioJournalSource(options: StudioJournalSourceOptions): JournalSource {
  const origin = new URL(options.baseUrl).origin;
  const doFetch: FetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  return {
    async journal(actorType, actorId, query) {
      const path = `/__studio/api/actors/${encodeURIComponent(actorType)}/${encodeURIComponent(actorId)}/journal`;
      const search = new URLSearchParams({ order: query.order, from: String(query.from), limit: String(query.limit) });
      const res = await doFetch(`${origin}${path}?${search}`, { headers: options.headers ?? {} });
      if (!res.ok) throw new ActorKitError("studio_request_failed", `journal of ${actorType}/${actorId}: ${res.status} ${await res.text()}`);
      return await res.json();
    },
  };
}

/** Structural slice of a DurableObjectNamespace. */
export interface ActorNamespace {
  idFromName(name: string): unknown;
  get(id: never): object;
}

export function actorJournalSource(namespaceFor: (actorType: string) => ActorNamespace | undefined): JournalSource {
  return {
    async journal(actorType, actorId, query) {
      const ns = namespaceFor(actorType);
      if (ns === undefined) throw new ActorKitError("actor_not_found", `actorJournalSource: no Durable Object namespace for actor type "${actorType}"`);
      const stub: object = Reflect.apply(ns.get, ns, [ns.idFromName(actorId)]);
      const rpc: unknown = Reflect.get(stub, "__journal");
      if (typeof rpc !== "function") {
        throw new ActorKitError(
          "actor_not_found",
          `actorJournalSource: ${actorType}/${actorId} has no __journal RPC (is it an Actor Kit actor with Studio enabled?)`,
        );
      }
      return await Reflect.apply(rpc, stub, [query]);
    },
  };
}
