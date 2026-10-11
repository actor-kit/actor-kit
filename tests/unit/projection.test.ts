/**
 * ADR-019 E: @actor-kit/projection over real SQL (node:sqlite behind the D1 API). A batch of
 * published events is deduped and applied in `position` order per actor, each event atomically with
 * its cursor; an event that arrives before an earlier one is buffered until the gap fills; a failing
 * apply retries that actor's messages; rebuild() replays journals into a fresh read model with the
 * positions the live actors assigned.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type JournalSource, type ProjectionEvent, projection } from "../../packages/projection/src/index";
import { createNodeD1, type NodeD1 } from "./helpers/node-d1";

let db: NodeD1;
beforeEach(() => {
  db = createNodeD1();
  db.rows("CREATE TABLE log (actor_id TEXT, position INTEGER, name TEXT, n INTEGER)");
});
afterEach(() => db.close());

type Env = { DB: NodeD1 };
const env = (): Env => ({ DB: db });

function body(actorId: string, position: number, overrides: Record<string, unknown> = {}) {
  const seq = position + 1;
  return {
    actorType: "lot",
    actorId,
    seq,
    index: 0,
    name: "Placed",
    payload: { n: position * 10 },
    at: 100 + position,
    causationId: `lot/${actorId}/${seq}`,
    correlationId: `lot/${actorId}/${seq}`,
    idempotencyKey: `lot/${actorId}/${seq}:0`,
    position,
    ...overrides,
  };
}

interface FakeMessage {
  readonly id: string;
  readonly body: unknown;
  acked: number;
  retried: Array<{ delaySeconds?: number } | undefined>;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

function message(payload: unknown): FakeMessage {
  return {
    id: crypto.randomUUID(),
    body: payload,
    acked: 0,
    retried: [],
    ack() {
      this.acked++;
    },
    retry(options) {
      this.retried.push(options);
    },
  };
}

function batch(...messages: FakeMessage[]) {
  return { queue: "lot-events", messages };
}

const seen: ProjectionEvent[] = [];
beforeEach(() => {
  seen.length = 0;
});

function logInsert(target: NodeD1, event: ProjectionEvent) {
  const n = typeof event.payload === "object" && event.payload !== null ? Reflect.get(event.payload, "n") : null;
  return target
    .prepare("INSERT INTO log (actor_id, position, name, n) VALUES (?, ?, ?, ?)")
    .bind(event.actorId, event.position, event.name, typeof n === "number" ? n : null);
}

const vias: string[] = [];
beforeEach(() => {
  vias.length = 0;
});

/** Built per test, not at module load, so a constructor that throws fails the test that uses it. */
let lots: ReturnType<typeof makeLots>;
function makeLots() {
  return projection({
    queue: "lot-events",
    db: (e: Env) => e.DB,
    apply: (event, { db: target, via }) => {
      seen.push(event);
      vias.push(via);
      return event.name === "Placed" ? [logInsert(target, event)] : [];
    },
    reset: ({ db: target }) => [target.prepare("DELETE FROM log")],
  });
}
beforeEach(() => {
  lots = makeLots();
});

const log = () => db.rows("SELECT actor_id, position, n FROM log ORDER BY actor_id, position");

