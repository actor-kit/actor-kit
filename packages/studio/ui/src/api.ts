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

export interface InspectResult {
  state: unknown;
  version: number;
  actorId: string | null;
  connections: Array<{ caller: string; callerType: "user" | "service" }>;
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

export async function fetchActors(opts?: {
  type?: string;
  search?: string;
}): Promise<ActorEntry[]> {
  const params = new URLSearchParams();
  if (opts?.type) params.set("type", opts.type);
  if (opts?.search) params.set("search", opts.search);
  const url = `${BASE}/actors${params.toString() ? `?${params}` : ""}`;
  const res = await fetch(url, { headers: getHeaders() });
  const data = (await res.json()) as { actors: ActorEntry[] };
  return data.actors;
}

export async function fetchActorTypes(): Promise<string[]> {
  const res = await fetch(`${BASE}/actors/types`, { headers: getHeaders() });
  const data = (await res.json()) as { types: string[] };
  return data.types;
}

export async function fetchInspect(
  actorType: string,
  actorId: string,
): Promise<InspectResult> {
  const res = await fetch(`${BASE}/actors/${actorType}/${encodeURIComponent(actorId)}`, {
    headers: getHeaders(),
  });
  return (await res.json()) as InspectResult;
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
  return (await res.json()) as { entries: TimelineEntry[]; hasMore: boolean };
}
