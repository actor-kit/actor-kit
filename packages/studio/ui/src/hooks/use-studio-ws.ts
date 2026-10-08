import { useEffect, useReducer } from "react";
import { fetchInspect, fetchTimeline, StudioApiError } from "../api";
import type { InspectResult, TimelineItem } from "../protocol";
import { parseStudioFrame } from "../protocol";
import { initialStudioState, type RequestFailure, type StudioStatus, studioReducer } from "../studio-state";

export interface StudioWsState {
  inspect: InspectResult | null;
  timeline: TimelineItem[];
  status: StudioStatus;
  error: string | null;
  /** True while the live WebSocket is open. */
  connected: boolean;
}

const BASE_RETRY_MS = 500;
const MAX_RETRY_MS = 10_000;

/** Exponential backoff: 0.5s, 1s, 2s, … capped at 10s. */
export function reconnectDelay(attempt: number): number {
  return Math.min(BASE_RETRY_MS * 2 ** attempt, MAX_RETRY_MS);
}

function classifyFailure(err: StudioApiError): RequestFailure {
  if (err.permanent) return "permanent";
  return err.kind === "not-found" ? "not-found" : "transient";
}

/** What a failed HTTP probe means for the page. Anything but an API error is worth retrying. */
export function describeRequestFailure(err: unknown): { error: string; failure: RequestFailure } {
  if (err instanceof StudioApiError) return { error: err.message, failure: classifyFailure(err) };
  return { error: err instanceof Error ? err.message : "Request failed", failure: "transient" };
}

/** The studio socket for one actor, on the page's own host (wss: behind https:). */
export function studioSocketUrl(
  location: Pick<Location, "protocol" | "host">,
  actorType: string,
  actorId: string,
): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/__studio/actors/${encodeURIComponent(actorType)}/${encodeURIComponent(actorId)}/ws`;
}

/**
 * Live connection to one actor's studio WebSocket.
 *
 * - Every frame is parsed at the boundary; malformed frames surface as `error`.
 * - A dropped socket reconnects with backoff; the fresh snapshot replaces the
 *   timeline, so nothing is duplicated.
 * - If the socket cannot open at all, the HTTP API is asked instead: its error
 *   (401, 404, …) becomes the page's error state, or its data is shown
 *   ("polling") while the socket keeps retrying.
 * - Unmounting, or switching actors, closes the socket and cancels retries;
 *   late events from an old socket are ignored.
 */
export function useStudioWs(actorType: string, actorId: string): StudioWsState {
  const [state, dispatch] = useReducer(studioReducer, initialStudioState);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const abort = new AbortController();

    dispatch({ type: "reset" });

    // Callers only schedule while not disposed, and disposal clears the timer.
    const scheduleReconnect = () => {
      const delay = reconnectDelay(attempt);
      attempt++;
      retryTimer = setTimeout(() => {
        connect();
      }, delay);
    };

    /** The socket never opened: ask the HTTP API why (or for the data). */
    const probeHttp = async () => {
      try {
        const [inspect, page] = await Promise.all([
          fetchInspect(actorType, actorId, abort.signal),
          fetchTimeline(actorType, actorId, undefined, abort.signal),
        ]);
        if (disposed) return;
        dispatch({ type: "http-loaded", inspect, timeline: page.entries });
        scheduleReconnect();
      } catch (err) {
        if (disposed) return;
        const { error, failure } = describeRequestFailure(err);
        dispatch({ type: "request-failed", error, failure });
        if (failure !== "permanent") scheduleReconnect();
      }
    };

    const connect = () => {
      const ws = new WebSocket(studioSocketUrl(window.location, actorType, actorId));
      socket = ws;
      let opened = false;
      const isCurrent = () => !disposed && socket === ws;

      ws.onopen = () => {
        if (!isCurrent()) return;
        opened = true;
        attempt = 0;
        dispatch({ type: "socket-open" });
      };

      ws.onmessage = (event: MessageEvent) => {
        if (!isCurrent()) return;
        const parsed = parseStudioFrame(event.data);
        if (parsed.kind === "frame") dispatch({ type: "frame", frame: parsed.frame });
        else if (parsed.kind === "malformed") dispatch({ type: "malformed-frame", error: parsed.error });
      };

      ws.onclose = () => {
        if (!isCurrent()) return;
        socket = null;
        dispatch({ type: "socket-closed" });
        if (opened) scheduleReconnect();
        else void probeHttp();
      };
    };

    connect();

    return () => {
      disposed = true;
      abort.abort();
      clearTimeout(retryTimer); // a no-op when no retry is pending
      if (socket !== null) {
        socket.close(1000, "studio view closed");
        socket = null;
      }
    };
  }, [actorType, actorId]);

  return { ...state, connected: state.status === "live" };
}
