/**
 * Shared fakes for Studio UI page tests: a scriptable WebSocket, a routed
 * fetch, and a router mounted on memory history at a given path.
 */
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { createElement } from "react";
import { vi } from "vitest";
import { routeTree } from "../../packages/studio/ui/src/route-tree";

export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readyState = 0;
  closeCalls = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.closeCalls++;
    this.readyState = 3;
  }

  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  serverSend(data: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: typeof data === "string" ? data : JSON.stringify(data) }));
  }
  serverDrop(): void {
    this.readyState = 3;
    this.onerror?.(new Event("error"));
    this.onclose?.(new CloseEvent("close", { code: 1006 }));
  }

  static latest(): FakeWebSocket {
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (ws === undefined) throw new Error("no socket created");
    return ws;
  }
}

export type FetchRoute = (url: URL) => Response | Promise<Response>;

/** Every fetch the page makes, as parsed URLs (for asserting query params). */
export const fetchCalls: URL[] = [];
/** The init (headers etc.) of every fetch, in the same order as fetchCalls. */
export const fetchInits: Array<RequestInit | undefined> = [];

export function installFakes(route: FetchRoute): void {
  FakeWebSocket.instances = [];
  fetchCalls.length = 0;
  fetchInits.length = 0;
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("fetch", (input: string, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    fetchCalls.push(url);
    fetchInits.push(init);
    return Promise.resolve().then(() => route(url));
  });
}

export function renderAt(path: string) {
  const router = createRouter({
    routeTree,
    basepath: "/__studio",
    history: createMemoryHistory({ initialEntries: [`/__studio${path}`] }),
  });
  const view = render(createElement(RouterProvider, { router }));
  return { router, ...view };
}

export function timelineEntry(
  id: number,
  state: unknown,
  causeType = "message",
  cause: Record<string, unknown> = { caller: "u1", messageType: "INCREMENT" },
) {
  return {
    id,
    causeType,
    causeData: JSON.stringify(cause),
    stateSnapshot: JSON.stringify(state),
    checksum: "c",
    createdAt: Date.now(),
  };
}

export function snapshotFrame(state: unknown, timeline: ReturnType<typeof timelineEntry>[]) {
  return {
    type: "studio.snapshot",
    state,
    timeline,
    connections: [],
    outbox: [],
    activeLinks: [],
    linkSubscribers: [],
    actorType: "counter",
    actorId: "a1",
    version: 1,
  };
}
