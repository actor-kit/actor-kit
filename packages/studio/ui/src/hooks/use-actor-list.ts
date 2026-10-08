import { useEffect, useState } from "react";
import { type ActorEntry, fetchActors, fetchActorTypes, StudioApiError } from "../api";

/** Rows per dashboard page. One extra row is requested to know whether a next page exists. */
export const PAGE_SIZE = 50;

export type ListState =
  | { kind: "loading" }
  | { kind: "loaded"; actors: ActorEntry[]; hasMore: boolean }
  | { kind: "failed"; message: string; unauthorized: boolean };

export interface ListQuery {
  typeFilter: string;
  search: string;
  offset: number;
}

/** A failed list request as the dashboard shows it; 401/403 offer a fresh sign-in. */
export function listFailure(err: unknown): ListState {
  return {
    kind: "failed",
    message: err instanceof Error ? err.message : "Failed to fetch actors",
    unauthorized: err instanceof StudioApiError && (err.kind === "unauthorized" || err.kind === "forbidden"),
  };
}

/** The registered actor types. Optional: on failure the list stays empty (the actor list reports errors). */
export function useActorTypes(): string[] {
  const [types, setTypes] = useState<string[]>([]);
  useEffect(() => {
    const abort = new AbortController();
    fetchActorTypes(abort.signal)
      .then(setTypes)
      .catch(() => {
        // The type list is optional: the actor list reports registry errors.
      });
    return () => abort.abort();
  }, []);
  return types;
}

/** One page of the actor registry for the current filter, search and offset. */
export function useActorList({ typeFilter, search, offset }: ListQuery): ListState {
  const [list, setList] = useState<ListState>({ kind: "loading" });
  useEffect(() => {
    // Each request owns an AbortController; a newer filter/search/page aborts
    // the older request, so a slow stale response can never overwrite it.
    const abort = new AbortController();
    setList({ kind: "loading" });
    fetchActors(
      { type: typeFilter || undefined, search: search || undefined, limit: PAGE_SIZE + 1, offset },
      abort.signal,
    )
      .then((rows) => {
        if (abort.signal.aborted) return;
        setList({ kind: "loaded", actors: rows.slice(0, PAGE_SIZE), hasMore: rows.length > PAGE_SIZE });
      })
      .catch((err: unknown) => {
        // An AbortError only ever comes from this request's own (now aborted) signal.
        if (abort.signal.aborted) return;
        setList(listFailure(err));
      });
    return () => abort.abort();
  }, [typeFilter, search, offset]);
  return list;
}
