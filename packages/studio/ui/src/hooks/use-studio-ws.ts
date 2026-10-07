import { useEffect, useReducer } from "react";
import { StudioApiError, fetchInspect, fetchTimeline } from "../api";
import type { InspectResult, TimelineItem } from "../protocol";
import { parseStudioFrame } from "../protocol";
import { type RequestFailure, type StudioStatus, initialStudioState, studioReducer } from "../studio-state";

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

function classifyFailure(err: unknown): RequestFailure {
  if (!(err instanceof StudioApiError)) return "transient";
  if (err.permanent) return "permanent";
  if (err.kind === "not-found") return "not-found";
  return "transient";
}

function studioSocketUrl(actorType: string, actorId: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/__studio/actors/${encodeURIComponent(actorType)}/${encodeURIComponent(actorId)}/ws`;
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
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    const abort = new AbortController();

    dispatch({ type: "reset" });

    const scheduleReconnect = () => {
      if (disposed) return;
      const delay = reconnectDelay(attempt);
      attempt++;
      retryTimer = setTimeout(() => {
        retryTimer = null;
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
        const failure = classifyFailure(err);
        const message = err instanceof Error ? err.message : "Request failed";
        dispatch({ type: "request-failed", error: message, failure });
        if (failure !== "permanent") scheduleReconnect();
      }
    };

    const connect = () => {
      if (disposed) return;
      const ws = new WebSocket(studioSocketUrl(actorType, actorId));
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
      if (retryTimer !== null) clearTimeout(retryTimer);
      if (socket !== null) {
        socket.close(1000, "studio view closed");
        socket = null;
      }
    };
  }, [actorType, actorId]);

  return { ...state, connected: state.status === "live" };
}
