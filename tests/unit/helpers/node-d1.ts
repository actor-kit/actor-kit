/**
 * A real SQLite (node:sqlite) behind the slice of Cloudflare's D1 API the projection uses:
 * `prepare(sql).bind(...).run() / .all()` and `batch(statements)` (one transaction, rolled back
 * when any statement fails, as D1 does). Lets @actor-kit/projection be unit- and mutation-tested
 * against real SQL without the Workers runtime.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export interface NodeD1Statement {
  bind(...values: unknown[]): NodeD1Statement;
  run(): Promise<{ success: true }>;
  all(): Promise<{ results: Record<string, unknown>[] }>;
}

export interface NodeD1 {
  prepare(query: string): NodeD1Statement;
  batch(statements: NodeD1Statement[]): Promise<Array<{ results: Record<string, unknown>[] }>>;
  /** Synchronous read for assertions. */
  rows(query: string, ...values: SQLInputValue[]): Record<string, unknown>[];
  /** Statements run so far (for asserting what a call wrote). */
  readonly executed: string[];
  close(): void;
}

function plain(row: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof row === "object" && row !== null) {
    for (const [k, v] of Object.entries(row)) out[k] = v;
  }
  return out;
}

function sqlValue(value: unknown): SQLInputValue {
  if (value === null || typeof value === "number" || typeof value === "string" || typeof value === "bigint") {
    return value;
  }
  throw new Error(`node-d1: cannot bind ${typeof value}`);
}

export function createNodeD1(): NodeD1 {
  const db = new DatabaseSync(":memory:");
  const executed: string[] = [];
  const known = new WeakMap<NodeD1Statement, { query: string; values: SQLInputValue[] }>();

  function exec(query: string, values: SQLInputValue[]): Record<string, unknown>[] {
    executed.push(query);
    return db
      .prepare(query)
      .all(...values)
      .map(plain);
  }

  function statement(query: string, values: SQLInputValue[]): NodeD1Statement {
    const stmt: NodeD1Statement = {
      bind: (...next) => statement(query, next.map(sqlValue)),
      run: async () => {
        exec(query, values);
        return { success: true };
      },
      all: async () => ({ results: exec(query, values) }),
    };
    known.set(stmt, { query, values });
    return stmt;
  }

  return {
    prepare: (query) => statement(query, []),
    batch: async (statements) => {
      db.exec("BEGIN");
      try {
        const results = statements.map((s) => {
          const parts = known.get(s);
          if (parts === undefined) throw new Error("node-d1: statement from another database");
          return { results: exec(parts.query, parts.values) };
        });
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    rows: (query, ...values) =>
      db
        .prepare(query)
        .all(...values)
        .map(plain),
    executed,
    close: () => db.close(),
  };
}
