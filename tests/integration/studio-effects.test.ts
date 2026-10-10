/**
 * Studio live data for side effects at the Durable Object seam: a studio
 * socket sees outbox executions (pending → done / failed) and links
 * (active links on the source, subscribers on the target) change without
 * reconnecting. Also covers link delivery between two real actors.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// --- Boundary schemas ---

const OutboxEntrySchema = z.object({
  id: z.string(),
  service: z.string(),
  payload: z.string(),
  status: z.string(),
  attempts: z.number(),
  createdAt: z.number(),
});
const ActiveLinkSchema = z.object({
  targetType: z.string(),
  targetId: z.string(),
  linkName: z.string(),
  version: z.number(),
});
const LinkSubscriberSchema = z.object({ subscriberType: z.string(), subscriberId: z.string() });

const OutboxFrameSchema = z.object({ type: z.literal("studio.outbox"), outbox: z.array(OutboxEntrySchema) });
const LinksFrameSchema = z.object({
  type: z.literal("studio.links"),
  activeLinks: z.array(ActiveLinkSchema),
  linkSubscribers: z.array(LinkSubscriberSchema),
});
const FrameEnvelopeSchema = z.looseObject({ type: z.string() });
type Frame = z.infer<typeof FrameEnvelopeSchema>;

const InspectSchema = z.object({
  state: z.unknown(),
  outbox: z.array(OutboxEntrySchema),
  activeLinks: z.array(ActiveLinkSchema),
  linkSubscribers: z.array(LinkSubscriberSchema),
});
const DeskStateSchema = z.object({ headline: z.string(), result: z.string() });

// --- Helpers ---

let seq = 0;
function uniqueName(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

async function spawnDesk(name: string) {
  const stub = env.DESK.get(env.DESK.idFromName(name));
  await stub.spawn({ actorId: name, caller: "svc", callerType: "service", input: {} });
  return stub;
}

async function spawnBulletin(name: string, headline: string) {
  const stub = env.BULLETIN.get(env.BULLETIN.idFromName(name));
  await stub.spawn({ actorId: name, caller: "svc", callerType: "service", input: { headline } });
  return stub;
}

async function inspect(stub: { __inspect(): Promise<unknown> }) {
  return InspectSchema.parse(await stub.__inspect());
}

async function send(stub: { send(c: string, t: string, m: unknown): Promise<unknown> }, message: unknown) {
  expect(await stub.send("clerk-1", "user", message)).toEqual({ ok: true });
}

class Inbox {
  readonly frames: Frame[] = [];
  private waiters: Array<() => void> = [];
  constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") this.frames.push(FrameEnvelopeSchema.parse(JSON.parse(event.data)));
      for (const w of this.waiters) w();
    });
  }

  async next<T>(schema: z.ZodType<T>, predicate: (frame: T) => boolean = () => true, timeout = 3000): Promise<T> {
    const deadline = Date.now() + timeout;
    for (;;) {
      for (const frame of this.frames) {
        const parsed = schema.safeParse(frame);
        if (parsed.success && predicate(parsed.data)) return parsed.data;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timeout waiting for frame; got ${JSON.stringify(this.frames)}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

async function connectStudio(stub: { fetch(input: string, init?: RequestInit): Promise<Response> }) {
  const res = await stub.fetch("http://localhost/ws", {
    headers: { Upgrade: "websocket", "X-Actor-Kit-Caller-Id": "__studio", "X-Actor-Kit-Caller-Type": "service" },
  });
  const ws = res.webSocket;
  if (ws === null) throw new Error(`studio upgrade failed: ${res.status}`);
  ws.accept();
  const inbox = new Inbox(ws);
  await inbox.next(z.object({ type: z.literal("studio.snapshot") }));
  return inbox;
}

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeout = 3000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
}

const statusOf = (status: string) => (frame: z.infer<typeof OutboxFrameSchema>) =>
  frame.outbox.length === 1 && frame.outbox[0]?.status === status;

// --- Outbox ---

describe("studio outbox frames", () => {
  it("pushes the execution as pending, then done", async () => {
    const desk = await spawnDesk(uniqueName("desk-ok"));
    const studio = await connectStudio(desk);

    await send(desk, { type: "RUN", tag: "a", delayMs: 300, fail: false });

    const pending = await studio.next(OutboxFrameSchema, statusOf("pending"));
    expect(pending.outbox[0]?.service).toBe("JOB");
    expect(JSON.parse(pending.outbox[0]?.payload ?? "null")).toEqual({ tag: "a", delayMs: 300, fail: false });
    await studio.next(OutboxFrameSchema, statusOf("done"));
    expect(DeskStateSchema.parse((await inspect(desk)).state).result).toBe("done:a");
  });

  it("pushes a failing execution as pending, then failed", async () => {
    const desk = await spawnDesk(uniqueName("desk-fail"));
    const studio = await connectStudio(desk);

    await send(desk, { type: "RUN", tag: "b", delayMs: 300, fail: true });

    await studio.next(OutboxFrameSchema, statusOf("pending"));
    await studio.next(OutboxFrameSchema, statusOf("failed"));
    expect(DeskStateSchema.parse((await inspect(desk)).state).result).toBe("error:job b failed");
  });

  it("lists executions newest first", async () => {
    const desk = await spawnDesk(uniqueName("desk-order"));
    for (const tag of ["first", "second", "third"]) {
      await send(desk, { type: "RUN", tag, delayMs: 0, fail: false });
      await new Promise((r) => setTimeout(r, 5));
    }
    const { outbox } = await waitFor(
      () => inspect(desk),
      (r) => r.outbox.every((e) => e.status === "done"),
    );
    expect(outbox.map((e) => z.object({ tag: z.string() }).parse(JSON.parse(e.payload)).tag)).toEqual([
      "third",
      "second",
      "first",
    ]);
  });

  it("sends no outbox frame for a message without executions", async () => {
    const desk = await spawnDesk(uniqueName("desk-quiet"));
    const bulletinName = uniqueName("bulletin-quiet");
    await spawnBulletin(bulletinName, "Quiet");
    const studio = await connectStudio(desk);

    await send(desk, { type: "FOLLOW", id: bulletinName });
    await studio.next(LinksFrameSchema);

    expect(studio.frames.some((f) => f.type === "studio.outbox")).toBe(false);
  });
});

// --- Links ---

describe("links between real actors", () => {
  it("delivers the target's view to the source", async () => {
    const bulletinName = uniqueName("bulletin");
    const bulletin = await spawnBulletin(bulletinName, "Hello");
    const desk = await spawnDesk(uniqueName("desk-link"));

    await send(desk, { type: "FOLLOW", id: bulletinName });
    await waitFor(
      async () => DeskStateSchema.parse((await inspect(desk)).state).headline,
      (h) => h === "Hello",
    );
    expect(DeskStateSchema.parse((await inspect(desk)).state).headline).toBe("Hello");

    await send(bulletin, { type: "EDIT", headline: "Updated" });
    const headline = await waitFor(
      async () => DeskStateSchema.parse((await inspect(desk)).state).headline,
      (h) => h === "Updated",
    );
    expect(headline).toBe("Updated");
  });

  it("registers the subscriber under its actor ID", async () => {
    const bulletinName = uniqueName("bulletin-sub");
    const bulletin = await spawnBulletin(bulletinName, "Sub");
    const deskName = uniqueName("desk-sub");
    const desk = await spawnDesk(deskName);

    await send(desk, { type: "FOLLOW", id: bulletinName });
    const { linkSubscribers } = await waitFor(
      () => inspect(bulletin),
      (r) => r.linkSubscribers.length > 0,
    );
    expect(linkSubscribers).toEqual([{ subscriberType: "desk", subscriberId: deskName }]);
  });
});

describe("studio links frames", () => {
  it("pushes active links to the source's studio on link and unlink", async () => {
    const bulletinName = uniqueName("bulletin-src");
    await spawnBulletin(bulletinName, "Src");
    const desk = await spawnDesk(uniqueName("desk-src"));
    const studio = await connectStudio(desk);

    await send(desk, { type: "FOLLOW", id: bulletinName });
    const linked = await studio.next(LinksFrameSchema, (f) => f.activeLinks.length === 1);
    expect(linked.activeLinks[0]).toMatchObject({
      targetType: "bulletin",
      targetId: bulletinName,
      linkName: "bulletin",
    });

    // The first view delivery bumps the link version.
    await studio.next(LinksFrameSchema, (f) => (f.activeLinks[0]?.version ?? 0) > 0);

    await send(desk, { type: "UNFOLLOW", id: bulletinName });
    await studio.next(LinksFrameSchema, (f) => f.activeLinks.length === 0);
  });

  it("pushes subscribers to the target's studio on link and unlink", async () => {
    const bulletinName = uniqueName("bulletin-tgt");
    const bulletin = await spawnBulletin(bulletinName, "Tgt");
    const deskName = uniqueName("desk-tgt");
    const desk = await spawnDesk(deskName);
    const studio = await connectStudio(bulletin);

    await send(desk, { type: "FOLLOW", id: bulletinName });
    const subscribed = await studio.next(LinksFrameSchema, (f) => f.linkSubscribers.length === 1);
    expect(subscribed.linkSubscribers).toEqual([{ subscriberType: "desk", subscriberId: deskName }]);

    await send(desk, { type: "UNFOLLOW", id: bulletinName });
    await studio.next(LinksFrameSchema, (f) => f.linkSubscribers.length === 0);
  });
});
