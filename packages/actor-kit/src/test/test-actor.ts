/**
 * testActor() — test harness for actor definitions.
 *
 * Runs transitions, role evaluation, view computation, and emission capture
 * without CF runtime. Pure TypeScript.
 */

import type { z } from "zod";
import { resolveRole, type RolePredicate } from "../runtime/roles";
import { routeMessage } from "../runtime/message-router";
import type { Effect, RequestConfig, MessageContext } from "../core/message";

// --- Actor definition shape (minimal for testing) ---

interface TestableActorDef<TState, TInput> {
  input: z.ZodType<TInput>;
  init: (input: TInput) => TState;
  roles: Record<string, RolePredicate<TState>>;
  messages: Record<string, Record<string, {
    readonly schema: z.ZodType;
    handler(state: TState, payload: unknown, ctx: unknown): unknown;
    guard?(state: TState): boolean;
  }>>;
  views: Record<string, {
    readonly fn: (state: TState, caller: string) => unknown;
  }>;
  observe?: {
    onTransition?(prevState: TState, nextState: TState, event: { type: string }, ctx: { caller: string; role: string }): void;
  };
}

// --- Test harness return type ---

interface TestHarness<TState, TInput> {
  init(input: TInput): TState;
  role(state: TState, caller: string, opts?: { callerType?: "user" | "service" }): string | null;
  send(state: TState, caller: string, event: { type: string; [key: string]: unknown }, opts?: { callerType?: "user" | "service" }): Promise<TState>;
  sendWithEffects(state: TState, caller: string, event: { type: string; [key: string]: unknown }, opts?: { callerType?: "user" | "service" }): Promise<{
    state: TState;
    emissions: Effect[];
    requests: RequestConfig[];
  }>;
  view(state: TState, caller: string, opts?: { callerType?: "user" | "service" }): { role: string; data: unknown };
}

// --- Implementation ---

export function testActor<TState, TInput>(
  def: TestableActorDef<TState, TInput>,
): TestHarness<TState, TInput> {
  return {
    init(input: TInput): TState {
      const parsed = def.input.safeParse(input);
      if (!parsed.success) {
        throw new Error(`Invalid input: ${parsed.error.message}`);
      }
      return def.init(parsed.data);
    },

    role(state: TState, caller: string, opts?: { callerType?: "user" | "service" }): string | null {
      return resolveRole(def.roles, state, caller, {
        callerType: opts?.callerType ?? "user",
      });
    },

    async send(state: TState, caller: string, event: { type: string; [key: string]: unknown }, opts?: { callerType?: "user" | "service" }): Promise<TState> {
      const { state: nextState } = await this.sendWithEffects(state, caller, event, opts);
      return nextState;
    },

    async sendWithEffects(state: TState, caller: string, event: { type: string; [key: string]: unknown }, opts?: { callerType?: "user" | "service" }): Promise<{
      state: TState;
      emissions: Effect[];
      requests: RequestConfig[];
    }> {
      const callerType = opts?.callerType ?? "user";
      const role = resolveRole(def.roles, state, caller, { callerType });

      if (role === null) {
        throw new Error(`No role matched for caller "${caller}"`);
      }

      // Collect emissions and requests
      const emissions: Effect[] = [];
      const requests: RequestConfig[] = [];

      const ctx: Omit<MessageContext, "role"> = {
        caller,
        callerType,
        env: {},
        emit: (effect: Effect) => { emissions.push(effect); },
        request: (config: RequestConfig) => { requests.push(config); },
      };

      const result = await routeMessage(def.messages, role, state, event, ctx);

      if (!result.ok) {
        switch (result.error) {
          case "message_not_found":
            throw new Error(`Message "${event.type}" not found for role "${role}"`);
          case "validation_failed":
            throw new Error(`Validation failed for "${event.type}": ${result.detail ?? "unknown"}`);
          case "guard_failed":
            throw new Error(`Guard rejected "${event.type}"`);
        }
      }

      // Fire onTransition hook if defined
      if (def.observe?.onTransition) {
        def.observe.onTransition(state, result.state, event, { caller, role });
      }

      return { state: result.state, emissions, requests };
    },

    view(state: TState, caller: string, opts?: { callerType?: "user" | "service" }): { role: string; data: unknown } {
      const callerType = opts?.callerType ?? "user";
      const role = resolveRole(def.roles, state, caller, { callerType });

      if (role === null) {
        throw new Error(`No role matched for caller "${caller}"`);
      }

      const viewDef = def.views[role];
      if (viewDef === undefined) {
        throw new Error(`No view defined for role "${role}"`);
      }

      return {
        role,
        data: viewDef.fn(state, caller),
      };
    },
  };
}
