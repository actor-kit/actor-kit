/**
 * Link delivery is exactly once per source transition. A link push carries the source's seq (the
 * transition that made the view), so a source that wakes (its in-memory dedupe gone) and pushes a
 * view its subscriber already has is dropped by the subscriber's monotonic version check, and is
 * never run or journaled again. Real changes still deliver. Both with the journal and with
 * `journal: false` (the snapshot's transition counter numbers the seq, ADR-015 D1).
 */

import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { readJournal } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const ReaderStateSchema = z.object({ text: z.string(), updates: z.number() });
const ActiveLinkSchema = z.object({
  targetType: z.string(),
  targetId: z.string(),
  linkName: z.string(),
  version: z.number(),
});
const LinkSubscriberSchema = z.object({ subscriberType: z.string(), subscriberId: z.string() });
const InspectSchema = z.object({
  state: z.unknown(),
  activeLinks: z.array(ActiveLinkSchema),
  linkSubscribers: z.array(LinkSubscriberSchema),
});
const SubscribedAtSchema = z.object({ subscribed_at: z.number() });
const LinkedViewSchema = z.object({ view: z.object({ text: z.string() }) });

let n = 0;
const uniqueName = (prefix: string) => `${prefix}-${Date.now()}-${++n}`;

type Stub = DurableObjectStub & {
  spawn(input: unknown): Promise<void>;
  send(caller: string, callerType: string, message: unknown): Promise<unknown>;
  __inspect(): Promise<unknown>;
};

async function inspect(stub: Stub) {
  return InspectSchema.parse(await stub.__inspect());
}

async function readerState(stub: Stub) {
  return ReaderStateSchema.parse((await inspect(stub)).state);
}

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeout = 3000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** When the source last (re)registered this subscriber: a re-subscribe pushes the current view. */
function subscribedAt(source: Stub): Promise<number> {
  return runInDurableObject(source, (_i, state) => {
    const [row] = state.storage.sql.exec("SELECT subscribed_at FROM link_subscribers").toArray();
    return row === undefined ? 0 : SubscribedAtSchema.parse(row).subscribed_at;
  });
}

/** The reader's link.onUpdate journal events: the texts it was given and what caused each. */
function linkUpdates(reader: Stub) {
  return runInDurableObject(reader, (_i, state) =>
    readJournal(state.storage.sql)
      .events.filter((e) => e.causeType === "link.onUpdate")
      .map((e) => ({ text: LinkedViewSchema.parse(e.payload).view.text, causationId: e.causationId })),
  );
}

const sources = [
  { via: "notice", type: "notice", binding: () => env.NOTICE },
  { via: "quiet", type: "notice-no-journal", binding: () => env.NOTICE_NO_JOURNAL },
] as const;

describe.each(sources)("link pushes from $type", ({ via, type, binding }) => {
  async function setUp() {
    const noticeName = uniqueName(type);
    const ns = binding();
    const notice: Stub = ns.get(ns.idFromName(noticeName));
    await notice.spawn({ actorId: noticeName, caller: "svc", callerType: "service", input: { text: "first" } });
    const readerName = uniqueName("reader");
    const reader: Stub = env.READER.get(env.READER.idFromName(readerName));
    await reader.spawn({ actorId: readerName, caller: "svc", callerType: "service", input: {} });
    expect(await reader.send("u", "user", { type: "FOLLOW", via, id: noticeName })).toEqual({ ok: true });
    await waitFor(
      () => readerState(reader),
      (s) => s.updates === 1,
    );
    return { notice, noticeName, reader, readerName };
  }

  async function edit(notice: Stub, text: string) {
    expect(await notice.send("u", "user", { type: "EDIT", text })).toEqual({ ok: true });
  }

  it("delivers each source change once, even when the source wakes and pushes its view again", async () => {
    const { notice, noticeName, reader } = await setUp();
    await edit(notice, "second");
    await waitFor(
      () => readerState(reader),
      (s) => s.text === "second",
    );

    // Both actors are evicted (hibernation / new instances). The reader wakes, re-subscribes, and
    // the source (its dedupe memory gone) pushes the view the reader already has.
    const before = await subscribedAt(notice);
    await evictDurableObject(notice);
    await evictDurableObject(reader);
    await reader.__inspect();
    await waitFor(
      () => subscribedAt(notice),
      (at) => at > before,
    );
    // A re-push that were applied would show up here as a third update.
    const settled = await waitFor(
      () => readerState(reader),
      (s) => s.updates !== 2,
      500,
    );
    expect(settled).toEqual({ text: "second", updates: 2 });

    // A real change still delivers.
    await edit(notice, "third");
    expect(
      await waitFor(
        () => readerState(reader),
        (s) => s.text === "third",
      ),
    ).toEqual({ text: "third", updates: 3 });

    // Exactly one link.onUpdate per source transition, each caused by that transition.
    expect(await linkUpdates(reader)).toEqual([
      { text: "first", causationId: `${type}/${noticeName}/1` },
      { text: "second", causationId: `${type}/${noticeName}/2` },
      { text: "third", causationId: `${type}/${noticeName}/3` },
    ]);
  });

  it("stores the source's seq as the link version", async () => {
    const { notice, reader } = await setUp();
    await edit(notice, "second");
    const { activeLinks } = await waitFor(
      () => inspect(reader),
      (r) => r.activeLinks[0]?.version === 2,
    );
    expect(activeLinks.map((l) => l.version)).toEqual([2]);
  });

  it("names both ends of the link by actor type, as Studio and event ids do", async () => {
    const { notice, noticeName, reader, readerName } = await setUp();
    expect((await inspect(reader)).activeLinks).toEqual([
      { targetType: type, targetId: noticeName, linkName: via, version: 1 },
    ]);
    expect((await inspect(notice)).linkSubscribers).toEqual([{ subscriberType: "reader", subscriberId: readerName }]);
  });
});
