import { describe, expect, it, vi } from "vitest";
import { createAccessToken } from "@actor-kit/server";
import { createActorKitRouter } from "@actor-kit/worker";

type SpawnArgs = {
  actorType: string;
  actorId: string;
  caller: { type: "client" | "service" | "system"; id: string };
  input: Record<string, unknown>;
};

function createStub() {
  const spawn = vi.fn<(props: SpawnArgs) => Promise<void>>().mockResolvedValue();
  const getSnapshot = vi
    .fn<
      (
        caller: SpawnArgs["caller"],
        options?: {
          waitForEvent?: unknown;
          waitForState?: unknown;
          timeout?: number;
          errorOnWaitTimeout?: boolean;
        }
      ) => Promise<{ checksum: string; snapshot: unknown }>
    >()
    .mockResolvedValue({
      checksum: "checksum-1",
      snapshot: {
        public: { todos: [] },
        private: {},
        value: "ready",
      },
    });
  const send = vi.fn<(event: Record<string, unknown>) => void>();
  const fetch = vi.fn<(request: Request) => Promise<Response>>().mockResolvedValue(
    new Response("upgraded")
  );

  return { fetch, getSnapshot, send, spawn };
}

function createEnv(stub = createStub()) {
  const namespace = {
    idFromName: vi.fn((name: string) => `todo:${name}`),
    get: vi.fn(() => stub),
  };

  return {
    env: {
      ACTOR_KIT_SECRET: "super-secret",
      TODO: namespace,
    },
    namespace,
    stub,
  };
}

async function createBearerToken() {
  return createAccessToken({
    signingKey: "super-secret",
    actorId: "list-1",
    actorType: "todo",
    callerId: "user-42",
    callerType: "client",
  });
}

describe("createActorKitRouter", () => {
  it("parses boundary inputs on GET and only spawns an actor once", async () => {
    const { env, namespace, stub } = createEnv();
    const token = await createBearerToken();
    const router = createActorKitRouter<typeof env>(["todo"]);

    const baseUrl =
      "https://example.com/api/todo/list-1?waitForEvent=%7B%22type%22%3A%22ADD_TODO%22%7D&waitForState=%22ready%22&timeout=2500&errorOnWaitTimeout=false";

    const firstResponse = await router(
      new Request(baseUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }),
      env
    );
    const secondResponse = await router(
      new Request("https://example.com/api/todo/list-1", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }),
      env
    );

    expect(firstResponse.status).toBe(200);
    await expect(firstResponse.json()).resolves.toEqual({
      checksum: "checksum-1",
      snapshot: {
        public: { todos: [] },
        private: {},
        value: "ready",
      },
    });
    expect(namespace.idFromName).toHaveBeenCalledWith("list-1");
    expect(stub.spawn).toHaveBeenCalledTimes(1);
    expect(stub.spawn).toHaveBeenCalledWith({
      actorType: "todo",
      actorId: "list-1",
      caller: {
        id: "user-42",
        type: "client",
      },
      input: {},
    });
    expect(stub.getSnapshot).toHaveBeenNthCalledWith(
      1,
      { id: "user-42", type: "client" },
      {
        waitForEvent: { type: "ADD_TODO" },
        waitForState: "ready",
        timeout: 2500,
        errorOnWaitTimeout: false,
      }
    );
    expect(stub.getSnapshot).toHaveBeenNthCalledWith(
      2,
      { id: "user-42", type: "client" },
      {
        waitForEvent: undefined,
        waitForState: undefined,
        timeout: undefined,
        errorOnWaitTimeout: undefined,
      }
    );
    expect(secondResponse.status).toBe(200);
  });

  it("parses websocket auth from the query string and forwards upgrades", async () => {
    const { env, stub } = createEnv();
    const token = await createBearerToken();
    const router = createActorKitRouter<typeof env>(["todo"]);

    const response = await router(
      new Request(
        `https://example.com/api/todo/list-1?accessToken=${encodeURIComponent(token)}`,
        {
          headers: {
            Upgrade: "websocket",
          },
        }
      ),
      env
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("upgraded");
    expect(stub.fetch).toHaveBeenCalledOnce();
  });

  it("parses JSON bodies for POST and attaches caller metadata", async () => {
    const { env, stub } = createEnv();
    const token = await createBearerToken();
    const router = createActorKitRouter<typeof env>(["todo"]);

    const response = await router(
      new Request("https://example.com/api/todo/list-1", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ type: "ADD_TODO", text: "Ship it" }),
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(stub.send).toHaveBeenCalledWith({
      type: "ADD_TODO",
      text: "Ship it",
      caller: {
        id: "user-42",
        type: "client",
      },
    });
  });

  it("rejects invalid auth, invalid JSON, unsupported methods, and unknown actor types", async () => {
    const { env } = createEnv();
    const router = createActorKitRouter<typeof env>(["todo"]);
    const token = await createBearerToken();

    const authError = await router(
      new Request("https://example.com/api/todo/list-1"),
      env
    );
    const invalidJson = await router(
      new Request("https://example.com/api/todo/list-1", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: "{nope",
      }),
      env
    );
    const unknownType = await router(
      new Request("https://example.com/api/unknown/list-1"),
      env
    );
    const badMethod = await router(
      new Request("https://example.com/api/todo/list-1", {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${await createBearerToken()}`,
        },
      }),
      env
    );

    expect(authError.status).toBe(401);
    await expect(authError.text()).resolves.toContain("valid caller");
    expect(invalidJson.status).toBe(400);
    expect(unknownType.status).toBe(400);
    await expect(unknownType.text()).resolves.toContain("Unknown actor type");
    expect(badMethod.status).toBe(405);
  });

  it("returns 400 or 500 for invalid routes, invalid search params, and missing namespaces", async () => {
    const { env } = createEnv();
    const router = createActorKitRouter<typeof env>(["todo"]);
    const token = await createBearerToken();

    const notFound = await router(new Request("https://example.com/"), env);
    const invalidTimeout = await router(
      new Request("https://example.com/api/todo/list-1?timeout=0", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }),
      env
    );
    const missingNamespaceRouter = createActorKitRouter<{
      ACTOR_KIT_SECRET: string;
    }>(["todo"]);
    const missingNamespace = await missingNamespaceRouter(
      new Request("https://example.com/api/todo/list-1", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }),
      { ACTOR_KIT_SECRET: "super-secret" }
    );

    expect(notFound.status).toBe(404);
    expect(invalidTimeout.status).toBe(400);
    expect(missingNamespace.status).toBe(500);
    await expect(missingNamespace.text()).resolves.toContain(
      "Durable Object namespace not found"
    );
  });
});
