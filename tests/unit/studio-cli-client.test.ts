import { describe, expect, it } from "vitest";
import { authFromEnv, createStudioClient, StudioClientError } from "../../packages/studio-cli/src/client";

type Seen = { url: string; headers: Headers };

function fakeFetch(respond: (url: URL) => Response) {
  const seen: Seen[] = [];
  const fetchFn = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    seen.push({ url: url.toString(), headers: new Headers(init?.headers) });
    return respond(url);
  };
  return { seen, fetchFn };
}

const entry = {
  id: 2,
  causeType: "message",
  causeData: "{}",
  stateSnapshot: "{}",
  checksum: "c",
  createdAt: 1,
};

describe("authFromEnv", () => {
  it("uses a service token when both halves are set", () => {
    expect(authFromEnv({ CF_ACCESS_CLIENT_ID: "id", CF_ACCESS_CLIENT_SECRET: "s" })).toEqual({
      kind: "service-token",
      clientId: "id",
      clientSecret: "s",
    });
  });

  it("uses a person's Access token", () => {
    expect(authFromEnv({ CF_ACCESS_TOKEN: "t" })).toEqual({ kind: "access-token", token: "t" });
  });

  it("is none when nothing is set (localhost dev)", () => {
    expect(authFromEnv({})).toEqual({ kind: "none" });
  });

  it("rejects half a service token", () => {
    expect(() => authFromEnv({ CF_ACCESS_CLIENT_ID: "id" })).toThrow(/CF_ACCESS_CLIENT_SECRET/);
  });
});

describe("createStudioClient", () => {
  it("sends service token headers and hits the inspect route", async () => {
    const { seen, fetchFn } = fakeFetch(() => Response.json({ initialized: true, state: { n: 1 } }));
    const client = createStudioClient({
      baseUrl: "https://game.example.com",
      auth: { kind: "service-token", clientId: "id", clientSecret: "s" },
      fetch: fetchFn,
    });
    expect(await client.inspect("counter", "room 1")).toMatchObject({ state: { n: 1 } });
    expect(seen[0]?.url).toBe("https://game.example.com/__studio/api/actors/counter/room%201");
    expect(seen[0]?.headers.get("CF-Access-Client-Id")).toBe("id");
    expect(seen[0]?.headers.get("CF-Access-Client-Secret")).toBe("s");
  });

  it("sends a person's token as cf-access-token", async () => {
    const { seen, fetchFn } = fakeFetch(() => Response.json({ types: ["a"] }));
    const client = createStudioClient({
      baseUrl: "https://g.example.com/",
      auth: { kind: "access-token", token: "t" },
      fetch: fetchFn,
    });
    expect(await client.types()).toEqual(["a"]);
    expect(seen[0]?.url).toBe("https://g.example.com/__studio/api/actors/types");
    expect(seen[0]?.headers.get("cf-access-token")).toBe("t");
  });

  it("passes timeline, list and view query params", async () => {
    const { seen, fetchFn } = fakeFetch((url) => {
      if (url.pathname.endsWith("/timeline")) return Response.json({ entries: [entry], hasMore: false });
      if (url.pathname.endsWith("/view"))
        return Response.json({ type: "studio.view", role: "r", caller: null, callerRole: null, data: 1 });
      return Response.json({ actors: [] });
    });
    const client = createStudioClient({ baseUrl: "http://localhost:8787", auth: { kind: "none" }, fetch: fetchFn });
    expect(await client.timeline("t", "i", { limit: 5, before: 9 })).toEqual({ entries: [entry], hasMore: false });
    await client.list({ type: "t", search: "x", limit: 2 });
    await client.view("t", "i", { role: "r", caller: "c" });
    expect(seen.map((s) => new URL(s.url).search)).toEqual([
      "?limit=5&before=9",
      "?type=t&search=x&limit=2",
      "?role=r&caller=c",
    ]);
  });

  it("raises a readable error with the status for a JSON error body", async () => {
    const { fetchFn } = fakeFetch(() => Response.json({ error: "Sign in through Cloudflare Access" }, { status: 401 }));
    const client = createStudioClient({ baseUrl: "https://x.example.com", auth: { kind: "none" }, fetch: fetchFn });
    const err = await client.types().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StudioClientError);
    expect(err).toMatchObject({ status: 401, message: "401: Sign in through Cloudflare Access" });
  });

  it("explains an Access login page (HTML) instead of JSON", async () => {
    const { fetchFn } = fakeFetch(
      () => new Response("<html>login</html>", { status: 200, headers: { "Content-Type": "text/html" } }),
    );
    const client = createStudioClient({ baseUrl: "https://x.example.com", auth: { kind: "none" }, fetch: fetchFn });
    await expect(client.types()).rejects.toThrow(/not JSON.*Access/);
  });

  it("rejects a malformed response", async () => {
    const { fetchFn } = fakeFetch(() => Response.json({ entries: "nope" }));
    const client = createStudioClient({ baseUrl: "https://x.example.com", auth: { kind: "none" }, fetch: fetchFn });
    await expect(client.timeline("t", "i")).rejects.toThrow(/Malformed/);
  });

  it("refuses a non-http base URL", () => {
    expect(() => createStudioClient({ baseUrl: "file:///etc", auth: { kind: "none" } })).toThrow(/http/);
  });
});