describe("projection().queue", () => {
  it("applies a batch in order, passing the event without its delivery fields", async () => {
    const messages = [message(body("a", 1)), message(body("a", 2))];
    await lots.queue(batch(...messages), env());
    expect(log()).toEqual([
      { actor_id: "a", position: 1, n: 10 },
      { actor_id: "a", position: 2, n: 20 },
    ]);
    expect(seen[0]).toEqual({
      actorType: "lot",
      actorId: "a",
      seq: 2,
      position: 1,
      name: "Placed",
      payload: { n: 10 },
      at: 101,
      causationId: "lot/a/2",
      correlationId: "lot/a/2",
    });
    expect(vias).toEqual(["queue", "queue"]);
    expect(messages.map((m) => [m.acked, m.retried.length])).toEqual([
      [1, 0],
      [1, 0],
    ]);
  });

  it("applies each event once: duplicates in a batch and redeliveries are acked, not applied", async () => {
    await lots.queue(batch(message(body("a", 1)), message(body("a", 1)), message(body("a", 2))), env());
    const again = message(body("a", 2));
    await lots.queue(batch(again, message(body("a", 1))), env());
    expect(log().map((r) => r["position"])).toEqual([1, 2]);
    expect(seen.map((e) => e.position)).toEqual([1, 2]);
    expect(again.acked).toBe(1);
  });

  it("reorders within a batch", async () => {
    await lots.queue(batch(message(body("a", 3)), message(body("a", 1)), message(body("a", 2))), env());
    expect(log().map((r) => r["position"])).toEqual([1, 2, 3]);
  });

  it("buffers an event that arrives before an earlier one, and applies both when the gap fills", async () => {
    const early = message(body("a", 2));
    await lots.queue(batch(early), env());
    expect(log()).toEqual([]);
    expect(early.acked).toBe(1);
    expect(await lots.buffered(env())).toEqual([{ actorType: "lot", actorId: "a", applied: 0, next: 2, count: 1 }]);

    await lots.queue(batch(message(body("a", 1))), env());
    expect(log().map((r) => r["position"])).toEqual([1, 2]);
    expect(await lots.buffered(env())).toEqual([]);
  });

  it("keeps actors independent", async () => {
    await lots.queue(batch(message(body("b", 1)), message(body("a", 2)), message(body("a", 1))), env());
    await lots.queue(batch(message(body("b", 3))), env());
    expect(log().map((r) => [r["actor_id"], r["position"]])).toEqual([
      ["a", 1],
      ["a", 2],
      ["b", 1],
    ]);
    expect(await lots.buffered(env())).toEqual([{ actorType: "lot", actorId: "b", applied: 1, next: 3, count: 1 }]);
  });

  it("accepts long actor ids and rejects empty ones", async () => {
    await lots.queue(batch(message(body("room-42", 1))), env());
    const empty = message(body("", 1));
    const noType = message(body("x", 1, { actorType: "" }));
    await lots.queue(batch(empty, noType), env());
    expect(log().map((r) => r["actor_id"])).toEqual(["room-42"]);
    expect([empty.retried.length, noType.retried.length]).toEqual([1, 1]);
  });

  it("keeps actor types apart even with the same id", async () => {
    await lots.queue(batch(message(body("a", 1)), message(body("a", 1, { actorType: "auction" }))), env());
    expect(seen.map((e) => e.actorType)).toEqual(["lot", "auction"]);
  });

  it("advances past events apply ignores", async () => {
    await lots.queue(batch(message(body("a", 1, { name: "Noted" })), message(body("a", 2))), env());
    expect(log().map((r) => r["position"])).toEqual([2]);
    expect(await lots.buffered(env())).toEqual([]);
  });

  it("retries a message whose body is not a published event, and still applies the rest", async () => {
    const bad = message({ hello: "world" });
    const good = message(body("a", 1));
    await lots.queue(batch(bad, good), env());
    expect(bad.retried).toEqual([undefined]);
    expect(bad.acked).toBe(0);
    expect(good.acked).toBe(1);
    expect(log()).toHaveLength(1);
  });

  it.each([
    ["position", 0],
    ["position", 1.5],
    ["seq", "x"],
  ])("rejects %s %j", async (field, value) => {
    const bad = message(body("a", 1, { [field]: value }));
    await lots.queue(batch(bad), env());
    expect(bad.retried).toHaveLength(1);
  });

  it("retries one actor's messages with a delay when apply fails, without touching its cursor", async () => {
    let fail = true;
    const flaky = projection({
      queue: "lot-events",
      db: (e: Env) => e.DB,
      retryDelaySeconds: 7,
      apply: (event, { db: target }) => {
        if (fail && event.actorId === "a") throw new Error("read model down");
        return [logInsert(target, event)];
      },
    });
    const a = message(body("a", 1));
    const b = message(body("b", 1));
    await flaky.queue(batch(a, b), env());
    expect(a.retried).toEqual([{ delaySeconds: 7 }]);
    expect(a.acked).toBe(0);
    expect(b.acked).toBe(1);
    expect(log().map((r) => r["actor_id"])).toEqual(["b"]);

    fail = false;
    await flaky.queue(batch(message(body("a", 1))), env());
    expect(log().map((r) => r["actor_id"])).toEqual(["a", "b"]);
  });

  it("writes an event's read-model rows and its cursor together: a failing statement applies neither", async () => {
    const broken = projection({
      queue: "lot-events",
      db: (e: Env) => e.DB,
      apply: (_event, { db: target }) => [target.prepare("INSERT INTO missing_table VALUES (1)")],
    });
    const m = message(body("a", 1));
    await broken.queue(batch(m), env());
    expect(m.retried).toEqual([{ delaySeconds: 5 }]);
    await lots.queue(batch(message(body("a", 1))), env());
    expect(log().map((r) => r["position"])).toEqual([1]);
  });

  it("stops quietly when another consumer applied the same event first", async () => {
    let raced = false;
    const racer = projection({
      queue: "lot-events",
      db: (e: Env) => e.DB,
      apply: async (event, { db: target }) => {
        if (!raced) {
          raced = true;
          // Another consumer commits the same position while this one prepares its statements.
          await lots.queue(batch(message(body(event.actorId, event.position))), env());
        }
        return [logInsert(target, event)];
      },
    });
    const m = message(body("a", 1));
    await racer.queue(batch(m), env());
    expect(m.acked).toBe(1);
    expect(log().map((r) => r["position"])).toEqual([1]);
  });

  it("starts over from the new cursor when another consumer committed an event first", async () => {
    let raced = false;
    const racer = projection({
      queue: "lot-events",
      db: (e: Env) => e.DB,
      apply: (event, { db: target }) => {
        if (!raced) {
          raced = true;
          // Another consumer committed position 1 (its batch did not hold position 2).
          db.rows(
            "INSERT INTO actor_kit_projection_cursor (actor_type, actor_id, position, seq) VALUES ('lot', 'a', 1, 2)",
          );
          db.rows("INSERT INTO log (actor_id, position, name, n) VALUES ('a', 1, 'Placed', 10)");
        }
        return [logInsert(target, event)];
      },
    });
    await racer.queue(batch(message(body("a", 1)), message(body("a", 2))), env());
    expect(log().map((r) => r["position"])).toEqual([1, 2]);
    expect(await racer.buffered(env())).toEqual([]);
  });

  it("refuses a batch from another queue", async () => {
    await expect(lots.queue({ queue: "other", messages: [] }, env())).rejects.toThrow(
      'projection for queue "lot-events" got a batch from "other"',
    );
  });

  it("handles() names its queue", () => {
    expect(lots.handles({ queue: "lot-events" })).toBe(true);
    expect(lots.handles({ queue: "other" })).toBe(false);
  });
});

