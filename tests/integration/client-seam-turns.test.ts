/**
 * Seam tests for the moments OGS games live in (ADR-020): an iPad suspended while a turn timer runs,
 * and two tabs (or a phone and an iPad) of the same player. The real client against a real actor in
 * workerd; every view a screen showed is recorded, and none may go back to an older one.
 */

import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { createActorClient } from "@actor-kit/client";
import { array, schema, string, uint32 } from "@actor-kit/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eventually, fakeDocument, type SeamNetwork, seamNetwork } from "./client-seam-socket";

const QuizView = schema({ round: uint32, fired: uint32 });
type Quiz = { round: number; fired: number };
const CounterView = schema({ count: uint32, lastCaller: string });
type Counter = { count: number; lastCaller: string };
const ChatView = schema({ messages: array(schema({ id: string, author: string, text: string })), onlineCount: uint32 });

const open: Array<{ disconnect(): void }> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const client of open.splice(0)) client.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 100));
});

let n = 0;
const uniqueName = (prefix: string) => `${prefix}-${Date.now()}-${++n}`;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fast = { intervalMs: 100, timeoutMs: 150 };

async function spawn(ns: "QUIZ" | "COUNTER" | "CHAT_ROOM_REAPING", prefix: string) {
  const actorId = uniqueName(prefix);
  const stub = env[ns].get(env[ns].idFromName(actorId));
  await stub.spawn({ actorId, caller: "host", callerType: "service", input: {} });
  return { actorId, stub };
}

function screenOn<TView>(
  path: string,
  viewSchema: Parameters<typeof createActorClient>[0]["viewSchema"],
  initialView: TView,
  caller: string,
  net: SeamNetwork,
  heartbeat: { intervalMs: number; timeoutMs: number } = fast,
) {
  const client = createActorClient<TView>({
    path,
    host: "localhost",
    initialView,
    viewSchema,
    getToken: () => caller,
    WebSocketImpl: net.WebSocketImpl,
    heartbeat,
  });
  const shown: TView[] = [];
  client.subscribe((view) => shown.push(view));
  open.push(client);
  client.connect();
  return { client, shown };
}

/** No field of the views shown went back to a smaller number. */
function expectMonotonic<TView extends Record<string, unknown>>(
  shown: readonly TView[],
  fields: readonly (keyof TView)[],
) {
  const rewinds = shown.flatMap((view, i) =>
    i === 0
      ? []
      : fields.flatMap((field) => {
          const before = shown[i - 1]?.[field];
          const now = view[field];
          return typeof before === "number" && typeof now === "number" && now < before
            ? [`${String(field)} ${before}→${now}`]
            : [];
        }),
  );
  expect(rewinds).toEqual([]);
}

/** The quiz's turn timer fires now: its deadline is pulled into the past and the alarm runs. */
async function fireTurnTimer(stub: DurableObjectStub): Promise<void> {
  await runInDurableObject(stub, async (_i, state) => {
    state.storage.sql.exec("UPDATE timers SET fire_at = fire_at - 3600000");
    await state.storage.setAlarm(Date.now());
  });
  await runDurableObjectAlarm(stub);
}

async function startRound(stub: DurableObjectStub): Promise<void> {
  const sent: unknown = await stub.send("host", "service", { type: "START", inMs: 60_000 });
  expect(sent).toMatchObject({ ok: true });
}

