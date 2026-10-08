/**
 * A real SQLite (node:sqlite) behind the slice of Cloudflare's SqlStorage the runtime uses:
 * `exec(query, ...bindings)` returning `{ toArray(), one() }`. Lets the runtime's SQL modules
 * be unit-tested (and mutation-tested) against real SQL without the Workers runtime.
 */
import { DatabaseSync } from "node:sqlite";

type Binding = string | number | null;

export interface NodeSql {
  exec(query: string, ...bindings: Binding[]): { toArray(): Record<string, unknown>[]; one(): Record<string, unknown> };
  transaction<T>(fn: () => T): T;
  close(): void;
}

function plain(row: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof row === "object" && row !== null) {
    for (const [k, v] of Object.entries(row)) out[k] = v;
  }
  return out;
}

export function createNodeSql(): NodeSql {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query, ...bindings) {
      const statements = query
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (statements.length > 1) {
        if (bindings.length > 0) throw new Error("node-sql: bindings with several statements");
        db.exec(query);
        return { toArray: () => [], one: () => ({}) };
      }
      const rows =
        statements.length === 0
          ? []
          : db
              .prepare(query)
              .all(...bindings)
              .map(plain);
      return {
        toArray: () => rows,
        one: () => {
          const [row] = rows;
          if (rows.length !== 1 || row === undefined) throw new Error(`Expected exactly one row, got ${rows.length}`);
          return row;
        },
      };
    },
    transaction(fn) {
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    close() {
      db.close();
    },
  };
}
