/**
 * Extra browser contexts for app clients and second Studio tabs.
 *
 * The e2e `browser` fixture is one browser showing one tab; these scenarios
 * need several isolated browser contexts at once (separate cookies = separate
 * callers), so they launch their own Playwright Chromium beside it.
 */

import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { z } from "zod";

export interface ClientPool {
  /** A fresh isolated context (its own cookies, so its own chat-room caller). */
  context(): Promise<BrowserContext>;
  close(): Promise<void>;
}

export async function launchClients(): Promise<ClientPool> {
  const browser: Browser = await chromium.launch();
  return {
    context: () => browser.newContext(),
    close: () => browser.close(),
  };
}

const WINDOW_KEY = "__actorKitClientWs";

/**
 * Opens a raw counter-actor WebSocket from inside `page` (tests/e2e-studio
 * worker: `/api/counter/:id?caller=`) and resolves once the first snapshot
 * frame arrives, i.e. the actor has registered the connection.
 */
export async function openCounterSocket(page: Page, baseUrl: string, actorId: string, caller: string): Promise<void> {
  await page.goto(`${baseUrl}/`);
  await page.evaluate(
    async ({ base, id, who, key }) => {
      const url = `${base.replace(/^http/, "ws")}/api/counter/${encodeURIComponent(id)}?caller=${encodeURIComponent(who)}`;
      const ws = new WebSocket(url);
      Reflect.set(window, key, ws);
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("message", () => resolve(), { once: true });
        ws.addEventListener("error", () => reject(new Error("client socket error")), { once: true });
        ws.addEventListener("close", () => reject(new Error("client socket closed before snapshot")), { once: true });
      });
    },
    { base: baseUrl, id: actorId, who: caller, key: WINDOW_KEY },
  );
}

/** Closes the socket opened by openCounterSocket on this page. */
export async function closeCounterSocket(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const ws: unknown = Reflect.get(window, key);
    if (ws instanceof WebSocket) ws.close(1000, "test done");
  }, WINDOW_KEY);
}

const ActorRowSchema = z.object({ actorType: z.string(), actorId: z.string(), connectionCount: z.number() });
const ActorListSchema = z.object({ actors: z.array(ActorRowSchema) });
export type ActorRow = z.infer<typeof ActorRowSchema>;

/** Reads the dashboard's data source (the registry) through the Studio API. */
export async function listActors(baseUrl: string, search: string): Promise<ActorRow[]> {
  const res = await fetch(`${baseUrl}/__studio/api/actors?search=${encodeURIComponent(search)}`);
  if (!res.ok) throw new Error(`listActors: HTTP ${res.status}`);
  return ActorListSchema.parse(await res.json()).actors;
}

const TimelineSchema = z.object({ entries: z.array(z.object({ id: z.number(), causeType: z.string() })) });

/** Timeline ids as the actor persists them (newest first). */
export async function timelineIds(baseUrl: string, actorType: string, actorId: string): Promise<number[]> {
  const res = await fetch(
    `${baseUrl}/__studio/api/actors/${actorType}/${encodeURIComponent(actorId)}/timeline?limit=200`,
  );
  if (!res.ok) throw new Error(`timeline: HTTP ${res.status}`);
  return TimelineSchema.parse(await res.json()).entries.map((e) => e.id);
}

/** Seeds a counter actor by name (spawn + N increments). */
export async function seedCounter(baseUrl: string, actorId: string, count: number): Promise<void> {
  const res = await fetch(`${baseUrl}/seed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actorId, count }),
  });
  if (!res.ok) throw new Error(`seed: HTTP ${res.status}`);
}

/** Sends one INCREMENT as `caller` over RPC. */
export async function sendIncrement(baseUrl: string, actorId: string, caller: string): Promise<void> {
  const res = await fetch(`${baseUrl}/send/${encodeURIComponent(actorId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ caller }),
  });
  if (!res.ok) throw new Error(`send: HTTP ${res.status}`);
}

/** The timeline entry test ids a Studio page renders, top (newest) first. */
export async function renderedTimelineIds(page: Page): Promise<string[]> {
  return page
    .locator("[data-testid^='timeline-entry-']")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid") ?? ""));
}

let seq = 0;
export function uniqueId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}-${Math.random().toString(36).slice(2, 6)}`;
}