describe("createStudioClient: errors and requests (mutation hardening)", () => {
  const none = { kind: "none" as const };

  it("wraps a network failure", async () => {
    const client = createStudioClient({
      baseUrl: "https://x.example.com",
      auth: none,
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(client.types()).rejects.toThrow("Could not reach https://x.example.com: ECONNREFUSED");
  });

  it("reports a non-JSON-error failure body generically", async () => {
    const { fetchFn } = fakeFetch(() => Response.json({ nope: 1 }, { status: 500 }));
    const client = createStudioClient({ baseUrl: "https://x.example.com", auth: none, fetch: fetchFn });
    await expect(client.types()).rejects.toThrow("500: request failed");
  });

  it("names the error class", () => {
    expect(new StudioClientError("m", null).name).toBe("StudioClientError");
  });

  it("does not follow redirects (an Access login redirect must not be chased)", async () => {
    let init: RequestInit | undefined;
    const client = createStudioClient({
      baseUrl: "https://x.example.com",
      auth: none,
      fetch: async (_u, i) => {
        init = i;
        return Response.json({ types: [] });
      },
    });
    await client.types();
    expect(init?.redirect).toBe("manual");
  });

  it("sends no auth headers in dev mode and no query string without params", async () => {
    const { seen, fetchFn } = fakeFetch(() => Response.json({ actors: [] }));
    await createStudioClient({ baseUrl: "http://localhost:8787", auth: none, fetch: fetchFn }).list();
    expect(seen[0]?.url).toBe("http://localhost:8787/__studio/api/actors");
    expect([...(seen[0]?.headers.keys() ?? [])]).toEqual([]);
  });

  it.each([
    ["list", (c: ReturnType<typeof createStudioClient>) => c.list(), { actors: [{ actorType: 1 }] }],
    ["inspect", (c: ReturnType<typeof createStudioClient>) => c.inspect("t", "i"), "nope"],
    ["view", (c: ReturnType<typeof createStudioClient>) => c.view("t", "i", { role: "r" }), { type: "other" }],
  ])("rejects a malformed %s response", async (_name, call, body) => {
    const { fetchFn } = fakeFetch(() => Response.json(body));
    await expect(
      call(createStudioClient({ baseUrl: "https://x.example.com", auth: none, fetch: fetchFn })),
    ).rejects.toThrow(/Malformed/);
  });

  it("parses both view reply forms", async () => {
    const err = { type: "studio.view", role: "r", caller: null, error: "No view" };
    const { fetchFn } = fakeFetch(() => Response.json(err));
    expect(
      await createStudioClient({ baseUrl: "https://x.example.com", auth: none, fetch: fetchFn }).view("t", "i", {
        role: "r",
      }),
    ).toEqual(err);
  });
});

describe("authFromEnv: edge cases (mutation hardening)", () => {
  it("rejects a secret without an id", () => {
    expect(() => authFromEnv({ CF_ACCESS_CLIENT_SECRET: "s" })).toThrow(/CF_ACCESS_CLIENT_ID/);
  });

  it("treats empty strings as unset", () => {
    expect(authFromEnv({ CF_ACCESS_CLIENT_ID: "", CF_ACCESS_CLIENT_SECRET: "", CF_ACCESS_TOKEN: "" })).toEqual({
      kind: "none",
    });
  });

  it("accepts long credentials", () => {
    expect(authFromEnv({ CF_ACCESS_CLIENT_ID: "id.access", CF_ACCESS_CLIENT_SECRET: "a".repeat(64) })).toMatchObject({
      kind: "service-token",
    });
    expect(authFromEnv({ CF_ACCESS_TOKEN: "t".repeat(40) })).toEqual({ kind: "access-token", token: "t".repeat(40) });
  });

  it("prefers a service token over a person's token", () => {
    expect(authFromEnv({ CF_ACCESS_CLIENT_ID: "i", CF_ACCESS_CLIENT_SECRET: "s", CF_ACCESS_TOKEN: "t" }).kind).toBe(
      "service-token",
    );
  });
});