describe("an iPad suspended while a turn timer runs", () => {
  it("the turn ends while it sleeps; on wake it shows the result and the next round, never an older turn", async () => {
    const page = fakeDocument();
    vi.stubGlobal("document", page.doc);
    const { actorId, stub } = await spawn("QUIZ", "turn-sleep");
    const net = seamNetwork(stub);
    const ipad = screenOn<Quiz>(`/api/quiz/${actorId}`, QuizView, { round: 0, fired: 0 }, "kid", net, {
      intervalMs: 60_000,
      timeoutMs: 150,
    });
    await startRound(stub);
    await eventually(() => expect(ipad.client.view).toEqual({ round: 1, fired: 0 }));

    page.hide();
    net.latest().goZombie();
    await fireTurnTimer(stub);
    await startRound(stub);
    expect(ipad.client.view).toEqual({ round: 1, fired: 0 }); // asleep: nothing arrived

    page.show();
    await eventually(() => expect(ipad.client.view).toEqual({ round: 2, fired: 1 }), 2000);
    expect(net.sockets).toHaveLength(2);
    expectMonotonic(ipad.shown, ["round", "fired"]);
  });

  it("the actor hibernated too and the timer woke it: the iPad still catches up on wake", async () => {
    const page = fakeDocument();
    vi.stubGlobal("document", page.doc);
    const { actorId, stub } = await spawn("QUIZ", "turn-hibernate");
    const net = seamNetwork(stub);
    const ipad = screenOn<Quiz>(`/api/quiz/${actorId}`, QuizView, { round: 0, fired: 0 }, "kid", net, {
      intervalMs: 60_000,
      timeoutMs: 150,
    });
    await startRound(stub);
    await eventually(() => expect(ipad.client.view.round).toBe(1));

    page.hide();
    net.latest().goZombie();
    await evictDurableObject(stub);
    await fireTurnTimer(stub);

    page.show();
    await eventually(() => expect(ipad.client.view).toEqual({ round: 1, fired: 1 }), 2000);
    expectMonotonic(ipad.shown, ["round", "fired"]);
  });

  it("woken before the timer: the new socket gets the turn's end live, once", async () => {
    const page = fakeDocument();
    vi.stubGlobal("document", page.doc);
    const { actorId, stub } = await spawn("QUIZ", "turn-early-wake");
    const net = seamNetwork(stub);
    const ipad = screenOn<Quiz>(`/api/quiz/${actorId}`, QuizView, { round: 0, fired: 0 }, "kid", net, {
      intervalMs: 60_000,
      timeoutMs: 150,
    });
    await startRound(stub);
    await eventually(() => expect(ipad.client.view.round).toBe(1));

    page.hide();
    net.latest().goZombie();
    await pause(50);
    page.show();
    await eventually(() => expect(net.sockets).toHaveLength(2), 2000);
    await eventually(() => expect(ipad.client.connectionState).toBe("connected"));

    await fireTurnTimer(stub);
    await eventually(() => expect(ipad.client.view).toEqual({ round: 1, fired: 1 }));
    await pause(100);
    expect(ipad.shown.filter((v) => v.fired === 1)).toHaveLength(1);
    expectMonotonic(ipad.shown, ["round", "fired"]);
  });

  it("a phone that stays awake follows the same turn without a reconnect", async () => {
    const { actorId, stub } = await spawn("QUIZ", "turn-awake");
    const net = seamNetwork(stub);
    const phone = screenOn<Quiz>(`/api/quiz/${actorId}`, QuizView, { round: 0, fired: 0 }, "grown-up", net);
    await startRound(stub);
    await eventually(() => expect(phone.client.view.round).toBe(1));
    await pause(300); // a few heartbeats

    await fireTurnTimer(stub);
    await eventually(() => expect(phone.client.view).toEqual({ round: 1, fired: 1 }));
    expect(net.sockets).toHaveLength(1);
    expectMonotonic(phone.shown, ["round", "fired"]);
  });
});

