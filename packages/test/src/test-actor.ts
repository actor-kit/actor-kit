/**
 * testActor() — test harness for actor definitions.
 *
 * Runs transitions, role evaluation, view computation, and emission capture
 * without CF runtime. Pure TypeScript.
 *
 * Accepts either a contract (from defineActor) or a raw TestableActorDef.
 */

import type { Execution, ForwardCall, Infer, MessageContext, SchemaDefinition } from "@actor-kit/core";
import type { LinkCall, RolePredicate, UnlinkCall } from "@actor-kit/worker/testing";
import { resolveRole, routeMessage } from "@actor-kit/worker/testing";
import type { z } from "zod";

// --- Actor definition shape (minimal for testing) ---

interface TestableActorDef<TState, TInput> {
  input: z.ZodType<TInput>;
  init: (input: TInput, ctx?: { env: unknown; link: (name: string, id: string) => Promise<unknown> }) => TState;
  roles: Record<string, RolePredicate<TState>>;
  messages: Record<
    string,
    Record<
      string,
      {
        readonly schema: z.ZodType;
        handler(state: TState, payload: unknown, ctx: unknown): TState;
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
    connect?(state: TState, event: { caller: string; callerType: "user" | "service" }, ctx: unknown): TState;
    disconnect?(state: TState, event: { caller: string; callerType: "user" | "service" }, ctx: unknown): TState;
  };
  observe?: {
    onTransition?(
      prevState: TState,
      nextState: TState,
      event: { type: string },
      ctx: { caller: string; role: string },
    ): void;
  };
}

// --- Contract type inference helpers ---

/**
 * Extract state type from a contract's init() return type.
 */
type ContractState<T> = T extends { def: { init: (...args: never[]) => infer S } } ? S : unknown;

/**
 * Extract input type from a contract's Zod input schema.
 * Uses _input (not _output) because testActor.init() calls safeParse on raw values.
 * For schemas with coercion/transforms, _input reflects what the caller actually passes.
 */
type ContractInput<T> = T extends { def: { input: { _input: infer I } } } ? I : unknown;

/**
 * Extract the message union from a contract's flat messages.
 * Each message name K becomes { type: K } & payload.
 * Only matches flat messages (values have `schema` property).
 */
type ContractMessages<T> = T extends {
  def: { messages: Record<string, { schema: { _output: unknown } }> };
}
  ? {
      [K in keyof T["def"]["messages"] & string]: T["def"]["messages"][K] extends {
        schema: { _output: infer P };
      }
        ? { type: K } & P
        : { type: K };
    }[keyof T["def"]["messages"] & string]
  : { type: string; [key: string]: unknown };

/**
 * Extract the view union from a contract's views.
 * Uses the schema's Infer type (same type used for binary decoding).
 */
type ContractView<T> = T extends {
  def: { views: Record<string, unknown> };
}
  ? {
      [K in keyof T["def"]["views"]]: T["def"]["views"][K] extends {
        schema: SchemaDefinition<infer TShape>;
      }
        ? Infer<SchemaDefinition<TShape>>
        : never;
    }[keyof T["def"]["views"]]
  : unknown;

// --- Test harness return types ---

interface TestHarness<TState, TInput> {
  init(input: TInput): TState;
  role(state: TState, caller: string, opts?: { callerType?: "user" | "service" }): string | null;
  send(
    state: TState,
    caller: string,
    message: { type: string; [key: string]: unknown },
    opts?: { callerType?: "user" | "service" },
  ): Promise<TState>;
  sendWithEffects(
    state: TState,
    caller: string,
    message: { type: string; [key: string]: unknown },
    opts?: { callerType?: "user" | "service" },
  ): Promise<{
    state: TState;
    executions: Execution[];
    links: LinkCall[];
    unlinks: UnlinkCall[];
    forwards: ForwardCall[];
  }>;
  view(state: TState, caller: string, opts?: { callerType?: "user" | "service" }): { role: string; data: unknown };
}

interface ContractTestHarness<TState, TInput, TMessage, TViewData> {
  init(input: TInput): TState;
  role(state: TState, caller: string, opts?: { callerType?: "user" | "service" }): string | null;
  send(state: TState, caller: string, message: TMessage, opts?: { callerType?: "user" | "service" }): Promise<TState>;
  sendWithEffects(
    state: TState,
    caller: string,
    message: TMessage,
    opts?: { callerType?: "user" | "service" },
  ): Promise<{
    state: TState;
    executions: Execution[];
    links: LinkCall[];
    unlinks: UnlinkCall[];
    forwards: ForwardCall[];
  }>;
  view(state: TState, caller: string, opts?: { callerType?: "user" | "service" }): { role: string; data: TViewData };
}

// --- Flat message detection + wrapping ---

function isFlatMessages(messages: Record<string, unknown>): boolean {
  const values = Object.values(messages);
  if (values.length === 0) return false;
  return values.every((v) => typeof v === "object" && v !== null && "schema" in v && "handler" in v);
}

function wrapFlatMessages(
  flatMessages: Record<string, unknown>,
  roles: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const roleNames = Object.keys(roles);
  const result: Record<string, Record<string, unknown>> = {};
  for (const role of roleNames) {
    result[role] = flatMessages;
  }
  return result;
}

// --- Contract detection ---

