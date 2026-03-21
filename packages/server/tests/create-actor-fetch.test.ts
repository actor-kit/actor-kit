import { afterEach, describe, expect, it, vi } from "vitest";
import { createActorFetch } from "../src/createActorFetch";

describe("createActorFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends fetch with correct URL, input, and auth header", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        checksum: "checksum-1",
        snapshot: { todos: [], isOwner: true },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const fetchActor = createActorFetch<{ todos: unknown[]; isOwner: boolean }>({
      actorType: "todo",
      host: "127.0.0.1:8788",
    });

    const result = await fetchActor({
      actorId: "list-1",
      accessToken: "token-123",
      input: { ownerId: "user-1" },
    });

    expect(result).toEqual({
      checksum: "checksum-1",
      snapshot: { todos: [], isOwner: true },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const requestUrl = new URL(url);

    expect(requestUrl.origin).toBe("http://127.0.0.1:8788");
    expect(requestUrl.pathname).toBe("/api/todo/list-1");
    expect(requestUrl.searchParams.get("input")).toBe(
      JSON.stringify({ ownerId: "user-1" })
    );
    expect(init.headers).toEqual({
      Authorization: "Bearer token-123",
    });
  });

  it("uses https for non-local hosts and merges custom request options", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        checksum: "checksum-2",
        snapshot: { count: 0 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const fetchActor = createActorFetch<{ count: number }>({
      actorType: "counter",
      host: "actors.example.com",
    });

    await fetchActor(
      { actorId: "c-1", accessToken: "token-456" },
      { headers: { "X-Trace-Id": "trace-1" }, method: "POST" }
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).origin).toBe("https://actors.example.com");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "X-Trace-Id": "trace-1",
      Authorization: "Bearer token-456",
    });
  });

  it("defaults input to empty object", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ checksum: "c", snapshot: {} }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const fetchActor = createActorFetch({ actorType: "todo", host: "localhost:8788" });
    await fetchActor({ actorId: "list-3", accessToken: "token" });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).searchParams.get("input")).toBe("{}");
  });

  it("treats 0.0.0.0 as local host", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ checksum: "c", snapshot: {} }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const fetchActor = createActorFetch({ actorType: "todo", host: "0.0.0.0:8788" });
    await fetchActor({ actorId: "list-4", accessToken: "token" });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).origin).toBe("http://0.0.0.0:8788");
  });

  it("throws when host is empty", async () => {
    const fetchActor = createActorFetch({ actorType: "todo", host: "" });
    await expect(
      fetchActor({ actorId: "list-1", accessToken: "token" })
    ).rejects.toThrow("Actor Kit host is not defined");
  });

  it("throws on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Server Error",
    }));

    const fetchActor = createActorFetch({ actorType: "todo", host: "0.0.0.0:8788" });
    await expect(
      fetchActor({ actorId: "list-1", accessToken: "token" })
    ).rejects.toThrow("Failed to fetch actor: Server Error");
  });
});
