/**
 * Keeping zod out of client bundles (Run Set Jimmy feedback): the client needs only the roles (their order
 * numbers the binary frames) and the view schemas, both zod-free. `actorClient<typeof Contract>({ roles,
 * views })` takes exactly those (the same objects the contract uses) and is typed by the contract type,
 * imported with `import type`, so the contract module (and zod) never reaches the browser.
 */
import { actorClient, type ClientError } from "@actor-kit/client";
import { createSnapshotFrame, encode, schema, string, uint32, view } from "@actor-kit/core";
import { setup } from "@actor-kit/worker/testing";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

// --- what would live in a zod-free `room.views.ts` ---
type S = { count: number; secret: string };
const OwnerView = schema({ count: uint32, secret: string });
const ViewerView = schema({ count: uint32 });
const roomRoles = { owner: (_s: S, caller: string) => caller === "owner", viewer: () => true };
const roomViews = {
  owner: view.shared(OwnerView, (s: S) => s),
  viewer: view.shared(ViewerView, (s: S) => ({ count: s.count })),
};

// --- the contract (server only; imports zod) ---
const kit = setup({});
const Room = kit.actor("room", {
  input: z.object({}),
  init: (): S => ({ count: 0, secret: "" }),
  roles: roomRoles,
  messages: { ADD: kit.message(z.object({ by: z.number() }), (s: S, { by }) => ({ ...s, count: s.count + by })) },
  views: roomViews,
});

type Listener = (event: { data?: unknown }) => void;
class Socket {
  static last: Socket | undefined;
  readonly listeners = new Map<string, Listener[]>();
  readyState = 0;
  constructor(readonly url: string) {
    Socket.last = this;
    setTimeout(() => {
      this.readyState = 1;
      for (const l of this.listeners.get("open") ?? []) l({});
    }, 0);
  }
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send() {}
  close() {}
  receive(frame: Uint8Array) {
    const buffer = frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength);
    for (const l of this.listeners.get("message") ?? []) l({ data: buffer });
  }
}

describe("actorClient<typeof Contract>({ roles, views })", () => {
  it("is typed by the contract: its views and its messages", () => {
    const factory = actorClient<typeof Room>({ roles: roomRoles, views: roomViews });
    const client = factory.create({ path: "/r/1", host: "example.com", initialView: { count: 0 } });
    expectTypeOf(client.view).toEqualTypeOf<{ count: number; secret: string } | { count: number }>();
    client.send({ type: "ADD", by: 1 });
    // @ts-expect-error ADD needs `by`
    client.send({ type: "ADD" });
    // @ts-expect-error the views must be the contract's
    actorClient<typeof Room>({ roles: roomRoles, views: { owner: roomViews.owner } });
    client.disconnect();
    expect(true).toBe(true);
  });

  it("decodes each role's binary frames like actorClient(contract)", async () => {
    const client = actorClient<typeof Room>({ roles: roomRoles, views: roomViews }).create({
      path: "/r/1",
      host: "example.com",
      initialView: { count: 0 },
      WebSocketImpl: Socket,
    });
    client.connect();
    await new Promise((r) => setTimeout(r, 5));
    Socket.last?.receive(createSnapshotFrame(1, 1, encode(ViewerView, { count: 7 })));
    expect([client.view, client.role]).toEqual([{ count: 7 }, "viewer"]);
    Socket.last?.receive(createSnapshotFrame(1, 0, encode(OwnerView, { count: 8, secret: "s" })));
    expect([client.view, client.role]).toEqual([{ count: 8, secret: "s" }, "owner"]);
    client.disconnect();
    const onError: (e: ClientError) => void = () => {};
    expect(typeof onError).toBe("function");
  });
});
