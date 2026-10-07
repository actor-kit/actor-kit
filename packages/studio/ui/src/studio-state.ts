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

export function studioReducer(state: StudioViewState, event: StudioEvent): StudioViewState {
  switch (event.type) {
    case "reset":
      return initialStudioState;
    case "socket-open":
      return { ...state, status: "live", error: null };
    case "socket-closed":
      if (state.status === "error") return state;
      if (state.status === "polling" || state.status === "not-found") return state;
      return { ...state, status: "reconnecting" };
    case "malformed-frame":
      return { ...state, error: `Malformed studio frame: ${event.error}` };
    case "http-loaded":
      return {
        inspect: event.inspect,
        timeline: capTimeline(event.timeline),
        status: "polling",
        error: null,
      };
    case "request-failed":
      return {
        ...state,
        status: event.failure === "permanent" ? "error" : event.failure === "not-found" ? "not-found" : state.status,
        error: event.error,
      };
    case "frame":
      return applyFrame(state, event.frame);
  }
}

function applyFrame(state: StudioViewState, frame: StudioFrame): StudioViewState {
  switch (frame.type) {
    case "studio.snapshot":
      return {
        ...state,
        inspect: {
          state: frame.state,
          version: frame.version,
          actorId: frame.actorId,
          connections: frame.connections,
          outbox: frame.outbox,
          activeLinks: frame.activeLinks,
          linkSubscribers: frame.linkSubscribers,
        },
        timeline: capTimeline(frame.timeline),
        error: null,
      };

    case "studio.timeline": {
      if (state.timeline.some((e) => e.id === frame.entry.id)) return state;
      return {
        ...state,
        timeline: capTimeline([frame.entry, ...state.timeline]),
        inspect: state.inspect === null ? null : { ...state.inspect, state: frame.entry.state },
      };
    }

    case "studio.connection": {
      if (state.inspect === null) return state;
      const { caller, callerType } = frame.connection;
      const others = state.inspect.connections.filter((c) => c.caller !== caller || c.callerType !== callerType);
      const connections = frame.action === "connect" ? [...others, frame.connection] : others;
      return { ...state, inspect: { ...state.inspect, connections } };
    }
  }
}

function capTimeline(timeline: TimelineItem[]): TimelineItem[] {
  return timeline.length > MAX_TIMELINE_ENTRIES ? timeline.slice(0, MAX_TIMELINE_ENTRIES) : timeline;
}
