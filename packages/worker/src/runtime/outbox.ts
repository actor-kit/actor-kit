/**
 * Transactional outbox — collects emit() calls during transitions.
 *
 * After transition, entries are persisted atomically with state (same SQLite tx).
 * Outbox is drained asynchronously — only Queue effects are delivered.
 * Failed entries retry with backoff.
 */

import type { Effect } from "@actor-kit/core";

// --- Outbox entry ---

export interface OutboxEntry {
  id: string;
  payload: Effect;
  status: "pending" | "sent";
  attempts: number;
  createdAt: number;
}

// --- Storage interface (implemented by SQLite in runtime, fakes in tests) ---

export interface OutboxStorage {
  insertEntries(entries: OutboxEntry[]): void;
  getPending(): OutboxEntry[];
  markSent(id: string): void;
  incrementAttempts(id: string): void;
  moveToFailures(id: string): void;
}

// --- Outbox collector (used during a transition) ---

interface OutboxCollector {
  emit(effect: Effect): void;
  getEmissions(): Effect[];
  toEntries(): OutboxEntry[];
}

let idCounter = 0;

function generateId(): string {
  idCounter += 1;
  return `outbox-${Date.now()}-${idCounter}`;
}

export function createOutbox(): OutboxCollector {
  const emissions: Effect[] = [];

  return {
    emit(effect: Effect): void {
      emissions.push(effect);
    },

    getEmissions(): Effect[] {
      return [...emissions];
    },

    toEntries(): OutboxEntry[] {
      const now = Date.now();
      return emissions.map((effect) => ({
        id: generateId(),
        payload: effect,
        status: "pending" as const,
        attempts: 0,
        createdAt: now,
      }));
    },
  };
}
