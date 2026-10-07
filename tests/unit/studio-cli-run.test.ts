import { describe, expect, it } from "vitest";
import { runCli } from "../../packages/studio-cli/src/cli";

const timelineEntry = {
  id: 1,
  causeType: "message",
  causeData: JSON.stringify({ messageType: "JOIN", payload: { name: "Juneau" } }),
  stateSnapshot: JSON.stringify({ n: 1 }),
  checksum: "c1",
  createdAt: 5,
};

function harness(respond: (url: URL) => Response = () => Response.json({ types: ["counter"] })) {
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

const ENV = { ACTOR_KIT_STUDIO_URL: "https://game.example.com" };

describe("actor-kit studio", () => {
  it("prints usage and exits 2 without a command", async () => {
    const h = harness();
    expect(await runCli([], ENV, h.io)).toBe(2);
    expect(h.err.join("")).toContain("actor-kit studio");
  });

  it("prints usage and exits 0 for --help", async () => {
    const h = harness();
    expect(await runCli(["studio", "--help"], ENV, h.io)).toBe(0);
    expect(h.out.join("")).toMatch(/inspect.*timeline.*view/s);
  });

  it("types: prints JSON", async () => {
    const h = harness();
    expect(await runCli(["studio", "types"], ENV, h.io)).toBe(0);
    expect(JSON.parse(h.out.join(""))).toEqual(["counter"]);
  });

  it("inspect <type> <id>", async () => {
    const h = harness(() => Response.json({ initialized: true, state: { n: 1 } }));
    expect(await runCli(["studio", "inspect", "counter", "a"], ENV, h.io)).toBe(0);
    expect(h.urls[0]?.pathname).toBe("/__studio/api/actors/counter/a");
    expect(JSON.parse(h.out.join(""))).toMatchObject({ state: { n: 1 } });
  });

  it("timeline --limit --before", async () => {
    const h = harness(() => Response.json({ entries: [timelineEntry], hasMore: false }));
    expect(await runCli(["studio", "timeline", "counter", "a", "--limit", "5", "--before", "9"], ENV, h.io)).toBe(0);
    expect(h.urls[0]?.search).toBe("?limit=5&before=9");
  });

  it("timeline --shape prints only shape, never values", async () => {
    const h = harness(() => Response.json({ entries: [timelineEntry], hasMore: false }));
    expect(await runCli(["studio", "timeline", "counter", "a", "--shape"], ENV, h.io)).toBe(0);
    const printed = h.out.join("");
    expect(printed).not.toContain("Juneau");
    expect(JSON.parse(printed)).toEqual([
      {
        id: 1,
        at: 5,
        causeType: "message",
        messageType: "JOIN",
        payloadKeys: ["name"],
        checksum: "c1",
        changedPaths: [],
      },
    ]);
  });

  it("view --role --caller", async () => {
    const h = harness(() =>
      Response.json({ type: "studio.view", role: "kid", caller: "u", callerRole: "kid", data: {} }),
    );
    expect(await runCli(["studio", "view", "counter", "a", "--role", "kid", "--caller", "u"], ENV, h.io)).toBe(0);
    expect(h.urls[0]?.search).toBe("?role=kid&caller=u");
  });

  it("list --type --search --limit", async () => {
    const h = harness(() => Response.json({ actors: [] }));
    expect(await runCli(["studio", "list", "--type", "counter", "--search", "r", "--limit", "3"], ENV, h.io)).toBe(0);
    expect(h.urls[0]?.search).toBe("?type=counter&search=r&limit=3");
  });

  it("--url overrides ACTOR_KIT_STUDIO_URL", async () => {
    const h = harness();
    await runCli(["studio", "types", "--url", "http://localhost:8787"], ENV, h.io);
    expect(h.urls[0]?.origin).toBe("http://localhost:8787");
  });

  it.each([
    [["studio", "types"], {}, /ACTOR_KIT_STUDIO_URL/],
    [["studio", "inspect", "counter"], ENV, /inspect <type> <id>/],
    [["studio", "view", "counter", "a"], ENV, /--role/],
    [["studio", "timeline", "c", "a", "--limit", "x"], ENV, /--limit/],
    [["studio", "nope"], ENV, /Unknown command/],
    [["studio", "types", "--bogus"], ENV, /bogus/],
  ])("usage error %j exits 2", async (argv, env, message) => {
    const h = harness();
    expect(await runCli(argv, env, h.io)).toBe(2);
    expect(h.err.join("")).toMatch(message);
  });

  it("server errors exit 1 with the message", async () => {
    const h = harness(() => Response.json({ error: "Actor not found" }, { status: 404 }));
    expect(await runCli(["studio", "inspect", "c", "a"], ENV, h.io)).toBe(1);
    expect(h.err.join("")).toContain("404: Actor not found");
  });

  it("never prints the service token secret", async () => {
    const h = harness(() => Response.json({ error: "nope" }, { status: 403 }));
    const env = { ...ENV, CF_ACCESS_CLIENT_ID: "id", CF_ACCESS_CLIENT_SECRET: "super-secret-value" };
    await runCli(["studio", "types"], env, h.io);
    expect([...h.out, ...h.err].join("")).not.toContain("super-secret-value");
  });
});
