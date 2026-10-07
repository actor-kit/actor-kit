import { useEffect, useRef, useState } from "react";
import type { InspectResult, TimelineEntry } from "../api";

export interface StudioConnection {
  /** Unique per app socket: two tabs of one caller are two connections. */
  connectionId: string;
  caller: string;
  callerType: "user" | "service";
  connectedAt: number;
  role: string | null;
}

interface StudioSnapshot {
  type: "studio.snapshot";
  state: unknown;
  timeline: TimelineEntry[];
  connections: StudioConnection[];
  outbox: Array<{
    id: string;
    service: string;
    payload: string;
    status: string;
    attempts: number;
    createdAt: number;
  }>;
  activeLinks: Array<{ targetType: string; targetId: string; linkName: string; version: number }>;
  linkSubscribers: Array<{ subscriberType: string; subscriberId: string }>;
  actorType: string;
  actorId: string;
  version: number;
}

interface StudioTimelineMsg {
  type: "studio.timeline";
  entry: TimelineEntry;
}

interface StudioConnectionMsg {
  type: "studio.connection";
  action: "connect" | "disconnect";
  connection: StudioConnection;
}

type StudioMessage = StudioSnapshot | StudioTimelineMsg | StudioConnectionMsg;

export interface StudioWsState {
  inspect: InspectResult | null;
  timeline: TimelineEntry[];
  connected: boolean;
}

/**
 * Connect to an actor's studio WebSocket for live updates.
 * Falls back to HTTP polling if WebSocket fails.
 */
export function useStudioWs(actorType: string, actorId: string): StudioWsState {
  const [inspect, setInspect] = useState<InspectResult | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/__studio/actors/${actorType}/${encodeURIComponent(actorId)}/ws`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as StudioMessage;

        if (msg.type === "studio.snapshot") {
          setInspect({
            state: msg.state,
            version: msg.version,
            actorId: msg.actorId,
            connections: msg.connections,
            outbox: msg.outbox,
            activeLinks: msg.activeLinks,
            linkSubscribers: msg.linkSubscribers,
          });
          setTimeline(msg.timeline);
        }

        if (msg.type === "studio.timeline") {
          setTimeline((prev) => [msg.entry, ...prev]);
          // Update state from the latest timeline entry
          if (msg.entry.stateSnapshot) {
            setInspect((prev) => {
              if (!prev) return prev;
              return { ...prev, state: JSON.parse(msg.entry.stateSnapshot) };
            });
          }
        }

        if (msg.type === "studio.connection") {
          setInspect((prev) => {
            if (!prev) return prev;
            if (msg.action === "connect") {
              return {
                ...prev,
                connections: [...prev.connections, msg.connection],
              };
            }
            return {
              ...prev,
              // Remove only the socket that closed, not every socket of that caller.
              connections: prev.connections.filter((c) => c.connectionId !== msg.connection.connectionId),
            };
          });
        }
      } catch {
        // Invalid message — ignore
      }
    };

    ws.onclose = () => {
      setConnected(false);
    };

    ws.onerror = () => {
      setConnected(false);
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [actorType, actorId]);

  return { inspect, timeline, connected };
}
