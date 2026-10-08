/**
 * Studio API client: URLs and query strings, error classification and
 * messages, and response parsing. fetch is replaced at the global boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchActors,
  fetchActorTypes,
  fetchInspect,
  fetchTimeline,
  StudioApiError,
  type StudioApiErrorKind,
} from "../../packages/studio/ui/src/api";

type Reply = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

const calls: Array<{ url: URL; raw: string; init: RequestInit | undefined }> = [];
let reply: Reply = () => Response.json({ actors: [] });

beforeEach(() => {
  calls.length = 0;
  reply = () => Response.json({ actors: [] });
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://localhost");
    calls.push({ url, raw: input, init });
    return reply(url, init);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function failure(promise: Promise<unknown>): Promise<StudioApiError> {
  const err: unknown = await promise.then(
    () => new Error("expected a failure"),
    (e: unknown) => e,
  );
  if (!(err instanceof StudioApiError)) throw err;
  return err;
}

const inspectBody = {
  state: { n: 1 },
  version: 2,
  actorId: "a1",
  connections: [],
  outbox: [],
  activeLinks: [],
  linkSubscribers: [],
};

describe("StudioApiError", () => {
  it.each<[StudioApiErrorKind, boolean]>([
    ["unauthorized", true],
    ["forbidden", true],
    ["bad-request", true],
    ["not-found", false],
    ["unavailable", false],
    ["server", false],
    ["network", false],
    ["malformed", false],
  ])("%s is permanent: %s", (kind, permanent) => {
    const err = new StudioApiError(kind, "m", 1);
    expect(err.permanent).toBe(permanent);
    expect(err.name).toBe("StudioApiError");
    expect(err.message).toBe("m");
    expect(err.kind).toBe(kind);
    expect(err.status).toBe(1);
  });
});

describe("error responses", () => {
  it.each<[number, StudioApiErrorKind]>([
    [400, "bad-request"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not-found"],
    [503, "unavailable"],
    [500, "server"],
    [502, "server"],
  ])("HTTP %i is classified as %s", async (status, kind) => {
    reply = () => Response.json({ error: "Unauthorized: x" }, { status });
    const err = await failure(fetchActorTypes());
    expect(err.kind).toBe(kind);
    expect(err.status).toBe(status);
  });

  it("uses the JSON error field as the message", async () => {
    reply = () => Response.json({ error: "registry exploded" }, { status: 500 });
    expect((await failure(fetchActorTypes())).message).toBe("registry exploded");
  });

  it("uses a plain-text body, trimmed", async () => {
    reply = () => new Response("  gateway timeout \n", { status: 504 });
    expect((await failure(fetchActorTypes())).message).toBe("gateway timeout");
  });

  it("uses the raw body when the JSON has no error field", async () => {
    reply = () => new Response('{"message":"nope"}', { status: 500 });
    expect((await failure(fetchActorTypes())).message).toBe('{"message":"nope"}');
  });

  it("falls back to the status for an empty body", async () => {
    reply = () => new Response("   ", { status: 502 });
    expect((await failure(fetchActorTypes())).message).toBe("HTTP 502");
  });

  it("falls back to the status when the body cannot be read", async () => {
    reply = () => {
      const res = new Response("x", { status: 500 });
      vi.spyOn(res, "text").mockRejectedValue(new TypeError("stream broke"));
      return res;
    };
    const err = await failure(fetchActorTypes());
    expect(err.kind).toBe("server");
    expect(err.message).toBe("HTTP 500");
  });

  it("prefixes a 401 message that does not already say unauthorized", async () => {
    reply = () => Response.json({ error: "Sign in through Cloudflare Access" }, { status: 401 });
    expect((await failure(fetchActorTypes())).message).toBe("Unauthorized: Sign in through Cloudflare Access");
    reply = () => new Response("", { status: 401 });
    expect((await failure(fetchActorTypes())).message).toBe("Unauthorized: HTTP 401");
  });

  it.each(["Unauthorized", "unauthorised request"])("leaves a 401 message %j alone", async (message) => {
    reply = () => Response.json({ error: message }, { status: 401 });
    expect((await failure(fetchActorTypes())).message).toBe(message);
  });

  it("does not prefix other statuses", async () => {
    reply = () => Response.json({ error: "Studio is not configured" }, { status: 403 });
    expect((await failure(fetchActorTypes())).message).toBe("Studio is not configured");
  });
});

describe("transport failures", () => {
  it("reports an unreachable API as a network error", async () => {
    reply = () => {
      throw new TypeError("Failed to fetch");
    };
    const err = await failure(fetchActorTypes());
    expect(err.kind).toBe("network");
    expect(err.status).toBeNull();
    expect(err.message).toBe("Network error: could not reach the Studio API");
  });

  it("reports a DOMException other than an abort as a network error", async () => {
    reply = () => {
      throw new DOMException("offline", "NetworkError");
    };
    expect((await failure(fetchActorTypes())).kind).toBe("network");
  });

  it("reports a non-DOMException named AbortError as a network error", async () => {
    reply = () => {
      const err = new Error("not really");
      err.name = "AbortError";
      throw err;
    };
    expect((await failure(fetchActorTypes())).kind).toBe("network");
  });

  it("rethrows an abort unchanged so callers can ignore it", async () => {
    const abort = new DOMException("aborted", "AbortError");
    reply = () => {
      throw abort;
    };
    await expect(fetchActorTypes()).rejects.toBe(abort);
  });

  it("passes the abort signal to fetch, and no options without one", async () => {
    reply = () => Response.json({ types: [] });
    const controller = new AbortController();
    await fetchActorTypes(controller.signal);
    await fetchActorTypes();
    expect(calls[0]?.init).toStrictEqual({ signal: controller.signal });
    expect(calls[1]?.init).toStrictEqual({});
  });
});

describe("successful responses", () => {
  it("rejects a body that is not JSON", async () => {
    reply = () => new Response("<html>", { status: 200 });
    const err = await failure(fetchActorTypes());
    expect(err.kind).toBe("malformed");
    expect(err.status).toBe(200);
    expect(err.message).toBe("Malformed response: body is not JSON");
  });

  it("rejects an unreadable body as not JSON", async () => {
    reply = () => {
      const res = new Response("{}", { status: 200 });
      vi.spyOn(res, "text").mockRejectedValue(new TypeError("stream broke"));
      return res;
    };
    expect((await failure(fetchActorTypes())).message).toBe("Malformed response: body is not JSON");
  });

  it("treats a 200 carrying an error body as a server error", async () => {
    reply = () => Response.json({ error: "RPC failed" });
    const err = await failure(fetchActorTypes());
    expect(err.kind).toBe("server");
    expect(err.status).toBe(200);
    expect(err.message).toBe("RPC failed");
  });

  it("rejects a body of the wrong shape, naming the path", async () => {
    reply = () => Response.json({ types: [1] });
    const err = await failure(fetchActorTypes());
    expect(err.kind).toBe("malformed");
    expect(err.message).toMatch(/^Malformed response: types\.0: /);
  });

  it("returns the parsed types", async () => {
    reply = () => Response.json({ types: ["chat", "counter"] });
    await expect(fetchActorTypes()).resolves.toEqual(["chat", "counter"]);
    expect(calls[0]?.raw).toBe("/__studio/api/actors/types");
  });
});

describe("fetchActors", () => {
  const row = { actorType: "counter", actorId: "c1", lastActiveAt: 5, version: null, connectionCount: 2 };

  it("asks for every actor without a query string when given no options", async () => {
    reply = () => Response.json({ actors: [row] });
    await expect(fetchActors()).resolves.toEqual([row]);
    expect(calls[0]?.raw).toBe("/__studio/api/actors");
  });

  it("sends type, search, limit and offset", async () => {
    await fetchActors({ type: "counter", search: "c 1", limit: 51, offset: 50 });
    expect(calls[0]?.raw).toBe("/__studio/api/actors?type=counter&search=c+1&limit=51&offset=50");
  });

  it("omits empty filters and a zero offset, but keeps a zero limit", async () => {
    await fetchActors({ type: "", search: "", limit: 0, offset: 0 });
    expect(calls[0]?.raw).toBe("/__studio/api/actors?limit=0");
  });

  it("omits an absent limit", async () => {
    await fetchActors({ search: "x" });
    expect(calls[0]?.raw).toBe("/__studio/api/actors?search=x");
  });
});

describe("fetchInspect and fetchTimeline", () => {
  it("encodes type and id into the inspect path", async () => {
    reply = () => Response.json(inspectBody);
    await expect(fetchInspect("my type", "room/1")).resolves.toEqual(inspectBody);
    expect(calls[0]?.raw).toBe("/__studio/api/actors/my%20type/room%2F1");
  });

  it("requests the timeline without a query string by default and parses entries", async () => {
    reply = () =>
      Response.json({
        entries: [
          {
            id: 1,
            causeType: "init",
            causeData: "{}",
            stateSnapshot: '{"n":1}',
            checksum: "c",
            createdAt: 3,
          },
        ],
        hasMore: true,
      });
    await expect(fetchTimeline("counter", "a1")).resolves.toEqual({
      entries: [{ id: 1, causeType: "init", cause: {}, state: { n: 1 }, checksum: "c", createdAt: 3 }],
      hasMore: true,
    });
    expect(calls[0]?.raw).toBe("/__studio/api/actors/counter/a1/timeline");
  });

  it("sends limit and before when set", async () => {
    reply = () => Response.json({ entries: [], hasMore: false });
    await fetchTimeline("counter", "a1", { limit: 20, before: 99 });
    await fetchTimeline("counter", "a1", { limit: 0, before: 0 });
    expect(calls[0]?.raw).toBe("/__studio/api/actors/counter/a1/timeline?limit=20&before=99");
    expect(calls[1]?.raw).toBe("/__studio/api/actors/counter/a1/timeline");
  });
});