interface ContractShape {
  readonly name: string;
  readonly def: {
    input: z.ZodType;
    init: (input: unknown, ctx?: { env: unknown; link: (name: string, id: string) => Promise<unknown> }) => unknown;
    roles: Record<string, RolePredicate<unknown>>;
    messages: Record<string, unknown>;
    views: Record<string, { readonly fn: (state: unknown, caller: string) => unknown }>;
    lifecycle?: {
      connect?(state: unknown, event: { caller: string; callerType: "user" | "service" }, ctx: unknown): unknown;
      disconnect?(state: unknown, event: { caller: string; callerType: "user" | "service" }, ctx: unknown): unknown;
    };
    observe?: {
      onTransition?(
        prevState: unknown,
        nextState: unknown,
        event: { type: string },
        ctx: { caller: string; role: string },
      ): void;
    };
  };
}

function isContract(arg: TestableActorDef<unknown, unknown> | ContractShape): arg is ContractShape {
  return "name" in arg && "def" in arg;
}

// --- Implementation ---

// Overload 1: Contract (from defineActor) — requires roles, messages, views
export function testActor<
  TContract extends {
    readonly name: string;
    readonly def: {
      readonly input: { _input: unknown; _output: unknown };
      readonly init: (...args: never[]) => unknown;
      readonly roles: Record<string, unknown>;
      readonly messages: Record<string, unknown>;
      readonly views: Record<string, unknown>;
    };
  },
>(
  contract: TContract,
): ContractTestHarness<
  ContractState<TContract>,
  ContractInput<TContract>,
  ContractMessages<TContract>,
  ContractView<TContract>
>;

// Overload 2: Raw TestableActorDef (legacy)
export function testActor<TState, TInput>(def: TestableActorDef<TState, TInput>): TestHarness<TState, TInput>;

// Implementation
export function testActor(
  arg: TestableActorDef<unknown, unknown> | ContractShape,
): TestHarness<unknown, unknown> | ContractTestHarness<unknown, unknown, unknown, unknown> {
  // Extract def from contract or use directly
  const def = isContract(arg) ? extractDef(arg) : arg;

  // sendWithEffects as standalone function for safe destructuring
  async function sendWithEffectsImpl(
    state: unknown,
    caller: string,
    event: { type: string; [key: string]: unknown },
    opts?: { callerType?: "user" | "service" },
  ): Promise<{
    state: unknown;
    executions: Execution[];
    links: LinkCall[];
    unlinks: UnlinkCall[];
    forwards: ForwardCall[];
  }> {
    const callerType = opts?.callerType ?? "user";
    const role = resolveRole(def.roles, state, caller, { callerType });

    if (role === null) {
      throw new Error(`No role matched for caller "${caller}"`);
    }

    const executions: Execution[] = [];
    const links: LinkCall[] = [];
    const unlinks: UnlinkCall[] = [];
    const forwards: ForwardCall[] = [];

    const ctx: Omit<MessageContext, "role"> = {
      caller,
      callerType,
      env: {},
      execute: (service: string, payload: unknown) => {
        executions.push({ service, payload });
      },
      link: (name: string, id: string) => {
        links.push({ name, id });
      },
      unlink: (name: string, id?: string) => {
        unlinks.push({ name, id });
      },
      forward: (linkName, targetId, message) => {
        forwards.push({ linkName, targetId, message });
      },
    };

    const result = routeMessage(def.messages, role, state, event, ctx);

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

    if (def.observe?.onTransition) {
      def.observe.onTransition(state, result.state, event, { caller, role });
    }

    return { state: result.state, executions, links, unlinks, forwards };
  }

  return {
    init(input: unknown): unknown {
      const parsed = def.input.safeParse(input);
      if (!parsed.success) {
        throw new Error(`Invalid input: ${parsed.error.message}`);
      }
      return def.init(parsed.data, {
        env: {},
        link: async () => {
          throw new Error("link() not available in test harness init — use sendWithEffects() for link testing");
        },
      });
    },

    role(state: unknown, caller: string, opts?: { callerType?: "user" | "service" }): string | null {
      return resolveRole(def.roles, state, caller, {
        callerType: opts?.callerType ?? "user",
      });
    },

    async send(
      state: unknown,
      caller: string,
      event: { type: string; [key: string]: unknown },
      opts?: { callerType?: "user" | "service" },
    ): Promise<unknown> {
      const { state: nextState } = await sendWithEffectsImpl(state, caller, event, opts);
      return nextState;
    },

    sendWithEffects: sendWithEffectsImpl,

    view(state: unknown, caller: string, opts?: { callerType?: "user" | "service" }): { role: string; data: unknown } {
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

/**
 * Extract a TestableActorDef from a contract, handling flat → role-nested message conversion.
 */
function extractDef(contract: ContractShape): TestableActorDef<unknown, unknown> {
  const def = contract.def;

  // Convert flat messages to role-nested format
  const messages = isFlatMessages(def.messages)
    ? (wrapFlatMessages(def.messages, def.roles) as TestableActorDef<unknown, unknown>["messages"])
    : (def.messages as TestableActorDef<unknown, unknown>["messages"]);

  const result: TestableActorDef<unknown, unknown> = {
    input: def.input,
    init: def.init as (
      input: unknown,
      ctx?: { env: unknown; link: (name: string, id: string) => Promise<unknown> },
    ) => unknown,
    roles: def.roles,
    messages,
    views: def.views,
  };

  if (def.lifecycle) {
    result.lifecycle = def.lifecycle;
  }
  if (def.observe) {
    result.observe = def.observe;
  }

  return result;
}
