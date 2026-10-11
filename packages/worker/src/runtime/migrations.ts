/**
 * The actor's SQLite schema, as workers-qb migrations (tracked in `_qb_migrations`).
 * Append new migrations — never edit existing ones.
 */

import { JOURNAL_MIGRATION_SQL } from "./journal";

export const ACTOR_KIT_MIGRATIONS: ReadonlyArray<{ readonly name: string; readonly sql: string }> = [
  {
    name: "0001_initial_schema",
    sql: `
      CREATE TABLE IF NOT EXISTS actor_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER,
        state TEXT,
        state_tracker TEXT,
        actor_id TEXT,
        checksum TEXT,
        updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        type TEXT,
        payload TEXT,
        status TEXT DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        created_at INTEGER
      );
    `,
  },
  {
    name: "0002_outbox_indexes",
    sql: `
      CREATE INDEX IF NOT EXISTS idx_outbox_status_created ON outbox(status, created_at);
    `,
  },
  {
    name: "0003_executions",
    sql: `
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        service TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        created_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_executions_status ON executions(status, created_at);
    `,
  },
  {
    name: "0004_links",
    sql: `
      CREATE TABLE IF NOT EXISTS active_links (
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        link_name TEXT NOT NULL,
        version INTEGER DEFAULT 0,
        created_at INTEGER,
        PRIMARY KEY (target_type, target_id, link_name)
      );
      CREATE TABLE IF NOT EXISTS link_subscribers (
        subscriber_type TEXT NOT NULL,
        subscriber_id TEXT NOT NULL,
        subscribed_at INTEGER,
        PRIMARY KEY (subscriber_type, subscriber_id)
      );
    `,
  },
  {
    name: "0005_forwards",
    sql: `
      CREATE TABLE IF NOT EXISTS forwards (
        id TEXT PRIMARY KEY,
        link_name TEXT NOT NULL,
        target_id TEXT NOT NULL,
        message TEXT NOT NULL,
        caller TEXT NOT NULL,
        caller_type TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        created_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_forwards_status_created ON forwards(status, created_at);
    `,
  },
  {
    name: "0006_timeline",
    sql: `
      CREATE TABLE IF NOT EXISTS timeline (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cause_type TEXT NOT NULL,
        cause_data TEXT NOT NULL,
        state_snapshot TEXT NOT NULL,
        checksum TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_timeline_created ON timeline(created_at DESC);
    `,
  },
  {
    name: "0007_studio_connections",
    sql: `
      CREATE TABLE IF NOT EXISTS studio_connections (
        caller TEXT NOT NULL,
        caller_type TEXT NOT NULL,
        connected_at INTEGER NOT NULL,
        PRIMARY KEY (caller, caller_type)
      );
    `,
  },
  {
    // Connections are read from the sockets the DO holds (exact across
    // hibernation and restart); this persisted copy went stale on restart and
    // merged two sockets of the same caller into one row.
    name: "0008_drop_studio_connections",
    sql: "DROP TABLE IF EXISTS studio_connections;",
  },
  {
    // Append-only event journal + checkpoints (ADR-013).
    name: "0009_journal",
    sql: JOURNAL_MIGRATION_SQL,
  },
  {
    // Effect ids are seq:index (ADR-015 D1); executions and forwards sort by (seq, idx) as integers.
    // Retries: rows wait as `retrying` until next_attempt_at; the last error is kept for Studio.
    // snapshots.last_seq numbers transitions (also with journal: false), seeded from the journal.
    name: "0010_effect_ids_and_retries",
    sql: `
      ALTER TABLE executions ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE executions ADD COLUMN idx INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE executions ADD COLUMN next_attempt_at INTEGER;
      ALTER TABLE executions ADD COLUMN last_error TEXT;
      CREATE INDEX IF NOT EXISTS idx_executions_due ON executions(status, next_attempt_at);
      ALTER TABLE forwards ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE forwards ADD COLUMN idx INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE snapshots ADD COLUMN last_seq INTEGER NOT NULL DEFAULT 0;
      UPDATE snapshots SET last_seq = COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'events'), 0);
    `,
  },
  {
    // Durable timers (ADR-015 D2): one row per pending timer, keyed by its effect id; `key` is unique
    // (scheduling an existing key replaces it). Fired and cancelled timers are deleted.
    name: "0011_timers",
    sql: `
      CREATE TABLE IF NOT EXISTS timers (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        idx INTEGER NOT NULL,
        name TEXT NOT NULL,
        key TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        fire_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_timers_due ON timers(fire_at, seq, idx);
    `,
  },
  {
    // Restore (ADR-015 D3): checkpoints keep the timers pending at their seq, and Studio timeline
    // rows carry the journal seq they recorded (for "restore to here").
    name: "0012_restore",
    sql: `
      ALTER TABLE journal_checkpoints ADD COLUMN timers TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE timeline ADD COLUMN seq INTEGER;
    `,
  },
  {
    // Forwards retry like executions: `retrying` rows wait until next_attempt_at; the last error is
    // kept for Studio and dead letters.
    name: "0013_forward_retries",
    sql: `
      ALTER TABLE forwards ADD COLUMN next_attempt_at INTEGER;
      ALTER TABLE forwards ADD COLUMN last_error TEXT;
      CREATE INDEX IF NOT EXISTS idx_forwards_due ON forwards(status, next_attempt_at);
    `,
  },
  {
    // Typed service errors (ADR-016 §2): the `_tag` of the last error, shown in Studio's outbox.
    name: "0014_last_error_tag",
    sql: `
      ALTER TABLE executions ADD COLUMN last_error_tag TEXT;
      ALTER TABLE forwards ADD COLUMN last_error_tag TEXT;
    `,
  },
  {
    // One history (ADR-017 §5): Studio's timeline is read from the journal; its own table goes.
    name: "0015_drop_timeline",
    sql: "DROP TABLE IF EXISTS timeline;",
  },
  {
    // Causation and correlation ids on every journal event (ADR-017 §4). NULL for older rows.
    name: "0016_trace_ids",
    sql: `
      ALTER TABLE events ADD COLUMN correlation_id TEXT;
      ALTER TABLE events ADD COLUMN causation_id TEXT;
    `,
  },
  {
    // Domain events a transition emitted (ADR-017 §2): a JSON array, NULL when none.
    name: "0017_emitted",
    sql: "ALTER TABLE events ADD COLUMN emitted TEXT;",
  },
  {
    // Rejections (ADR-018 F): refused messages, outside the journal; the newest rows and a count per code.
    name: "0018_rejections",
    sql: `
      CREATE TABLE IF NOT EXISTS rejections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL,
        message_name TEXT NOT NULL,
        caller TEXT NOT NULL,
        caller_type TEXT NOT NULL,
        role TEXT,
        payload_hash TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rejection_counts (
        code TEXT PRIMARY KEY,
        count INTEGER NOT NULL
      );
    `,
  },
  {
    // A transition whose handler read the clock or randomness directly (ADR-018 E): 1, NULL otherwise.
    name: "0019_nondeterministic",
    sql: "ALTER TABLE events ADD COLUMN nondeterministic INTEGER;",
  },
  {
    // Journal segments archived to R2 before pruning (ADR-019 D): one row per segment.
    name: "0020_journal_archive",
    sql: `
      CREATE TABLE IF NOT EXISTS journal_archive (
        from_seq INTEGER PRIMARY KEY,
        to_seq INTEGER NOT NULL,
        key TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        archived_at INTEGER NOT NULL
      );
    `,
  },
];
