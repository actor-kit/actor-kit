/**
 * Transactional outbox — collects execute() calls during transitions.
 *
 * After transition, execution entries are available for test assertions.
 * Runtime services (when implemented) will persist and replay them.
 */

import type { Execution, ForwardCall } from "@actor-kit/core";

export type { ForwardCall };

// --- Execution entry ---

export interface ExecutionEntry {
  id: string;
  service: string;
  payload: unknown;
  status: "pending" | "running" | "done" | "failed";
  attempts: number;
  createdAt: number;
}

// --- Link tracking types ---

export interface LinkCall {
  readonly name: string;
  readonly id: string;
}

export interface UnlinkCall {
  readonly name: string;
  readonly id: string | undefined;
}

// --- Forward entry ---

export interface ForwardEntry {
  id: string;
  linkName: string;
  targetId: string;
  message: { type: string; [key: string]: unknown };
  status: "pending" | "running" | "done" | "failed";
  attempts: number;
  createdAt: number;
}

// --- Outbox collector (used during a transition) ---

interface OutboxCollector {
  execute(service: string, payload: unknown): void;
  link(name: string, id: string): void;
  unlink(name: string, id?: string): void;
  forward(linkName: string, targetId: string, message: { type: string; [key: string]: unknown }): void;
  getExecutions(): Execution[];
  getLinks(): LinkCall[];
  getUnlinks(): UnlinkCall[];
  getForwards(): ForwardCall[];
  toExecutionEntries(): ExecutionEntry[];
  toForwardEntries(): ForwardEntry[];
}

let idCounter = 0;

function generateId(): string {
  idCounter += 1;
  return `outbox-${Date.now()}-${idCounter}`;
}

export function createOutbox(): OutboxCollector {
  const executions: Execution[] = [];
  const links: LinkCall[] = [];
  const unlinks: UnlinkCall[] = [];
  const forwards: ForwardCall[] = [];

  return {
    execute(service: string, payload: unknown): void {
      executions.push({ service, payload });
    },

    link(name: string, id: string): void {
      links.push({ name, id });
    },

    unlink(name: string, id?: string): void {
      unlinks.push({ name, id });
    },

    forward(linkName: string, targetId: string, message: { type: string; [key: string]: unknown }): void {
      forwards.push({ linkName, targetId, message });
    },

    getExecutions(): Execution[] {
      return [...executions];
    },

    getLinks(): LinkCall[] {
      return [...links];
    },

    getUnlinks(): UnlinkCall[] {
      return [...unlinks];
    },

    getForwards(): ForwardCall[] {
      return [...forwards];
    },

    toExecutionEntries(): ExecutionEntry[] {
      const now = Date.now();
      return executions.map((exec) => ({
        id: generateId(),
        service: exec.service,
        payload: exec.payload,
        status: "pending" as const,
        attempts: 0,
        createdAt: now,
      }));
    },

    toForwardEntries(): ForwardEntry[] {
      const now = Date.now();
      return forwards.map((fwd) => ({
        id: generateId(),
        linkName: fwd.linkName,
        targetId: fwd.targetId,
        message: fwd.message,
        status: "pending" as const,
        attempts: 0,
        createdAt: now,
      }));
    },
  };
}
