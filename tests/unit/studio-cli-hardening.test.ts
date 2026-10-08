import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli, USAGE } from "../../packages/studio-cli/src/cli";
import { createStudioClient } from "../../packages/studio-cli/src/client";
import { defined } from "../../packages/studio-cli/src/present";
import { changedPaths, timelineShape } from "../../packages/studio-cli/src/shape";

const ENV = { ACTOR_KIT_STUDIO_URL: "https://game.example.com" };

const entry = (id: number, state: unknown, causeData = "{}") => ({
  id,
  causeType: "message",
  causeData,
  stateSnapshot: JSON.stringify(state),
  checksum: `c${id}`,
  createdAt: id * 10,
});

function harness(respond: (url: URL) => Response | Promise<Response> = () => Response.json({ types: ["counter"] })) {
  const out: string[] = [];
  const err: string[] = [];
  const urls: URL[] = [];
  const io = {
    stdout: (s: string) => out.push(s),
    stderr: (s: string) => err.push(s),
    fetch: async (input: string | URL) => {
      const url = new URL(String(input));
      urls.push(url);
      return respond(url);
    },
  };
  return { out, err, urls, io };
}

describe("defined", () => {
  it("drops undefined keys and keeps every other value, null and falsy included", () => {
    expect(defined({ a: undefined, b: 0, c: "", d: null, e: false, f: "x" })).toStrictEqual({
      b: 0,
      c: "",
      d: null,
      e: false,
      f: "x",
    });
  });

  it("gives an empty object when everything is undefined", () => {
    expect(defined({ a: undefined })).toStrictEqual({});
  });
});

describe("actor-kit studio: argument validation", () => {
  it.each([
    ["5x", "--limit"],
    ["x5", "--limit"],
    ["0", "--limit"],
    ["1234567890123456", "--limit"],
  ])("rejects --limit %s with the flag's own message", async (value) => {
    const h = harness(() => Response.json({ actors: [] }));
    expect(await runCli(["studio", "list", "--limit", value], ENV, h.io)).toBe(2);
    expect(h.err.join("")).toBe(`--limit must be a positive integer\n\n${USAGE}`);
    expect(h.urls).toEqual([]);
  });

  it.each([
    ["1", "?limit=1"],
    ["12", "?limit=12"],
    ["123456789012345", "?limit=123456789012345"],
  ])("accepts --limit %s", async (value, search) => {
    const h = harness(() => Response.json({ actors: [] }));
    expect(await runCli(["studio", "list", "--limit", value], ENV, h.io)).toBe(0);
    expect(h.urls[0]?.search).toBe(search);
  });

  it("names --offset and --before in their errors", async () => {
    const h = harness(() => Response.json({ actors: [] }));
    expect(await runCli(["studio", "list", "--offset", "0"], ENV, h.io)).toBe(2);
    expect(h.err.join("")).toMatch(/^--offset must be a positive integer\n/);
    const t = harness(() => Response.json({ entries: [], hasMore: false }));
    expect(await runCli(["studio", "timeline", "c", "a", "--before", "z"], ENV, t.io)).toBe(2);
    expect(t.err.join("")).toMatch(/^--before must be a positive integer\n/);
    const l = harness(() => Response.json({ entries: [], hasMore: false }));
    expect(await runCli(["studio", "timeline", "c", "a", "--limit", "z"], ENV, l.io)).toBe(2);
    expect(l.err.join("")).toMatch(/^--limit must be a positive integer\n/);
  });

  it("list passes --offset alone and sends no query without options", async () => {
    const h = harness(() => Response.json({ actors: [] }));
    expect(await runCli(["studio", "list", "--offset", "4"], ENV, h.io)).toBe(0);
    expect(h.urls[0]?.search).toBe("?offset=4");
    const bare = harness(() => Response.json({ actors: [] }));
    expect(await runCli(["studio", "list"], ENV, bare.io)).toBe(0);
    expect(bare.urls[0]?.search).toBe("");
  });

  it.each([
    [["studio", "inspect"], "inspect"],
    [["studio", "inspect", "counter"], "inspect"],
    [["studio", "inspect", "counter", "a", "extra"], "inspect"],
    [["studio", "timeline", "counter"], "timeline"],
    [["studio", "view", "counter", "--role", "r"], "view"],
  ])("%j needs exactly <type> <id>", async (argv, command) => {
    const h = harness();
    expect(await runCli(argv, ENV, h.io)).toBe(2);
    expect(h.err.join("")).toBe(`Usage: actor-kit studio ${command} <type> <id>\n\n${USAGE}`);
    expect(h.urls).toEqual([]);
  });

  it("view without --role says so", async () => {
    const h = harness();
    expect(await runCli(["studio", "view", "c", "a"], ENV, h.io)).toBe(2);
    expect(h.err.join("")).toBe(`view needs --role <role>\n\n${USAGE}`);
  });

  it("view without --caller sends only the role", async () => {
    const h = harness(() =>
      Response.json({ type: "studio.view", role: "kid", caller: null, callerRole: null, data: { n: 1 } }),
    );
    expect(await runCli(["studio", "view", "c", "a", "--role", "kid"], ENV, h.io)).toBe(0);
    expect(h.urls[0]?.search).toBe("?role=kid");
    expect(JSON.parse(h.out.join(""))).toMatchObject({ data: { n: 1 } });
  });

  it("reports an unknown command by name", async () => {
    const h = harness();
    expect(await runCli(["studio", "toString"], ENV, h.io)).toBe(2);
    expect(h.err.join("")).toBe(`Unknown command "toString"\n\n${USAGE}`);
  });
});

