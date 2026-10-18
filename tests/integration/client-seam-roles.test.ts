/**
 * A role that changes under a client (the todo-list example: a viewer invited becomes a member).
 * The view switches to another binary schema; the typed client must decode it with the new role's
 * schema, live, after a reconnect and after a page that slept, and its role must follow.
 */

import { env } from "cloudflare:test";
import { actorClient } from "@actor-kit/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TodoListContract } from "../../examples/todo-list/src/todo";
import { eventually, fakeDocument, type SeamNetwork, seamNetwork } from "./client-seam-socket";

const open: Array<{ disconnect(): void }> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const client of open.splice(0)) client.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 100));
});

let n = 0;
async function list(prefix: string) {
  const actorId = `${prefix}-${Date.now()}-${++n}`;
  const stub = env.EXAMPLE_TODO_LIST.get(env.EXAMPLE_TODO_LIST.idFromName(actorId));
  await stub.spawn({ actorId, caller: "mom", callerType: "user", input: { creator: "mom" } });
  return { actorId, stub };
}

const Todos = actorClient(TodoListContract);

function kidScreen(actorId: string, net: SeamNetwork, heartbeat = { intervalMs: 100, timeoutMs: 150 }) {
  const client = Todos.create({
    path: `/api/todo-list/${actorId}`,
    host: "localhost",
    initialView: { role: "viewer", todoCount: 0, doneCount: 0 },
    getToken: () => "kid",
    WebSocketImpl: net.WebSocketImpl,
    heartbeat,
  });
  const roles: Array<string | undefined> = [];
  client.subscribe(() => roles.push(client.role));
  open.push(client);
  client.connect();
  return { client, roles };
}

async function as(stub: DurableObjectStub, caller: string, message: { type: string; [key: string]: unknown }) {
  const result: unknown = await stub.send(caller, "user", message);
  expect(result).toMatchObject({ ok: true });
}

describe("a role that changes under a client", () => {
  it("live: a viewer invited becomes a member and decodes the member view", async () => {
    const { actorId, stub } = await list("role-live");
    await as(stub, "mom", { type: "ADD_TODO", text: "brush teeth" });
    const kid = kidScreen(actorId, seamNetwork(stub));
    await eventually(() => expect(kid.client.view).toMatchObject({ todoCount: 1, doneCount: 0 }));
    expect(kid.client.role).toBe("viewer");

    await as(stub, "mom", { type: "INVITE", userId: "kid" });

    await eventually(() => expect(kid.client.role).toBe("member"));
    expect(kid.client.view).toMatchObject({ todos: [{ text: "brush teeth", done: false }], memberCount: 1 });
    await as(stub, "mom", { type: "ADD_TODO", text: "pajamas" });
    await eventually(() => expect(kid.client.view).toMatchObject({ memberCount: 1 }));
    await eventually(() => expect(Reflect.get(kid.client.view, "todos")).toHaveLength(2));
    expect(kid.roles.filter((role) => role !== "viewer").every((role) => role === "member")).toBe(true);
  });

  it("while away: the reconnect brings the member view, not the viewer one", async () => {
    const { actorId, stub } = await list("role-away");
    const net = seamNetwork(stub);
    const kid = kidScreen(actorId, net);
    await eventually(() => expect(kid.client.role).toBe("viewer"));

    net.latest().drop();
    await as(stub, "mom", { type: "INVITE", userId: "kid" });
    await as(stub, "mom", { type: "ADD_TODO", text: "shoes" });

    await eventually(() => expect(kid.client.role).toBe("member"));
    await eventually(() => expect(kid.client.view).toMatchObject({ todos: [{ text: "shoes" }], memberCount: 1 }));
  });

  it("while the page slept: on show it switches role and schema, then follows deltas", async () => {
    const page = fakeDocument();
    vi.stubGlobal("document", page.doc);
    const { actorId, stub } = await list("role-sleep");
    const net = seamNetwork(stub);
    const kid = kidScreen(actorId, net, { intervalMs: 60_000, timeoutMs: 150 });
    await eventually(() => expect(kid.client.role).toBe("viewer"));

    page.hide();
    net.latest().goZombie();
    await as(stub, "mom", { type: "INVITE", userId: "kid" });
    page.show();

    await eventually(() => expect(kid.client.role).toBe("member"), 2000);
    await as(stub, "mom", { type: "ADD_TODO", text: "teeth" });
    await eventually(() => expect(kid.client.view).toMatchObject({ todos: [{ text: "teeth" }] }));
  });
});
