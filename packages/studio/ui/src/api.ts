/** Studio API client — fetches from /__studio/api/* endpoints. */

const BASE = "/__studio/api";

function getHeaders(): HeadersInit {
  const key = localStorage.getItem("actor-kit-studio-key");
  if (key) return { "X-Actor-Kit-Studio-Key": key };
  return {};
}

export interface ActorEntry {
  actorType: string;
  actorId: string;
  lastActiveAt: number;
  version: number | null;
  connectionCount: number;
}

export interface StudioConnectionInfo {
  caller: string;
  callerType: "user" | "service";
  connectedAt: number;
  role: string | null;
}

export interface InspectResult {
  state: unknown;
  version: number;
  actorId: string | null;
  connections: StudioConnectionInfo[];
  outbox: Array<{
    id: string;
    service: string;
    payload: string;
    status: string;
    attempts: number;
    createdAt: number;
  }>;
  activeLinks: Array<{
    targetType: string;
    targetId: string;
    linkName: string;
    version: number;
  }>;
  linkSubscribers: Array<{
    subscriberType: string;
    subscriberId: string;
  }>;
}

export interface TimelineEntry {
  id: number;
  causeType: string;
  causeData: string;
  stateSnapshot: string;
  checksum: string;
  createdAt: number;
}

/** Parse a JSON response, throwing on non-OK status or server-side errors. */
async function parseJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(text);
  }
  const data = (await res.json()) as T & { error?: string };
  if (data.error) {
    throw new Error(data.error);
  }
  return data;
}

export async function fetchActors(opts?: {
  type?: string;
  search?: string;
}): Promise<ActorEntry[]> {
  const params = new URLSearchParams();
  if (opts?.type) params.set("type", opts.type);
  if (opts?.search) params.set("search", opts.search);
  const url = `${BASE}/actors${params.toString() ? `?${params}` : ""}`;
  const res = await fetch(url, { headers: getHeaders() });
  const data = await parseJson<{ actors: ActorEntry[] }>(res);
  return data.actors;
}

export async function fetchActorTypes(): Promise<string[]> {
  const res = await fetch(`${BASE}/actors/types`, { headers: getHeaders() });
  const data = await parseJson<{ types: string[] }>(res);
  return data.types;
}

export async function fetchInspect(
  actorType: string,
  actorId: string,
): Promise<InspectResult> {
  const res = await fetch(`${BASE}/actors/${actorType}/${encodeURIComponent(actorId)}`, {
    headers: getHeaders(),
  });
  return parseJson<InspectResult>(res);
}

export async function fetchTimeline(
  actorType: string,
  actorId: string,
  opts?: { limit?: number; before?: number },
): Promise<{ entries: TimelineEntry[]; hasMore: boolean }> {
  const params = new URLSearchParams();
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.before) params.set("before", String(opts.before));
  const url = `${BASE}/actors/${actorType}/${encodeURIComponent(actorId)}/timeline${params.toString() ? `?${params}` : ""}`;
  const res = await fetch(url, { headers: getHeaders() });
  return parseJson<{ entries: TimelineEntry[]; hasMore: boolean }>(res);
}