describe("actor-kit studio: usage and help", () => {
  it("--help without the studio group is a usage error on stderr", async () => {
    const h = harness();
    expect(await runCli(["--help"], ENV, h.io)).toBe(2);
    expect(h.out).toEqual([]);
    expect(h.err.join("")).toBe(USAGE);
  });

  it("--help after a command still prints help to stdout and calls nothing", async () => {
    const h = harness();
    expect(await runCli(["studio", "types", "--help"], {}, h.io)).toBe(0);
    expect(h.out.join("")).toBe(USAGE);
    expect(h.err).toEqual([]);
    expect(h.urls).toEqual([]);
  });

  it("a group other than studio is a usage error", async () => {
    const h = harness();
    expect(await runCli(["other", "types"], ENV, h.io)).toBe(2);
    expect(h.err.join("")).toBe(USAGE);
    expect(h.out).toEqual([]);
    expect(h.urls).toEqual([]);
  });

  it("studio without a command is a usage error", async () => {
    const h = harness();
    expect(await runCli(["studio"], ENV, h.io)).toBe(2);
    expect(h.err.join("")).toBe(USAGE);
    expect(h.urls).toEqual([]);
  });

  it.each([{}, { ACTOR_KIT_STUDIO_URL: "" }])("asks for the Studio URL when it is missing (%j)", async (env) => {
    const h = harness();
    expect(await runCli(["studio", "types"], env, h.io)).toBe(2);
    expect(h.err.join("")).toBe(`Set ACTOR_KIT_STUDIO_URL or pass --url <worker origin>\n\n${USAGE}`);
  });

  it("checks the URL before the command name", async () => {
    const h = harness();
    expect(await runCli(["studio", "nope"], {}, h.io)).toBe(2);
    expect(h.err.join("")).toMatch(/^Set ACTOR_KIT_STUDIO_URL/);
  });
});

