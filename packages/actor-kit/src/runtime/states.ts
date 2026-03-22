/**
 * State resolution — resolves valid messages based on current state(s).
 *
 * Three modes:
 * 1. No states: messages at top level, always valid (gated by role + guard)
 * 2. Sequential: one active state, messages per state × role
 * 3. Parallel: multiple regions, each with an active state, messages merged across regions
 */

import type { z } from "zod";

// --- Types ---

// A message definition has at least a schema, handler, and optional guard
interface AnyMessageDef<TState> {
  readonly schema: z.ZodType;
  handler(state: TState, payload: unknown, ctx: unknown): unknown;
  readonly guard: ((state: TState) => boolean) | undefined;
}

type RoleMessages<TState> = Record<string, Record<string, AnyMessageDef<TState>>>;

export interface StateConfig<TState> {
  messages: RoleMessages<TState>;
  after?: Record<string, string>; // "1 hour" → target state name
}

export type SequentialStates<TState> = Record<string, StateConfig<TState>>;

export interface ParallelStates<TState> {
  parallel: true;
  regions: Record<string, {
    initial: string;
    states: Record<string, StateConfig<TState>>;
  }>;
}

// State tracking — what's currently active
type SequentialStateTracker = { current: string };
type ParallelStateTracker = Record<string, string>; // region name → active state
type StateTracker = SequentialStateTracker | ParallelStateTracker;

// --- Resolution ---

function isParallelConfig<TState>(
  config: SequentialStates<TState> | ParallelStates<TState>,
): config is ParallelStates<TState> {
  return "parallel" in config && config.parallel === true;
}

function isSequentialTracker(tracker: StateTracker): tracker is SequentialStateTracker {
  return "current" in tracker && typeof tracker.current === "string";
}

export function resolveMessagesForState<TState>(
  flatMessages: RoleMessages<TState> | undefined,
  statesConfig: SequentialStates<TState> | ParallelStates<TState> | undefined,
  stateTracker: StateTracker | undefined,
): RoleMessages<TState> | undefined {
  // Mode 1: No states — return flat messages
  if (statesConfig === undefined) {
    return flatMessages;
  }

  if (stateTracker === undefined) {
    return undefined;
  }

  // Mode 3: Parallel states
  if (isParallelConfig(statesConfig)) {
    // Parallel tracker is a Record<string, string> — not { current: string }
    if (isSequentialTracker(stateTracker)) {
      return undefined; // Mismatched tracker type
    }
    return resolveParallelMessages(statesConfig, stateTracker);
  }

  // Mode 2: Sequential states
  if (isSequentialTracker(stateTracker)) {
    return resolveSequentialMessages(statesConfig, stateTracker.current);
  }

  return undefined;
}

function resolveSequentialMessages<TState>(
  states: SequentialStates<TState>,
  currentState: string,
): RoleMessages<TState> | undefined {
  const stateConfig = states[currentState];
  if (stateConfig === undefined) {
    return undefined;
  }
  return stateConfig.messages;
}

function resolveParallelMessages<TState>(
  config: ParallelStates<TState>,
  regionStates: ParallelStateTracker,
): RoleMessages<TState> | undefined {
  const merged: Record<string, Record<string, AnyMessageDef<TState>>> = {};

  for (const [regionName, regionDef] of Object.entries(config.regions)) {
    const activeStateName = regionStates[regionName];
    if (activeStateName === undefined) continue;

    const activeState = regionDef.states[activeStateName];
    if (activeState === undefined) continue;

    // Merge messages from this region into the combined result
    for (const [roleName, roleMessages] of Object.entries(activeState.messages)) {
      if (merged[roleName] === undefined) {
        merged[roleName] = {};
      }
      const mergedRole = merged[roleName];
      if (mergedRole === undefined) continue;
      for (const [msgName, msgDef] of Object.entries(roleMessages)) {
        mergedRole[msgName] = msgDef;
      }
    }
  }

  return merged;
}
