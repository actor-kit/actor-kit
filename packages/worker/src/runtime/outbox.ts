/**
 * Transactional outbox — collects execute() and forward() calls during a transition.
 *
 * Each effect gets its declaration index within the transition (executions and forwards share
 * one counter; links are not effects). Once the transition's seq is known, the entries carry
 * deterministic effect ids `seq:index` (ADR-015 D1).
 */

import type { Execution, ForwardCall, ScheduleOptions } from "@actor-kit/core";
import { formatEffectId } from "./effect-id";

export type { ForwardCall };

// --- Execution entry ---

export interface ExecutionEntry {
  /** Effect id, `seq:index`. */
  id: string;
  seq: number;
  index: number;
  service: string;
  input: unknown;
  status: "pending" | "running" | "retrying" | "done" | "failed";
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
  /** Effect id, `seq:index`. */
  id: string;
  seq: number;
  index: number;
  linkName: string;
  targetId: string;
  message: { type: string; [key: string]: unknown };
  status: "pending" | "running" | "done" | "failed";
  attempts: number;
  createdAt: number;
}

// --- Timer ops (ADR-015 D2) ---

/** A timer as scheduled: its deadline is already absolute (computed from ctx.now()). */
export interface TimerSchedule {
  readonly name: string;
  /** null: the timer's key is its effect id. */
  readonly key: string | null;
  readonly payload: unknown;
  readonly fireAt: number;
}

export type TimerOp =
  | {
      readonly op: "schedule";
      /** Effect id, `seq:index`. */
      readonly id: string;
      readonly seq: number;
      readonly index: number;
      readonly name: string;
      readonly key: string;
      readonly payload: unknown;
      readonly fireAt: number;
    }
  /**
   * `stale`: cancelled because the state that owned it was left (ADR-019 B). A call cancelled this way
   * still delivers a late result, to `onStale`.
   */
  | { readonly op: "cancel"; readonly key: string; readonly stale?: true };

// --- Outbox collector (used during a transition) ---

interface OutboxCollector {
  /** Record a service call; returns its effect id (`seq:index` of the transition being stepped). */
  execute(service: string, input: unknown): string;
  link(name: string, id: string): void;
  unlink(name: string, id?: string): void;
  forward(linkName: string, targetId: string, message: { type: string; [key: string]: unknown }): void;
  getExecutions(): Execution[];
  getLinks(): LinkCall[];
  getUnlinks(): UnlinkCall[];
  getForwards(): ForwardCall[];
  /** Executions as outbox rows for the transition numbered `seq` (0 outside a runtime). */
  toExecutionEntries(seq?: number): ExecutionEntry[];
  /** Forwards as outbox rows for the transition numbered `seq` (0 outside a runtime). */
  toForwardEntries(seq?: number): ForwardEntry[];
  /**
   * Record a timer (validated and given its deadline by the caller). Takes an effect index.
   * `requested`: the ctx.schedule() options as called, which testActor reports.
   */
  schedule(timer: TimerSchedule, requested: ScheduleRequest): void;
  /** Every ctx.schedule() call, as made (ADR-018 D: testActor records timers). */
  getSchedules(): ScheduleRequest[];
  /** Cancel a timer key or a call's effect id; `stale` when its owning state was left (ADR-019 B). */
  cancel(key: string, stale?: boolean): void;
  /** Schedules and cancels, in declaration order, for the transition numbered `seq`. */
  toTimerOps(seq?: number): TimerOp[];
  /** Record a domain event (ADR-017 §2), already parsed. Takes an effect index (publish uses it). */
  emit(name: string, payload: unknown): void;
  /** Emitted events in order, with their effect index. */
  getEmitted(): EmittedEffect[];
}

/** A ctx.schedule() call as the handler made it (scope: "state" keys filled in). */
export interface ScheduleRequest {
  readonly timer: string;
  readonly options: ScheduleOptions;
}

/** A domain event a transition emitted, with its effect index (ADR-017 §2, §3). */
export interface EmittedEffect {
  readonly name: string;
  readonly payload: unknown;
  readonly index: number;
}

/** `seq`: the transition being stepped (0 outside a runtime), so execute() can return effect ids. */
export function createOutbox(seq = 0): OutboxCollector {
  const executions: Array<Execution & { readonly index: number }> = [];
  const links: LinkCall[] = [];
  const unlinks: UnlinkCall[] = [];
  const forwards: Array<ForwardCall & { readonly index: number }> = [];
  const timerOps: Array<
    | { readonly op: "schedule"; readonly timer: TimerSchedule; readonly index: number }
    | { readonly op: "cancel"; readonly key: string; readonly stale?: true }
  > = [];
  const emitted: EmittedEffect[] = [];
  const requests: ScheduleRequest[] = [];
  let effects = 0;

  return {
    emit(name: string, payload: unknown): void {
      emitted.push({ name, payload, index: effects++ });
    },

    getEmitted(): EmittedEffect[] {
      return [...emitted];
    },

    execute(service: string, input: unknown): string {
      const index = effects++;
      executions.push({ service, input, index });
      return formatEffectId(seq, index);
    },

    link(name: string, id: string): void {
      links.push({ name, id });
    },

    unlink(name: string, id?: string): void {
      unlinks.push({ name, id });
    },

    forward(linkName: string, targetId: string, message: { type: string; [key: string]: unknown }): void {
      forwards.push({ linkName, targetId, message, index: effects++ });
    },

    getExecutions(): Execution[] {
      return executions.map(({ service, input }) => ({ service, input }));
    },

    getLinks(): LinkCall[] {
      return [...links];
    },

    getUnlinks(): UnlinkCall[] {
      return [...unlinks];
    },

    getForwards(): ForwardCall[] {
      return forwards.map(({ linkName, targetId, message }) => ({ linkName, targetId, message }));
    },

    toExecutionEntries(seq = 0): ExecutionEntry[] {
      const now = Date.now();
      return executions.map((exec) => ({
        id: formatEffectId(seq, exec.index),
        seq,
        index: exec.index,
        service: exec.service,
        input: exec.input,
        status: "pending" as const,
        attempts: 0,
        createdAt: now,
      }));
    },

    schedule(timer: TimerSchedule, requested: ScheduleRequest): void {
      timerOps.push({ op: "schedule", timer, index: effects++ });
      requests.push(requested);
    },

    getSchedules(): ScheduleRequest[] {
      return [...requests];
    },

    cancel(key: string, stale = false): void {
      timerOps.push(stale ? { op: "cancel", key, stale } : { op: "cancel", key });
    },

    toTimerOps(seq = 0): TimerOp[] {
      return timerOps.map((entry) => {
        if (entry.op !== "schedule") return entry;
        const id = formatEffectId(seq, entry.index);
        const { name, key, payload, fireAt } = entry.timer;
        return { op: "schedule", id, seq, index: entry.index, name, key: key ?? id, payload, fireAt };
      });
    },

    toForwardEntries(seq = 0): ForwardEntry[] {
      const now = Date.now();
      return forwards.map((fwd) => ({
        id: formatEffectId(seq, fwd.index),
        seq,
        index: fwd.index,
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
