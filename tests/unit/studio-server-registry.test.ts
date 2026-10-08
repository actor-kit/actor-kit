/**
 * StudioRegistry DO against a real in-memory SQLite (node:sqlite) shaped like DO storage.
 * Only the `cloudflare:workers` base class is replaced: it just stores ctx and env.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioRegistry } from "../../packages/studio/src/registry";
import { fakeDurableObjectState } from "./studio-server-fake-do";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);

function setup() {
  const fake = fakeDurableObjectState();
  const registry = new StudioRegistry(fake.ctx, {});
  function rows() {
    return fake.db
      .prepare(
        "SELECT actor_type, actor_id, last_active_at, version, connection_count, do_id FROM actors ORDER BY actor_type, actor_id",
      )
      .all()
      .map((r) => ({ ...r }));
  }
  return { registry, rows, fake };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("migrations", () => {
  it("are not applied until first use, then once", async () => {
    const { registry, fake } = setup();
    expect(registry.migrated).toBe(false);
    expect(fake.statements).toEqual([]);

    expect(await registry.getActorTypes()).toEqual([]);
    expect(registry.migrated).toBe(true);
    const afterFirst = fake.statements.length;

    await registry.getActorTypes();
    expect(fake.statements.length).toBe(afterFirst + 1);
  });

  it("create the do_id column (0002) on a fresh database", async () => {
    const { registry, fake } = setup();
    registry.ensureMigrated();
    const columns = fake.db
      .prepare("SELECT name FROM pragma_table_info('actors') ORDER BY cid")
      .all()
      .map((r) => r["name"]);
    expect(columns).toEqual(["actor_type", "actor_id", "last_active_at", "version", "connection_count", "do_id"]);
  });

  it("records each migration by its stable name, so upgrades never re-run one", () => {
    const { registry, fake } = setup();
    registry.ensureMigrated();
    const names = fake.db
      .prepare("SELECT name FROM migrations ORDER BY id")
      .all()
      .map((r) => r["name"]);
    expect(names).toEqual(["0001_actors", "0002_actors_do_id"]);
  });

  it("is marked for runtime discovery through ctx.exports", () => {
    expect(StudioRegistry.__actorKitStudioRegistry).toBe(true);
  });
});

describe("touch", () => {
  it("registers a new actor with zero connections at the current time", () => {
    const { registry, rows } = setup();
    registry.touch("counter", "room", 3);
    expect(rows()).toEqual([
      {
        actor_type: "counter",
        actor_id: "room",
        last_active_at: 1_000,
        version: 3,
        connection_count: 0,
        do_id: null,
      },
    ]);
  });

  it("updates time and version of a known actor and keeps its connection count", () => {
    const { registry, rows } = setup();
    registry.touch("counter", "room", 1, undefined, HEX_A);
    registry.updateConnections("counter", "room", 4);
    vi.setSystemTime(2_000);
    registry.touch("counter", "room", 2);
    expect(rows()).toEqual([
      {
        actor_type: "counter",
        actor_id: "room",
        last_active_at: 2_000,
        version: 2,
        connection_count: 4,
        do_id: HEX_A,
      },
    ]);
  });

  it("replaces the stored DO id when a new one is given", () => {
    const { registry, rows } = setup();
    registry.touch("counter", "room", 1, undefined, HEX_A);
    registry.touch("counter", "room", 1, undefined, HEX_B);
    expect(rows()[0]?.["do_id"]).toBe(HEX_B);
  });

  it("re-keys from the previous id, carrying its connection count and DO id", () => {
    const { registry, rows } = setup();
    registry.touch("counter", HEX_A, 1, undefined, HEX_A);
    registry.updateConnections("counter", HEX_A, 2);
    registry.touch("other", HEX_A, 1);
    vi.setSystemTime(5_000);

    registry.touch("counter", "room", 1, HEX_A);

    expect(rows()).toEqual([
      {
        actor_type: "counter",
        actor_id: "room",
        last_active_at: 5_000,
        version: 1,
        connection_count: 2,
        do_id: HEX_A,
      },
      // Same id under another type is untouched.
      {
        actor_type: "other",
        actor_id: HEX_A,
        last_active_at: 1_000,
        version: 1,
        connection_count: 0,
        do_id: null,
      },
    ]);
  });

  it("an explicit DO id wins over the carried one when re-keying", () => {
    const { registry, rows } = setup();
    registry.touch("counter", "old", 1, undefined, HEX_A);
    registry.touch("counter", "room", 1, "old", HEX_B);
    expect(rows().map((r) => [r["actor_id"], r["do_id"]])).toEqual([["room", HEX_B]]);
  });

  it("re-keying from an unknown previous id registers fresh", () => {
    const { registry, rows } = setup();
    registry.touch("counter", "room", 1, "ghost");
    expect(rows()).toEqual([
      {
        actor_type: "counter",
        actor_id: "room",
        last_active_at: 1_000,
        version: 1,
        connection_count: 0,
        do_id: null,
      },
    ]);
  });

  it("a previous id equal to the current id keeps the row (no delete)", () => {
    const { registry, rows } = setup();
    registry.touch("counter", "room", 1, undefined, HEX_A);
    registry.updateConnections("counter", "room", 3);
    registry.touch("counter", "room", 2, "room");
    expect(rows()).toEqual([
      {
        actor_type: "counter",
        actor_id: "room",
        last_active_at: 1_000,
        version: 2,
        connection_count: 3,
        do_id: HEX_A,
      },
    ]);
  });

  it("re-keying is atomic: a failed insert keeps the previous row", () => {
    const { registry, rows, fake } = setup();
    registry.touch("counter", "old", 1);
    fake.db.exec(
      "CREATE TRIGGER no_room BEFORE INSERT ON actors WHEN NEW.actor_id = 'room' BEGIN SELECT RAISE(ABORT, 'nope'); END",
    );
    expect(() => registry.touch("counter", "room", 1, "old")).toThrow("nope");
    expect(rows().map((r) => r["actor_id"])).toEqual(["old"]);
  });

  it.each([
    ["empty type", ["", "room", 1]],
    ["empty id", ["counter", "", 1]],
    ["fractional version", ["counter", "room", 1.5]],
    ["empty previous id", ["counter", "room", 1, ""]],
    ["malformed DO id", ["counter", "room", 1, undefined, "not-hex"]],
  ] as const)("drops invalid input (%s) without throwing or writing", (_label, args) => {
    const { registry, fake } = setup();
    expect(() => registry.touch(...args)).not.toThrow();
    expect(fake.statements).toEqual([]);
    expect(registry.migrated).toBe(false);
  });
});

describe("updateConnections", () => {
  it("registers an unknown actor with a null version", () => {
    const { registry, rows } = setup();
    registry.updateConnections("counter", "room", 2, HEX_A);
    expect(rows()).toEqual([
      {
        actor_type: "counter",
        actor_id: "room",
        last_active_at: 1_000,
        version: null,
        connection_count: 2,
        do_id: HEX_A,
      },
    ]);
  });

  it("updates count and activity time of a known actor, keeping version and DO id", () => {
    const { registry, rows } = setup();
    registry.touch("counter", "room", 7, undefined, HEX_A);
    vi.setSystemTime(3_000);
    registry.updateConnections("counter", "room", 5);
    expect(rows()).toEqual([
      {
        actor_type: "counter",
        actor_id: "room",
        last_active_at: 3_000,
        version: 7,
        connection_count: 5,
        do_id: HEX_A,
      },
    ]);
  });

  it("replaces the DO id when a new one is given", () => {
    const { registry, rows } = setup();
    registry.updateConnections("counter", "room", 1, HEX_A);
    registry.updateConnections("counter", "room", 0, HEX_B);
    expect(rows().map((r) => [r["connection_count"], r["do_id"]])).toEqual([[0, HEX_B]]);
  });

  it.each([
    ["negative count", ["counter", "room", -1]],
    ["fractional count", ["counter", "room", 0.5]],
    ["empty type", ["", "room", 1]],
    ["malformed DO id", ["counter", "room", 1, "zz"]],
  ] as const)("drops invalid input (%s) without throwing or writing", (_label, args) => {
    const { registry, fake } = setup();
    expect(() => registry.updateConnections(...args)).not.toThrow();
    expect(fake.statements).toEqual([]);
    expect(registry.migrated).toBe(false);
  });
});

describe("listActors", () => {
  it("returns entries newest first with camelCase fields", async () => {
    const { registry } = setup();
    registry.touch("counter", "a", 1);
    vi.setSystemTime(2_000);
    registry.touch("chat", "b", 2);
    registry.updateConnections("chat", "b", 3);
    expect(await registry.listActors({})).toEqual([
      { actorType: "chat", actorId: "b", lastActiveAt: 2_000, version: 2, connectionCount: 3 },
      { actorType: "counter", actorId: "a", lastActiveAt: 1_000, version: 1, connectionCount: 0 },
    ]);
  });

  it("applies type, search, limit and offset", async () => {
    const { registry } = setup();
    for (const [i, id] of ["room-1", "room-2", "room-3", "lobby"].entries()) {
      vi.setSystemTime(1_000 + i);
      registry.touch("chat", id, 1);
    }
    registry.touch("counter", "room-9", 1);
    const ids = async (opts: Parameters<StudioRegistry["listActors"]>[0]) =>
      (await registry.listActors(opts)).map((e) => e.actorId);
    expect(await ids({ type: "chat", search: "room" })).toEqual(["room-3", "room-2", "room-1"]);
    expect(await ids({ type: "chat", search: "room", limit: 1, offset: 1 })).toEqual(["room-2"]);
  });

  it("rejects invalid options before touching storage", async () => {
    const { registry, fake } = setup();
    await expect(registry.listActors({ limit: -1 })).rejects.toThrow();
    expect(fake.statements).toEqual([]);
  });
});

describe("hasActor", () => {
  it("finds an actor by registered id or by DO hex id, within its type", async () => {
    const { registry } = setup();
    registry.touch("counter", "room", 1, undefined, HEX_A);
    expect(await registry.hasActor("counter", "room")).toBe(true);
    expect(await registry.hasActor("counter", HEX_A)).toBe(true);
    expect(await registry.hasActor("chat", "room")).toBe(false);
    expect(await registry.hasActor("counter", "ghost")).toBe(false);
  });

  it("is false for invalid input without touching storage", async () => {
    const { registry, fake } = setup();
    expect(await registry.hasActor("", "room")).toBe(false);
    expect(await registry.hasActor("counter", "")).toBe(false);
    expect(fake.statements).toEqual([]);
  });
});

describe("getActorTypes", () => {
  it("lists distinct types alphabetically", async () => {
    const { registry } = setup();
    registry.touch("counter", "a", 1);
    registry.touch("chat", "b", 1);
    registry.touch("counter", "c", 1);
    expect(await registry.getActorTypes()).toEqual(["chat", "counter"]);
  });
});

describe("reads on a fresh registry", () => {
  it("listActors migrates first and returns nothing", async () => {
    const { registry } = setup();
    expect(await registry.listActors({})).toEqual([]);
  });

  it("hasActor migrates first and finds nothing", async () => {
    const { registry } = setup();
    expect(await registry.hasActor("counter", "room")).toBe(false);
  });
});

describe("DO id validation", () => {
  it.each([
    ["64 lowercase hex", HEX_A, true],
    ["64 uppercase hex", HEX_A.toUpperCase(), true],
    ["a prefix before 64 hex", `zz${HEX_A}`, false],
    ["a suffix after 64 hex", `${HEX_A}zz`, false],
    ["63 hex", HEX_A.slice(1), false],
    ["one hex char", "a", false],
  ])("%s is %s", (_label, doId, accepted) => {
    const { registry, rows } = setup();
    registry.touch("counter", "room", 1);
    registry.touch("counter", "room", 1, undefined, doId);
    registry.updateConnections("counter", "room", 1, doId);
    expect(rows()[0]?.["do_id"]).toBe(accepted ? doId : null);
  });
});
