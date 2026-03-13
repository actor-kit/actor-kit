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
    expect(requestUrl.searchParams.get("timeout")).toBe("2500");
    expect(requestUrl.searchParams.get("errorOnWaitTimeout")).toBe("false");
    expect(init.headers).toEqual({
      Authorization: "Bearer token-123",
    });
  });
});
