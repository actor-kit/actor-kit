/**
 * The real client against a real actor (ADR-020): what a phone, a tablet or a TV sees through
 * drops, restarts, hibernation and a suspended page. The invariant every test checks is the one
 * games broke on: a client's view never goes back to an older state ("the phone rewinds"), and
 * once the network is back it shows the actor's current view.
 */

import { env, evictDurableObject } from "cloudflare:test";
import { createActorClient } from "@actor-kit/client";
import { schema, string, uint32 } from "@actor-kit/core";
import { afterEach, describe, expect, it } from "vitest";
import { eventually, type SeamNetwork, seamNetwork } from "./client-seam-socket";

const CounterView = schema({ count: uint32, lastCaller: string });
type View = { count: number; lastCaller: string };

const open: Array<{ disconnect(): void }> = [];
afterEach(async () => {
  for (const client of open.splice(0)) client.disconnect();
  // Let the actor run webSocketClose for the sockets just closed before the runtime is torn down.
  await new Promise((resolve) => setTimeout(resolve, 100));
});

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function spawnCounter(prefix: string) {
  const actorId = uniqueName(prefix);
  const stub = env.COUNTER.get(env.COUNTER.idFromName(actorId));
  await stub.spawn({ actorId, caller: "host", callerType: "user", input: {} });
  return { actorId, stub };
}

/** Another player's move, through RPC (not this client's socket). */
async function increment(stub: DurableObjectStub, amount = 1): Promise<void> {
  const result: unknown = await stub.send("bot", "user", { type: "INCREMENT", amount });
  expect(result).toMatchObject({ ok: true });
}

/** A phone: the real client, every view it showed, and the network it is on. */
function phone(actorId: string, net: SeamNetwork, caller = "phone") {
  const client = createActorClient({
    path: `/api/counter/${actorId}`,
    host: "localhost",
    initialView: { count: 0, lastCaller: "" },
    viewSchema: CounterView,
    getToken: () => caller,
    WebSocketImpl: net.WebSocketImpl,
  });
  const shown: number[] = [];
  client.subscribe((view: View) => shown.push(view.count));
  open.push(client);
  client.connect();
  return { client, shown };
}

/** The view never went back to an older count. */
function expectNoRewind(shown: readonly number[]): void {
  const rewinds = shown.flatMap((count, i) =>
    i > 0 && count < (shown[i - 1] ?? 0) ? [`${shown[i - 1]}→${count}`] : [],
  );
  expect(rewinds).toEqual([]);
}

