import { afterEach, describe, expect, it, vi } from "vitest";
import { createActorFetch } from "../src/createActorFetch";

describe("createActorFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends actor fetch requests with parsed response data", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        checksum: "checksum-1",
        snapshot: {
          public: { todos: [] },
          private: {},
          value: "ready",
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const fetchActor = createActorFetch({
      actorType: "todo",
      host: "127.0.0.1:8788",
    });

    const result = await fetchActor({
      actorId: "list-1",
      accessToken: "token-123",
      input: { ownerId: "user-1" },
      waitForEvent: { type: "ADD_TODO", text: "Buy milk" } as never,
      waitForState: "ready" as never,
      timeout: 2500,
      errorOnWaitTimeout: false,
    });

    expect(result).toEqual({
      checksum: "checksum-1",
      snapshot: {
        public: { todos: [] },
        private: {},
        value: "ready",
      },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const requestUrl = new URL(url);

    expect(requestUrl.origin).toBe("http://127.0.0.1:8788");
    expect(requestUrl.pathname).toBe("/api/todo/list-1");
    expect(requestUrl.searchParams.get("input")).toBe(
      JSON.stringify({ ownerId: "user-1" })
    );
    expect(requestUrl.searchParams.get("waitForEvent")).toBe(
      JSON.stringify({ type: "ADD_TODO", text: "Buy milk" })
    );
    expect(requestUrl.searchParams.get("waitForState")).toBe(
      JSON.stringify("ready")
    );
    expect(requestUrl.searchParams.get("timeout")).toBe("2500");
    expect(requestUrl.searchParams.get("errorOnWaitTimeout")).toBe("false");
    expect(init.headers).toEqual({
      Authorization: "Bearer token-123",
    });
  });

  it("uses https for non-local hosts and merges custom request options", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        checksum: "checksum-2",
        snapshot: {
          public: { todos: [] },
          private: {},
          value: "ready",
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const fetchActor = createActorFetch({
      actorType: "todo",
      host: "actors.example.com",
    });

    await fetchActor(
      {
        actorId: "list-2",
        accessToken: "token-456",
      },
      {
        headers: {
          "X-Trace-Id": "trace-1",
        },
        method: "POST",
      }
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const requestUrl = new URL(url);

    expect(requestUrl.origin).toBe("https://actors.example.com");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "X-Trace-Id": "trace-1",
      Authorization: "Bearer token-456",
    });
  });

  it("always includes an input payload and omits optional wait params when absent", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        checksum: "checksum-3",
        snapshot: {
          public: { todos: [] },
          private: {},
          value: "ready",
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const fetchActor = createActorFetch({
      actorType: "todo",
      host: "localhost:8788",
    });

    await fetchActor({
      actorId: "list-3",
      accessToken: "token-789",
    });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    const requestUrl = new URL(url);

    expect(requestUrl.origin).toBe("http://localhost:8788");
    expect(requestUrl.searchParams.get("input")).toBe("{}");
    expect(requestUrl.searchParams.has("waitForEvent")).toBe(false);
    expect(requestUrl.searchParams.has("waitForState")).toBe(false);
    expect(requestUrl.searchParams.has("timeout")).toBe(false);
    expect(requestUrl.searchParams.has("errorOnWaitTimeout")).toBe(false);
  });

  it("treats 0.0.0.0 as a local host", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        checksum: "checksum-4",
        snapshot: {
          public: { todos: [] },
          private: {},
          value: "ready",
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const fetchActor = createActorFetch({
      actorType: "todo",
      host: "0.0.0.0:8788",
    });

    await fetchActor({
      actorId: "list-4",
      accessToken: "token-local",
    });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).origin).toBe("http://0.0.0.0:8788");
  });

  it("throws a descriptive error when the host is missing", async () => {
    const fetchActor = createActorFetch({
      actorType: "todo",
      host: "",
    });

    await expect(
      fetchActor({
        actorId: "list-1",
        accessToken: "token-123",
      })
    ).rejects.toThrow("Actor Kit host is not defined");
  });

  it("throws a timeout error for 408 responses unless timeout errors are disabled", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 408,
        statusText: "Request Timeout",
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 408,
        statusText: "Request Timeout",
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Server Error",
      });
    vi.stubGlobal("fetch", fetchMock);

    const fetchActor = createActorFetch({
      actorType: "todo",
      host: "0.0.0.0:8788",
    });

    await expect(
      fetchActor({
        actorId: "list-1",
        accessToken: "token-123",
        timeout: 500,
      })
    ).rejects.toThrow("Timeout waiting for actor response: Request Timeout");

    await expect(
      fetchActor({
        actorId: "list-1",
        accessToken: "token-123",
        errorOnWaitTimeout: false,
      })
    ).rejects.toThrow("Failed to fetch actor: Request Timeout");

    await expect(
      fetchActor({
        actorId: "list-1",
        accessToken: "token-123",
      })
    ).rejects.toThrow("Failed to fetch actor: Server Error");
  });
});
