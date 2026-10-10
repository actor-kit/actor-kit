/**
 * Pure state machine for one actor's Studio view.
 *
 * The WebSocket hook feeds it already-parsed frames and connection events;
 * this module decides what the page shows. No I/O here.
 */
import type { InspectResult, StudioFrame, TimelineItem } from "./protocol";

/** The server keeps at most this many timeline rows by default; the UI keeps the same. */
export const MAX_TIMELINE_ENTRIES = 500;

export type StudioStatus =
  /** First socket attempt in flight, nothing shown yet. */
  | "connecting"
  /** Socket open, live frames flowing. */
  | "live"
  /** Socket dropped; retrying. Last known data stays on screen. */
  | "reconnecting"
  /** Socket unavailable but the HTTP API answers; data refreshes on each retry. */
  | "polling"
  /** The API says the actor (or its type) doesn't exist (404). Retrying in case it gets created. */
  | "not-found"
  /** Permanent failure (unauthorized, forbidden, bad request). No more retries. */
  | "error";

export interface StudioViewState {
  inspect: InspectResult | null;
  timeline: TimelineItem[];
  status: StudioStatus;
  /** Most recent problem (malformed frame, failed request). Cleared by fresh data. */
  error: string | null;
}

export type StudioEvent =
  | { type: "reset" }
  | { type: "socket-open" }
  | { type: "socket-closed" }
  | { type: "frame"; frame: StudioFrame }
  | { type: "malformed-frame"; error: string }
  | { type: "http-loaded"; inspect: InspectResult; timeline: TimelineItem[] }
  | { type: "request-failed"; error: string; failure: RequestFailure };

/** How a failed request affects the page: give up, wait for the actor to exist, or just retry. */
export type RequestFailure = "permanent" | "not-found" | "transient";

export const initialStudioState: StudioViewState = {
  inspect: null,
  timeline: [],
  status: "connecting",
  error: null,
};

/** A failed request moves the page to this status; null keeps the current one. */
const STATUS_AFTER_FAILURE: Record<RequestFailure, StudioStatus | null> = {
  permanent: "error",
  "not-found": "not-found",
  transient: null,
};

/** Statuses a socket close leaves alone: the HTTP probe, not the socket, decides what they become. */
const KEPT_ON_SOCKET_CLOSE: ReadonlySet<StudioStatus> = new Set<StudioStatus>(["error", "polling", "not-found"]);

export function studioReducer(state: StudioViewState, event: StudioEvent): StudioViewState {
  switch (event.type) {
    case "reset":
      return initialStudioState;
    case "socket-open":
      return { ...state, status: "live", error: null };
    case "socket-closed":
      return KEPT_ON_SOCKET_CLOSE.has(state.status) ? state : { ...state, status: "reconnecting" };
    case "frame":
      return applyFrame(state, event.frame);
    default:
      return applyOutcome(state, event);
  }
}

type OutcomeEvent = Extract<StudioEvent, { type: "malformed-frame" | "http-loaded" | "request-failed" }>;

/** Results that carry data or an error: a bad frame, an HTTP load, a failed request. */
function applyOutcome(state: StudioViewState, event: OutcomeEvent): StudioViewState {
  switch (event.type) {
    case "malformed-frame":
      return { ...state, error: `Malformed studio frame: ${event.error}` };
    case "http-loaded":
      return { inspect: event.inspect, timeline: capTimeline(event.timeline), status: "polling", error: null };
    case "request-failed":
      return { ...state, status: STATUS_AFTER_FAILURE[event.failure] ?? state.status, error: event.error };
  }
}

function applyFrame(state: StudioViewState, frame: StudioFrame): StudioViewState {
  switch (frame.type) {
    case "studio.snapshot":
      return applySnapshot(state, frame);
    case "studio.timeline":
      return applyTimelineEntry(state, frame.entry);
    default:
      return state.inspect === null ? state : { ...state, inspect: patchInspect(state.inspect, frame) };
  }
}

type SnapshotFrame = Extract<StudioFrame, { type: "studio.snapshot" }>;
type InspectPatchFrame = Extract<
  StudioFrame,
  { type: "studio.connection" | "studio.outbox" | "studio.timers" | "studio.links" }
>;

function applySnapshot(state: StudioViewState, frame: SnapshotFrame): StudioViewState {
  const { state: actorState, version, actorId, connections, outbox, timers, activeLinks, linkSubscribers } = frame;
  return {
    ...state,
    inspect: { state: actorState, version, actorId, connections, outbox, timers, activeLinks, linkSubscribers },
    timeline: capTimeline(frame.timeline),
    error: null,
  };
}

function applyTimelineEntry(state: StudioViewState, entry: TimelineItem): StudioViewState {
  if (state.timeline.some((e) => e.id === entry.id)) return state;
  return {
    ...state,
    timeline: capTimeline([entry, ...state.timeline]),
    // An entry whose after-state is unknown says nothing about the current state.
    inspect:
      state.inspect === null || entry.stateUnavailable === true
        ? state.inspect
        : { ...state.inspect, state: entry.state },
  };
}

/** Frames that replace one part of the inspect data; they need a snapshot first. */
function patchInspect(inspect: InspectResult, frame: InspectPatchFrame): InspectResult {
  switch (frame.type) {
    case "studio.connection": {
      // One row per app socket: only the socket that connected or closed changes.
      const others = inspect.connections.filter((c) => c.connectionId !== frame.connection.connectionId);
      return { ...inspect, connections: frame.action === "connect" ? [...others, frame.connection] : others };
    }
    case "studio.outbox":
      return { ...inspect, outbox: frame.outbox };
    case "studio.timers":
      return { ...inspect, timers: frame.timers };
    case "studio.links":
      return { ...inspect, activeLinks: frame.activeLinks, linkSubscribers: frame.linkSubscribers };
  }
}

function capTimeline(timeline: TimelineItem[]): TimelineItem[] {
  return timeline.length > MAX_TIMELINE_ENTRIES ? timeline.slice(0, MAX_TIMELINE_ENTRIES) : timeline;
}
