/**
 * testActor() — test harness for actor definitions.
 *
 * Runs transitions, role evaluation, view computation, and emission capture
 * without CF runtime. Pure TypeScript.
 */

import type { z } from "zod";
import type { Effect, MessageContext, NormalizedRequestConfig, RequestConfig } from "@actor-kit/core";
import { normalizeRequest } from "@actor-kit/core";
import { routeMessage } from "@actor-kit/worker/testing";
import { type RolePredicate, resolveRole } from "@actor-kit/worker/testing";

// --- Actor definition shape (minimal for testing) ---

interface TestableActorDef<TState, TInput> {
  input: z.ZodType<TInput>;
  init: (input: TInput) => TState;
  roles: Record<string, RolePredicate<TState>>;
  messages: Record<
    string,
    Record<
      string,
      {
        readonly schema: z.ZodType;
        handler(state: TState, payload: unknown, ctx: unknown): unknown;
        guard?(state: TState): boolean;
      }
    >
  >;
  views: Record<
    string,
    {
      readonly fn: (state: TState, caller: string) => unknown;
    }
  >;
  lifecycle?: {
    connect?(
      state: TState,
      event: { caller: string; callerType: "user" | "service" },
      ctx: unknown,
    ): TState | Promise<TState>;
    disconnect?(
      state: TState,
      event: { caller: string; callerType: "user" | "service" },
      ctx: unknown,
    ): TState | Promise<TState>;
  };
  callbacks?: Record<
    string,
    {
      // bivariant method signature so typed callbacks are assignable
      (state: TState, payload: unknown, ctx: unknown): TState | Promise<TState>;
    }
  >;
  on?: Record<string, (state: TState, ...args: unknown[]) => TState | Promise<TState>>;
  observe?: {
    onTransition?(
      prevState: TState,
      nextState: TState,
      event: { type: string },
      ctx: { caller: string; role: string },
    ): void;
  };
}

// --- Test harness return type ---

interface TestHarness<TState, TInput> {
  init(input: TInput): TState;
  role(state: TState, caller: string, opts?: { callerType?: "user" | "service" }): string | null;
  send(
    state: TState,
    caller: string,
    event: { type: string; [key: string]: unknown },
    opts?: { callerType?: "user" | "service" },
  ): Promise<TState>;
  sendWithEffects(
    state: TState,
    caller: string,
    event: { type: string; [key: string]: unknown },
    opts?: { callerType?: "user" | "service" },
  ): Promise<{
    state: TState;
    emissions: Effect[];
    requests: NormalizedRequestConfig[];
  }>;
  view(state: TState, caller: string, opts?: { callerType?: "user" | "service" }): { role: string; data: unknown };
}

// --- Implementation ---

export function testActor<TState, TInput>(def: TestableActorDef<TState, TInput>): TestHarness<TState, TInput> {
  // sendWithEffects is defined as a standalone function so send() can call it
  // without relying on `this` binding (safe for destructured usage).
  async function sendWithEffectsImpl(
    state: TState,
    caller: string,
    event: { type: string; [key: string]: unknown },
    opts?: { callerType?: "user" | "service" },
  ): Promise<{
    state: TState;
    emissions: Effect[];
    requests: NormalizedRequestConfig[];
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
      emit: (effect: Effect) => {
        emissions.push(effect);
      },
      request: (config: RequestConfig) => {
        requests.push(config);
      },
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

    return { state: result.state, emissions, requests: requests.map(normalizeRequest) };
  }

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

    async send(
      state: TState,
      caller: string,
      event: { type: string; [key: string]: unknown },
      opts?: { callerType?: "user" | "service" },
    ): Promise<TState> {
      const { state: nextState } = await sendWithEffectsImpl(state, caller, event, opts);
      return nextState;
    },

    sendWithEffects: sendWithEffectsImpl,

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