describe("projection options", () => {
  it.each(["", "1abc", "has space", "drop;table"])("rejects the table name %j", (table) => {
    expect(() => projection({ queue: "q", table, db: (e: Env) => e.DB, apply: () => [] })).toThrow(
      `projection: table "${table}" must be a SQL identifier`,
    );
  });

  it("keeps its bookkeeping in actor_kit_projection_* tables by default", async () => {
    await projection({ queue: "lot-events", db: (e: Env) => e.DB, apply: () => [] }).queue(
      batch(message(body("a", 1))),
      env(),
    );
    const tables = db.rows(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'actor_kit%' ORDER BY name",
    );
    expect(tables).toEqual([{ name: "actor_kit_projection_buffer" }, { name: "actor_kit_projection_cursor" }]);
  });

  it.each(["_x", "Bids2", "a"])("accepts the table name %j", (table) => {
    expect(() => projection({ queue: "q", table, db: (e: Env) => e.DB, apply: () => [] })).not.toThrow();
  });

  it("keeps its bookkeeping in tables named after `table`", async () => {
    const custom = projection({ queue: "lot-events", table: "bids_proj", db: (e: Env) => e.DB, apply: () => [] });
    await custom.queue(batch(message(body("a", 1))), env());
    const tables = db.rows(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'bids_proj%' ORDER BY name",
    );
    expect(tables).toEqual([{ name: "bids_proj_buffer" }, { name: "bids_proj_cursor" }]);
  });

  it("prunes cursor rows far behind the newest", async () => {
    const quiet = projection({ queue: "lot-events", db: (e: Env) => e.DB, apply: () => [], keepCursorRows: 2 });
    await quiet.queue(batch(...[1, 2, 3, 4, 5].map((p) => message(body("a", p)))), env());
    expect(db.rows("SELECT position FROM actor_kit_projection_cursor ORDER BY position")).toEqual([
      { position: 3 },
      { position: 4 },
      { position: 5 },
    ]);
  });
});

/** A journal source over fixed pages, recording each query. */
function journalOf(entries: Record<string, ReturnType<typeof entry>[]>) {
  const queries: unknown[] = [];
  const source: JournalSource = {
    async journal(actorType, actorId, query) {
      queries.push([actorType, actorId, query]);
      const all = entries[`${actorType}/${actorId}`] ?? [];
      const rest = all.filter((e) => e.seq >= query.from);
      return { entries: rest.slice(0, query.limit), hasMore: rest.length > query.limit };
    },
  };
  return { source, queries };
}

function entry(
  actorId: string,
  seq: number,
  emitted: Array<{ name: string; payload: unknown; published: boolean }> = [],
  causeType = seq === 1 ? "init" : "message",
) {
  return {
    id: `lot/${actorId}/${seq}`,
    seq,
    causeType,
    emitted,
    correlationId: seq === 4 ? `lot/${actorId}/3` : `lot/${actorId}/${seq}`,
    createdAt: 1000 + seq,
  };
}

const placed = (n: number) => ({ name: "Placed", payload: { n }, published: true });
const noted = { name: "Noted", payload: {}, published: false };

