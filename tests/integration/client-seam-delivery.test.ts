/**
 * ADR-021 spike (Proposed): what happens to a tap sent on a socket that is dead but still OPEN.
 * Today a client message is delivered at most once: written to a dead socket, it is lost. With
 * `exactlyOnce: true` the client keeps each message until the actor acks it and resends it on the
 * next socket; the actor remembers delivered ids (SQLite, per caller), so a resend is applied once.
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
  await new Promise((resolve) => setTimeout(resolve, 100));
});

let n = 0;
async function counter(prefix: string) {
  const actorId = `${prefix}-${Date.now()}-${++n}`;
  const stub = env.COUNTER.get(env.COUNTER.idFromName(actorId));
  await stub.spawn({ actorId, caller: "host", callerType: "user", input: {} });
  return { actorId, stub };
}

function phone(actorId: string, net: SeamNetwork, exactlyOnce: boolean) {
  const client = createActorClient<View>({
    path: `/api/counter/${actorId}`,
    host: "localhost",
    initialView: { count: 0, lastCaller: "" },
    viewSchema: CounterView,
    getToken: () => "kid",
    WebSocketImpl: net.WebSocketImpl,
    heartbeat: { intervalMs: 100, timeoutMs: 150 },
    ...(exactlyOnce ? { exactlyOnce: true } : {}),
  });
  open.push(client);
  client.connect();
  return client;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("today: at most once", () => {
  it("a tap written to a dead-but-OPEN socket is lost (the reconnect does not resend it)", async () => {
    const { actorId, stub } = await counter("amo-lost");
    const net = seamNetwork(stub);
    const kid = phone(actorId, net, false);
    await eventually(() => expect(kid.connectionState).toBe("connected"));

    net.latest().goZombie();
    kid.send({ type: "INCREMENT", amount: 1 });
    await eventually(() => expect(net.sockets).toHaveLength(2), 2000);
    await eventually(() => expect(kid.connectionState).toBe("connected"));
    await pause(300);

    expect(kid.view.count).toBe(0);
  });
});

describe("exactlyOnce: true (ADR-021 spike)", () => {
  it("a tap written to a dead-but-OPEN socket is resent on the next socket and applied once", async () => {
    const { actorId, stub } = await counter("eo-lost");
    const net = seamNetwork(stub);
    const kid = phone(actorId, net, true);
    await eventually(() => expect(kid.connectionState).toBe("connected"));

    net.latest().goZombie();
    kid.send({ type: "INCREMENT", amount: 1 });

    await eventually(() => expect(kid.view).toEqual({ count: 1, lastCaller: "kid" }), 6000);
    await pause(300);
    expect(kid.view.count).toBe(1);
  });

  it("a tap that arrived but whose ack was lost is resent and not applied twice", async () => {
    const { actorId, stub } = await counter("eo-ack-lost");
    const net = seamNetwork(stub);
    const kid = phone(actorId, net, true);
    await eventually(() => expect(kid.connectionState).toBe("connected"));

    net.latest().goDeaf();
    kid.send({ type: "INCREMENT", amount: 1 });

    await eventually(() => expect(net.sockets).toHaveLength(2), 2000);
    await eventually(() => expect(kid.view.count).toBe(1), 6000);
    await pause(300);
    expect(kid.view.count).toBe(1);
    expect(net.sockets.at(-1)?.sent.filter((m) => JSON.parse(m).type === "INCREMENT")).toHaveLength(1);
  });

  it("the actor still remembers the delivered tap after it hibernated", async () => {
    const { actorId, stub } = await counter("eo-hibernate");
    const net = seamNetwork(stub);
    const kid = phone(actorId, net, true);
    await eventually(() => expect(kid.connectionState).toBe("connected"));

    net.latest().goDeaf();
    kid.send({ type: "INCREMENT", amount: 2 });
    await pause(50);
    await evictDurableObject(stub);

    await eventually(() => expect(net.sockets).toHaveLength(2), 2000);
    await eventually(() => expect(kid.view.count).toBe(2), 6000);
    await pause(300);
    expect(kid.view.count).toBe(2);
  });

  it("several taps in flight are applied once each, in order", async () => {
    const { actorId, stub } = await counter("eo-order");
    const net = seamNetwork(stub);
    const kid = phone(actorId, net, true);
    await eventually(() => expect(kid.connectionState).toBe("connected"));

    kid.send({ type: "INCREMENT", amount: 1 });
    net.latest().goDeaf();
    kid.send({ type: "INCREMENT", amount: 10 });
    net.latest().goZombie();
    kid.send({ type: "INCREMENT", amount: 100 });

    await eventually(() => expect(kid.view.count).toBe(111), 6000);
    await pause(300);
    expect(kid.view.count).toBe(111);
  });

  it("a refused message is acked too: it is not resent forever", async () => {
    const { actorId, stub } = await counter("eo-refused");
    const net = seamNetwork(stub);
    const kid = phone(actorId, net, true);
    await eventually(() => expect(kid.connectionState).toBe("connected"));

    kid.send({ type: "DECREMENT", amount: 1 }); // admin only: refused
    kid.send({ type: "INCREMENT", amount: 1 });
    await eventually(() => expect(kid.view.count).toBe(1));

    net.latest().drop();
    await eventually(() => expect(net.sockets).toHaveLength(2), 2000);
    await eventually(() => expect(kid.connectionState).toBe("connected"));
    await pause(300);
    const sent = net.sockets.at(-1)?.sent.map((m) => JSON.parse(m).type) ?? [];
    expect(sent.filter((type) => type !== "__ping")).toEqual(["__reconnect"]);
  });
});
