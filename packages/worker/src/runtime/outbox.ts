/**
 * Transactional outbox — collects emit() and request() calls during transitions.
 *
 * emit() = fire-and-forget side effect
 * request() = async with onDone/onError callback message names
 *
 * After transition, entries are persisted atomically with state (same SQLite tx).
 * Outbox is drained asynchronously. Failed entries retry with backoff.
 */

import type { Effect, NormalizedRequestConfig, RequestConfig } from "@actor-kit/core";
import { normalizeRequest } from "@actor-kit/core";

// --- Outbox entry ---

export interface OutboxEntry {
  id: string;
  type: "emit" | "request";
  payload: Effect;
  status: "pending" | "sent";
  attempts: number;
  onDone?: string;
  onError?: string;
  meta?: unknown;
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
  request(config: RequestConfig): void;
  getEmissions(): Effect[];
  getRequests(): NormalizedRequestConfig[];
  toEntries(): OutboxEntry[];
}

let idCounter = 0;

function generateId(): string {
  idCounter += 1;
  return `outbox-${Date.now()}-${idCounter}`;
}

export function createOutbox(): OutboxCollector {
  const emissions: Effect[] = [];
  const requests: RequestConfig[] = [];

  return {
    emit(effect: Effect): void {
      emissions.push(effect);
    },

    request(config: RequestConfig): void {
      requests.push(config);
    },

    getEmissions(): Effect[] {
      return [...emissions];
    },

    getRequests(): NormalizedRequestConfig[] {
      return requests.map(normalizeRequest);
    },

    toEntries(): OutboxEntry[] {
      const now = Date.now();
      const entries: OutboxEntry[] = [];

      for (const effect of emissions) {
        entries.push({
          id: generateId(),
          type: "emit",
          payload: effect,
          status: "pending",
          attempts: 0,
          createdAt: now,
        });
      }

      for (const config of requests) {
        const normalized = normalizeRequest(config);
        entries.push({
          id: generateId(),
          type: "request",
          payload: normalized.effect,
          status: "pending",
          attempts: 0,
          onDone: normalized.onDone,
          onError: normalized.onError,
          meta: normalized.meta,
          createdAt: now,
        });
      }

      return entries;
    },
  };
}