describe("two tabs of the same player", () => {
  it("both send at once: every move lands once and both tabs end on the same view", async () => {
    const { actorId, stub } = await spawn("COUNTER", "tabs-race");
    const path = `/api/counter/${actorId}`;
    const a = screenOn<Counter>(path, CounterView, { count: 0, lastCaller: "" }, "ana", seamNetwork(stub));
    const b = screenOn<Counter>(path, CounterView, { count: 0, lastCaller: "" }, "ana", seamNetwork(stub));
    await eventually(() => expect(b.client.connectionState).toBe("connected"));
    await eventually(() => expect(a.client.connectionState).toBe("connected"));

    for (let i = 0; i < 10; i++) {
      a.client.send({ type: "INCREMENT", amount: 1 });
      b.client.send({ type: "INCREMENT", amount: 2 });
    }

    await eventually(() => expect(a.client.view).toEqual({ count: 30, lastCaller: "ana" }));
    await eventually(() => expect(b.client.view).toEqual({ count: 30, lastCaller: "ana" }));
    expectMonotonic(a.shown, ["count"]);
    expectMonotonic(b.shown, ["count"]);
  });

  it("closing one tab keeps the player online and the other tab live", async () => {
    const { actorId, stub } = await spawn("CHAT_ROOM_REAPING", "tabs-close");
    const path = `/api/chat-room-reaping/${actorId}`;
    const empty = { messages: [], onlineCount: 0 };
    const tv = screenOn(path, ChatView, empty, "tv", seamNetwork(stub));
    const tab1 = screenOn(path, ChatView, empty, "ana", seamNetwork(stub));
    const tab2 = screenOn(path, ChatView, empty, "ana", seamNetwork(stub));
    await eventually(() => expect(tv.client.view.onlineCount).toBe(2));
    await eventually(() => expect(tab2.client.connectionState).toBe("connected"));

    tab1.client.disconnect();
    await pause(200);
    expect(tv.client.view.onlineCount).toBe(2);
    tab2.client.send({ type: "SEND_MESSAGE", text: "still here" });

    await eventually(() => expect(tv.client.view.messages.map((m) => m.text)).toEqual(["still here"]));
    await eventually(() => expect(tab2.client.view.messages).toHaveLength(1));
    expect(tv.client.view.onlineCount).toBe(2);
  });

  it("one tab sleeps while the other plays: on wake it catches up, and the player is online once throughout", async () => {
    const page = fakeDocument();
    vi.stubGlobal("document", page.doc);
    const { actorId, stub } = await spawn("CHAT_ROOM_REAPING", "tabs-sleep");
    const path = `/api/chat-room-reaping/${actorId}`;
    const empty = { messages: [], onlineCount: 0 };
    const tv = screenOn(path, ChatView, empty, "tv", seamNetwork(stub));
    const ipadNet = seamNetwork(stub);
    const ipad = screenOn(path, ChatView, empty, "ana", ipadNet, { intervalMs: 60_000, timeoutMs: 150 });
    const phone = screenOn(path, ChatView, empty, "ana", seamNetwork(stub));
    await eventually(() => expect(tv.client.view.onlineCount).toBe(2));
    await eventually(() => expect(phone.client.connectionState).toBe("connected"));

    page.hide();
    ipadNet.latest().goZombie();
    phone.client.send({ type: "SEND_MESSAGE", text: "from the phone" });
    await eventually(() => expect(tv.client.view.messages).toHaveLength(1));
    expect(ipad.client.view.messages).toHaveLength(0);

    page.show();
    await eventually(() => expect(ipad.client.view.messages.map((m) => m.text)).toEqual(["from the phone"]), 2000);
    expect(tv.client.view.onlineCount).toBe(2);
    expect(tv.shown.every((v) => v.onlineCount <= 2)).toBe(true);
  });

  it("both tabs drop and come back: one player, both views current", async () => {
    const { actorId, stub } = await spawn("COUNTER", "tabs-both-drop");
    const path = `/api/counter/${actorId}`;
    const netA = seamNetwork(stub);
    const netB = seamNetwork(stub);
    const a = screenOn<Counter>(path, CounterView, { count: 0, lastCaller: "" }, "ana", netA);
    const b = screenOn<Counter>(path, CounterView, { count: 0, lastCaller: "" }, "ana", netB);
    await eventually(() => expect(b.client.connectionState).toBe("connected"));

    netA.latest().drop();
    netB.latest().drop();
    const sent: unknown = await stub.send("bot", "user", { type: "INCREMENT", amount: 5 });
    expect(sent).toMatchObject({ ok: true });

    await eventually(() => expect(a.client.view.count).toBe(5));
    await eventually(() => expect(b.client.view.count).toBe(5));
    expectMonotonic(a.shown, ["count"]);
    expectMonotonic(b.shown, ["count"]);
  });
});
