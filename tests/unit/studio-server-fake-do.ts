/**
 * In-memory fake of the Durable Object storage pieces StudioRegistry touches:
 * `ctx.storage.sql.exec(query, ...bindings).toArray()` and `ctx.storage.transactionSync(fn)`,
 * backed by a real SQLite database (node:sqlite) so SQL semantics match the DO.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

type Row = Record<string, unknown>;

interface FakeCursor {
  toArray(): Row[];
  rowsRead: number;
  rowsWritten: number;
}

function isSqlInput(value: unknown): value is SQLInputValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    value instanceof Uint8Array
  );
}

/** Copy a node:sqlite row (null prototype) into a plain object, like the DO cursor returns. */
function plainRow(row: unknown): Row {
  const out: Row = {};
  if (typeof row === "object" && row !== null) {
    for (const [key, value] of Object.entries(row)) out[key] = value;
  }
  return out;
}

/**
 * DO `sql.exec` accepts several statements in one call and binds parameters to the last one
 * (workers-qb migrations rely on this). Statements are split on `;`, which is safe for the
 * registry's SQL (no `;` inside string literals).
 */
export function fakeSqlStorage(db: DatabaseSync) {
  return {
    exec(query: string, ...bindings: unknown[]): FakeCursor {
      const statements = query
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s !== "");
      const last = statements.pop() ?? "";
      for (const statement of statements) db.exec(statement);
      // Like the DO, only null, strings, numbers and bytes bind; undefined is an error.
      const params = bindings.map((b) => {
        if (!isSqlInput(b)) throw new TypeError(`Unsupported SQL binding: ${String(b)}`);
        return b;
      });
      const rows =
        last === ""
          ? []
          : db
              .prepare(last)
              .all(...params)
              .map(plainRow);
      return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 };
    },
  };
}

export function fakeDurableObjectState() {
  const db = new DatabaseSync(":memory:");
  const sql = fakeSqlStorage(db);
  const statements: string[] = [];
  const storage = {
    sql: {
      exec(query: string, ...bindings: unknown[]): FakeCursor {
        statements.push(query);
        return sql.exec(query, ...bindings);
      },
    },
    transactionSync<T>(fn: () => T): T {
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
  return { ctx: { storage }, db, statements };
}
