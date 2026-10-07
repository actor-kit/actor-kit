/** Studio API client — fetches from /__studio/api/* endpoints and parses every response. */

import type { z } from "zod";
import {
  ActorTypesResponseSchema,
  ActorsResponseSchema,
  type ActorEntry,
  ErrorBodySchema,
  type InspectResult,
  InspectSchema,
  TimelineResponseSchema,
  type TimelineItem,
  formatIssues,
} from "./protocol";

export type { ActorEntry, InspectResult, StudioConnectionInfo, TimelineItem } from "./protocol";

const BASE = "/__studio/api";

export type StudioApiErrorKind =
  | "bad-request"
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "unavailable"
  | "server"
  | "network"
  | "malformed";

/** A failed Studio API call, classified so the UI can pick the right error state. */
export class StudioApiError extends Error {
  readonly kind: StudioApiErrorKind;
  readonly status: number | null;

  constructor(kind: StudioApiErrorKind, message: string, status: number | null) {
    super(message);
    this.name = "StudioApiError";
    this.kind = kind;
    this.status = status;
  }

  /** Retrying will not help: the request is not allowed or is itself invalid. */
  get permanent(): boolean {
    return this.kind === "unauthorized" || this.kind === "forbidden" || this.kind === "bad-request";
  }
}

function kindForStatus(status: number): StudioApiErrorKind {
  if (status === 400) return "bad-request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 503) return "unavailable";
  return "server";
}

/** Pull a readable message out of an error response body (JSON `{error}` or plain text). */
function errorMessage(status: number, text: string): string {
  let message = text.trim();
  try {
    const body = ErrorBodySchema.safeParse(JSON.parse(text));
    if (body.success) message = body.data.error;
  } catch {
    // Plain-text body
  }
  if (message === "") message = `HTTP ${status}`;
  if (status === 401 && !/unauthori[sz]ed/i.test(message)) return `Unauthorized: ${message}`;
  return message;
}

async function request<S extends z.ZodType>(url: string, schema: S, signal?: AbortSignal): Promise<z.output<S>> {
  let res: Response;
  try {
    // Production auth is the Cloudflare Access cookie (ADR-014), sent automatically on same-origin requests.
    res = await fetch(url, signal === undefined ? {} : { signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new StudioApiError("network", "Network error: could not reach the Studio API", null);
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new StudioApiError(kindForStatus(res.status), errorMessage(res.status, text), res.status);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new StudioApiError("malformed", "Malformed response: body is not JSON", res.status);
  }
  const errorBody = ErrorBodySchema.safeParse(json);
  if (errorBody.success) {
    throw new StudioApiError("server", errorBody.data.error, res.status);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new StudioApiError("malformed", `Malformed response: ${formatIssues(parsed.error)}`, res.status);
  }
  return parsed.data;
}

function actorPath(actorType: string, actorId: string): string {
  return `${BASE}/actors/${encodeURIComponent(actorType)}/${encodeURIComponent(actorId)}`;
}

export async function fetchActors(
  opts?: { type?: string; search?: string; limit?: number; offset?: number },
  signal?: AbortSignal,
): Promise<ActorEntry[]> {
  const params = new URLSearchParams();
  if (opts?.type) params.set("type", opts.type);
  if (opts?.search) params.set("search", opts.search);
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts?.offset) params.set("offset", String(opts.offset));
  const query = params.toString();
  const data = await request(`${BASE}/actors${query ? `?${query}` : ""}`, ActorsResponseSchema, signal);
  return data.actors;
}

export async function fetchActorTypes(signal?: AbortSignal): Promise<string[]> {
  const data = await request(`${BASE}/actors/types`, ActorTypesResponseSchema, signal);
  return data.types;
}

export function fetchInspect(actorType: string, actorId: string, signal?: AbortSignal): Promise<InspectResult> {
  return request(actorPath(actorType, actorId), InspectSchema, signal);
}

export function fetchTimeline(
  actorType: string,
  actorId: string,
  opts?: { limit?: number; before?: number },
  signal?: AbortSignal,
): Promise<{ entries: TimelineItem[]; hasMore: boolean }> {
  const params = new URLSearchParams();
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.before) params.set("before", String(opts.before));
  const query = params.toString();
  return request(`${actorPath(actorType, actorId)}/timeline${query ? `?${query}` : ""}`, TimelineResponseSchema, signal);
}