describe("actor-kit studio: output and errors", () => {
  it("prints pretty JSON with a trailing newline", async () => {
    const h = harness();
    expect(await runCli(["studio", "types"], ENV, h.io)).toBe(0);
    expect(h.out).toEqual([`${JSON.stringify(["counter"], null, 2)}\n`]);
  });

  it("timeline without --shape prints the full page", async () => {
    const page = { entries: [entry(1, { n: 1 })], hasMore: true };
    const h = harness(() => Response.json(page));
    expect(await runCli(["studio", "timeline", "c", "a"], ENV, h.io)).toBe(0);
    expect(JSON.parse(h.out.join(""))).toEqual(page);
    expect(h.urls[0]?.search).toBe("");
  });

  it("a TypeError without a parse code is a runtime error (exit 1), not a usage error", async () => {
    const h = harness(
      () =>
        new Response(
          new ReadableStream({
            pull() {
              throw new TypeError("stream broke");
            },
          }),
        ),
    );
    expect(await runCli(["studio", "types"], ENV, h.io)).toBe(1);
    expect(h.err.join("")).toBe("stream broke\n");
  });

  it("prints a non-Error failure as text", async () => {
    const h = harness(
      () =>
        new Response(
          new ReadableStream({
            pull() {
              throw "plain failure";
            },
          }),
        ),
    );
    expect(await runCli(["studio", "types"], ENV, h.io)).toBe(1);
    expect(h.err.join("")).toBe("plain failure\n");
  });

  it("uses the global fetch when io has none", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL) => {
      urls.push(String(input));
      return Response.json({ types: ["t"] });
    });
    const out: string[] = [];
    expect(await runCli(["studio", "types"], ENV, { stdout: (s) => out.push(s), stderr: () => {} })).toBe(0);
    expect(urls).toEqual(["https://game.example.com/__studio/api/actors/types"]);
    expect(JSON.parse(out.join(""))).toEqual(["t"]);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("studio client: default fetch and list parsing", () => {
  it("calls the global fetch with the request init when none is given", async () => {
    const inits: (RequestInit | undefined)[] = [];
    vi.stubGlobal("fetch", async (_input: string | URL, init?: RequestInit) => {
      inits.push(init);
      return Response.json({ types: [] });
    });
    const client = createStudioClient({ baseUrl: "https://g.example.com", auth: { kind: "access-token", token: "t" } });
    expect(await client.types()).toEqual([]);
    expect(inits[0]).toMatchObject({ redirect: "manual", headers: { "cf-access-token": "t" } });
  });

  it("rejects a list entry without an actor type and id", async () => {
    const client = createStudioClient({
      baseUrl: "https://g.example.com",
      auth: { kind: "none" },
      fetch: async () => Response.json({ actors: [{ lastSeen: 1 }] }),
    });
    await expect(client.list()).rejects.toThrow(/Malformed Studio response/);
  });

  it("keeps extra fields on list entries", async () => {
    const client = createStudioClient({
      baseUrl: "https://g.example.com",
      auth: { kind: "none" },
      fetch: async () => Response.json({ actors: [{ actorType: "t", actorId: "a", lastSeen: 1 }] }),
    });
    expect(await client.list()).toEqual([{ actorType: "t", actorId: "a", lastSeen: 1 }]);
  });
});

describe("timeline shape: structure", () => {
  it("compares arrays of different lengths index by index", () => {
    expect(changedPaths({ xs: [1] }, { xs: [1, 2, 3] })).toEqual(["xs.*"]);
    expect(changedPaths([], [])).toEqual([]);
  });

  it("does not report unchanged nested records", () => {
    expect(changedPaths({ a: { b: [{ c: 1 }] } }, { a: { b: [{ c: 1 }] } })).toEqual([]);
  });

  it("reports a record that became null as the node itself", () => {
    expect(changedPaths({ a: { b: 1 } }, { a: null })).toEqual(["a"]);
  });

  it("reads only own keys, so a parsed __proto__ key is compared as data", () => {
    const before: unknown = JSON.parse('{"__proto__":{"x":1}}');
    expect(changedPaths(before, {})).toEqual(["__proto__"]);
    expect(changedPaths({}, before)).toEqual(["__proto__"]);
  });

  it("keeps the shape key order: id, at, causeType, checksum, changedPaths, then cause names", () => {
    const [first] = timelineShape([entry(1, {}, JSON.stringify({ messageType: "M", input: { k: 1 } }))]);
    expect(Object.keys(first ?? {})).toEqual([
      "id",
      "at",
      "causeType",
      "checksum",
      "changedPaths",
      "messageType",
      "inputKeys",
    ]);
  });

  it("orders entries oldest first and diffs each against its predecessor", () => {
    const shape = timelineShape([entry(3, { n: 3, m: 1 }), entry(1, { n: 1, m: 0 }), entry(2, { n: 2, m: 0 })]);
    expect(shape.map((s) => [s.id, s.changedPaths])).toEqual([
      [1, []],
      [2, ["n"]],
      [3, ["m", "n"]],
    ]);
  });
});

describe("studio client: auth headers", () => {
  it("sends an empty header set in dev mode", async () => {
    const inits: (RequestInit | undefined)[] = [];
    const client = createStudioClient({
      baseUrl: "https://g.example.com",
      auth: { kind: "none" },
      fetch: async (_input, init) => {
        inits.push(init);
        return Response.json({ types: [] });
      },
    });
    await client.types();
    expect(inits[0]?.headers).toStrictEqual({});
  });
});