describe("projection().rebuild", () => {
  const journal = {
    "lot/a": [
      entry("a", 1),
      entry("a", 2, [noted, placed(1)]),
      entry("a", 3, [noted]),
      entry("a", 4, [placed(2), placed(3)]),
      entry("a", 5, [], "restore"),
      entry("a", 6, [placed(4)]),
    ],
    "lot/b": [entry("b", 1), entry("b", 2, [placed(9)])],
  };

  it("resets the read model and replays published events with the live positions", async () => {
    await lots.queue(batch(message(body("z", 1))), env());
    const { source } = journalOf(journal);
    const result = await lots.rebuild(env(), {
      source,
      actors: [
        { actorType: "lot", actorId: "a" },
        { actorType: "lot", actorId: "b" },
      ],
    });
    expect(result).toEqual({ actors: 2, events: 5 });
    expect(log()).toEqual([
      { actor_id: "a", position: 1, n: 1 },
      { actor_id: "a", position: 2, n: 2 },
      { actor_id: "a", position: 3, n: 3 },
      { actor_id: "a", position: 4, n: 4 },
      { actor_id: "b", position: 1, n: 9 },
    ]);
    expect(seen.at(-3)).toEqual({
      actorType: "lot",
      actorId: "a",
      seq: 4,
      position: 3,
      name: "Placed",
      payload: { n: 3 },
      at: 1004,
      causationId: "lot/a/4",
      correlationId: "lot/a/3",
    });
  });

  it("forgets earlier cursors and buffered events, and tells apply it is a rebuild", async () => {
    await lots.queue(batch(message(body("z", 1)), message(body("z", 3))), env());
    const { source } = journalOf(journal);
    vias.length = 0;
    await lots.rebuild(env(), { source, actors: [{ actorType: "lot", actorId: "b" }] });
    expect(vias).toEqual(["rebuild"]);
    expect(await lots.buffered(env())).toEqual([]);
    await lots.queue(batch(message(body("z", 1))), env());
    expect(log().map((r) => [r["actor_id"], r["position"]])).toEqual([
      ["b", 1],
      ["z", 1],
    ]);
  });

  it("rebuilds without a reset option (the read model is emptied by the caller)", async () => {
    const plain = projection({ queue: "lot-events", db: (e: Env) => e.DB, apply: () => [] });
    const { source } = journalOf(journal);
    expect(await plain.rebuild(env(), { source, actors: [{ actorType: "lot", actorId: "b" }] })).toEqual({
      actors: 1,
      events: 1,
    });
  });

  it("leaves the cursors where live consumption continues", async () => {
    const { source } = journalOf(journal);
    await lots.rebuild(env(), { source, actors: [{ actorType: "lot", actorId: "a" }] });
    await lots.queue(batch(message(body("a", 4)), message(body("a", 5))), env());
    expect(log().map((r) => r["position"])).toEqual([1, 2, 3, 4, 5]);
  });

  it("pages through the journal oldest first", async () => {
    const long = { "lot/a": [entry("a", 1), ...Array.from({ length: 5 }, (_, i) => entry("a", i + 2, [placed(i)]))] };
    const { source, queries } = journalOf(long);
    const result = await lots.rebuild(env(), { source, actors: [{ actorType: "lot", actorId: "a" }], pageSize: 2 });
    expect(result.events).toBe(5);
    expect(queries).toEqual([
      ["lot", "a", { order: "asc", from: 1, limit: 2 }],
      ["lot", "a", { order: "asc", from: 3, limit: 2 }],
      ["lot", "a", { order: "asc", from: 5, limit: 2 }],
    ]);
  });

  it("refuses a journal that does not start at init (pruned) or is empty (journal off)", async () => {
    const pruned = journalOf({ "lot/a": [entry("a", 3, [placed(1)])] });
    await expect(
      lots.rebuild(env(), { source: pruned.source, actors: [{ actorType: "lot", actorId: "a" }] }),
    ).rejects.toThrow("rebuild: the journal of lot/a starts at seq 3 (message), not init: it was pruned");
    const empty = journalOf({});
    await expect(
      lots.rebuild(env(), { source: empty.source, actors: [{ actorType: "lot", actorId: "a" }] }),
    ).rejects.toThrow("rebuild: lot/a has no journal entries (journal off, or never spawned)");
  });

  it("accepts actors as an async iterable", async () => {
    const { source } = journalOf(journal);
    async function* actors() {
      yield { actorType: "lot", actorId: "b" };
    }
    expect(await lots.rebuild(env(), { source, actors: actors() })).toEqual({ actors: 1, events: 1 });
  });

  it("rejects a malformed journal page", async () => {
    const source: JournalSource = { journal: async () => ({ entries: [{ seq: "x" }], hasMore: false }) };
    await expect(lots.rebuild(env(), { source, actors: [{ actorType: "lot", actorId: "a" }] })).rejects.toThrow(
      "rebuild: malformed journal page for lot/a",
    );
  });
});