describe("client ↔ actor seam: live updates", () => {
  it("follows every change in order, binary from the first frame", async () => {
    const { actorId, stub } = await spawnCounter("seam-live");
    const net = seamNetwork(stub);
    const { client, shown } = phone(actorId, net);
    await eventually(() => expect(client.connectionState).toBe("connected"));

    for (let i = 0; i < 5; i++) await increment(stub);

    await eventually(() => expect(client.view).toEqual({ count: 5, lastCaller: "bot" }));
    expect(shown).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("its own messages reach the actor and come back as views", async () => {
    const { actorId, stub } = await spawnCounter("seam-own");
    const net = seamNetwork(stub);
    const { client, shown } = phone(actorId, net);
    await eventually(() => expect(client.connectionState).toBe("connected"));

    client.send({ type: "INCREMENT", amount: 2 });
    client.send({ type: "INCREMENT", amount: 3 });

    await eventually(() => expect(client.view).toEqual({ count: 5, lastCaller: "phone" }));
    expectNoRewind(shown);
  });
});

describe("client ↔ actor seam: drops and restarts", () => {
  it("a dropped connection catches up on what changed while away, without rewinding", async () => {
    const { actorId, stub } = await spawnCounter("seam-drop");
    const net = seamNetwork(stub);
    const { client, shown } = phone(actorId, net);
    await eventually(() => expect(client.connectionState).toBe("connected"));
    await increment(stub);
    await eventually(() => expect(client.view.count).toBe(1));

    net.latest().drop();
    expect(client.connectionState).toBe("reconnecting");
    await increment(stub);
    await increment(stub);

    await eventually(() => expect(client.view.count).toBe(3));
    expect(client.connectionState).toBe("connected");
    expect(net.sockets).toHaveLength(2);
    expectNoRewind(shown);
  });

  it("a reconnect when nothing changed shows the same view and asks the actor by checksum", async () => {
    const { actorId, stub } = await spawnCounter("seam-same");
    const net = seamNetwork(stub);
    const { client, shown } = phone(actorId, net);
    await increment(stub, 4);
    await eventually(() => expect(client.view.count).toBe(4));

    net.latest().drop();
    await eventually(() => expect(client.connectionState).toBe("connected"));

    expect(net.latest().sent.map((m) => JSON.parse(m).type)).toEqual(["__reconnect"]);
    expect(client.view).toEqual({ count: 4, lastCaller: "bot" });
    expectNoRewind(shown);
  });

  it("messages sent while reconnecting are delivered once the socket is back", async () => {
    const { actorId, stub } = await spawnCounter("seam-queue");
    const net = seamNetwork(stub);
    const { client, shown } = phone(actorId, net);
    await eventually(() => expect(client.connectionState).toBe("connected"));

    net.latest().drop();
    client.send({ type: "INCREMENT", amount: 7 });

    await eventually(() => expect(client.view).toEqual({ count: 7, lastCaller: "phone" }));
    expectNoRewind(shown);
  });

  it("a restart that closes every socket: the client reconnects to the restored state", async () => {
    const { actorId, stub } = await spawnCounter("seam-restart");
    const net = seamNetwork(stub);
    const { client, shown } = phone(actorId, net);
    await increment(stub, 2);
    await eventually(() => expect(client.view.count).toBe(2));

    await evictDurableObject(stub, { webSockets: "close" });
    await eventually(() => expect(client.connectionState).toBe("reconnecting"));
    await increment(stub);

    await eventually(() => expect(client.view.count).toBe(3));
    expect(client.connectionState).toBe("connected");
    expectNoRewind(shown);
  });

  it("hibernation keeps the socket: changes after the wake still arrive, in order", async () => {
    const { actorId, stub } = await spawnCounter("seam-hibernate");
    const net = seamNetwork(stub);
    const { client, shown } = phone(actorId, net);
    await increment(stub);
    await eventually(() => expect(client.view.count).toBe(1));

    await evictDurableObject(stub);
    await increment(stub);
    await increment(stub);

    await eventually(() => expect(client.view.count).toBe(3));
    expect(net.sockets).toHaveLength(1);
    expect(client.connectionState).toBe("connected");
    expectNoRewind(shown);
  });

  it("hibernation, then this client's own message wakes the actor", async () => {
    const { actorId, stub } = await spawnCounter("seam-hibernate-own");
    const net = seamNetwork(stub);
    const { client, shown } = phone(actorId, net);
    await increment(stub, 3);
    await eventually(() => expect(client.view.count).toBe(3));

    await evictDurableObject(stub);
    client.send({ type: "INCREMENT", amount: 1 });

    await eventually(() => expect(client.view).toEqual({ count: 4, lastCaller: "phone" }));
    expectNoRewind(shown);
  });

  it("two phones of one player stay in step through a drop of one of them", async () => {
    const { actorId, stub } = await spawnCounter("seam-two");
    const netA = seamNetwork(stub);
    const netB = seamNetwork(stub);
    const a = phone(actorId, netA, "ana");
    const b = phone(actorId, netB, "ana");
    await eventually(() => expect(b.client.connectionState).toBe("connected"));

    netA.latest().drop();
    b.client.send({ type: "INCREMENT", amount: 1 });
    await eventually(() => expect(b.client.view.count).toBe(1));
    await increment(stub);

    await eventually(() => expect(a.client.view.count).toBe(2));
    await eventually(() => expect(b.client.view.count).toBe(2));
    expectNoRewind(a.shown);
    expectNoRewind(b.shown);
  });
});
