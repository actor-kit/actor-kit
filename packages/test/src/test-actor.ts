/**
 * testActor() — test harness for actor definitions.
 *
 * Runs transitions, role evaluation, view computation, and emission capture
 * without CF runtime. Pure TypeScript.
 *
 * Accepts either a contract (from defineActor) or a raw TestableActorDef.
 */

import type {
  ContractMessages,
  DeliveryInfo,
  Execution,
  ForwardCall,
  Infer,
  MessageContext,
  ScheduleOptions,
  SchemaDefinition,
  TimelineEntry,
} from "@actor-kit/core";
import { xxh64 } from "@actor-kit/core";
import type { EnvParser, LifecycleEvent, LinkCall, RolePredicate, UnlinkCall } from "@actor-kit/worker/testing";
import {
  createLiveFacts,
  envErrorMessage,
  parseActorEnv,
  resolveRole,
  routeMessage,
  withDeterminismGuard,
} from "@actor-kit/worker/testing";
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
    connect?(state: TState, event: LifecycleEvent, ctx: unknown): TState;
    disconnect?(state: TState, event: LifecycleEvent, ctx: unknown): TState;
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

interface SendResult<TState> {
  state: TState;
  executions: Execution[];
  links: LinkCall[];
  unlinks: UnlinkCall[];
  forwards: ForwardCall[];
  /** ctx.schedule() calls, as made (timers are not run; use simulate() for that). */
  schedules: Array<{ timer: string; options: ScheduleOptions }>;
  /** ctx.cancel() keys. */
  cancels: string[];
  timeline: TimelineEntry[];
}

/** send()'s options: the caller type, and the forward that delivered the message (ctx.delivery, ADR-016 §1). */
interface SendOptions {
  callerType?: "user" | "service";
  delivery?: DeliveryInfo;
}

interface TestHarness<TState, TInput> {
  init(input: TInput): TState;
  role(state: TState, caller: string, opts?: { callerType?: "user" | "service" }): string | null;
  send(
    state: TState,
    caller: string,
    message: { type: string; [key: string]: unknown },
    opts?: SendOptions,
  ): Promise<SendResult<TState>>;
  view(state: TState, caller: string, opts?: { callerType?: "user" | "service" }): { role: string; data: unknown };
}

interface ContractTestHarness<TState, TInput, TMessage, TViewData> {
  init(input: TInput): TState;
  role(state: TState, caller: string, opts?: { callerType?: "user" | "service" }): string | null;
  send(state: TState, caller: string, message: TMessage, opts?: SendOptions): Promise<SendResult<TState>>;
  view(state: TState, caller: string, opts?: { callerType?: "user" | "service" }): { role: string; data: TViewData };
}

// --- Message layout: flat ({ NAME: message(...) }) or role-nested ({ role: { NAME: message(...) } }) ---

type MessageSlot = TestableActorDef<unknown, unknown>["messages"][string][string];

/** A message definition as message() builds it: a schema and a handler. */
function isMessageSlot(value: unknown): value is MessageSlot {
  return typeof value === "object" && value !== null && "schema" in value && "handler" in value;
}

/** The record's entries when every one is a message definition, otherwise undefined. */
function messageSlots(record: unknown): Record<string, MessageSlot> | undefined {
  if (typeof record !== "object" || record === null) return undefined;
  const slots: Record<string, MessageSlot> = {};
  for (const [name, slot] of Object.entries(record)) {
    if (!isMessageSlot(slot)) return undefined;
    slots[name] = slot;
  }
  return slots;
}

/** Role-nested messages. Flat messages apply to every role, as in the runtime. */
function roleNestedMessages(
  messages: Record<string, unknown>,
  roles: Record<string, unknown>,
): TestableActorDef<unknown, unknown>["messages"] {
  const flat = messageSlots(messages);
  if (flat !== undefined) return Object.fromEntries(Object.keys(roles).map((role) => [role, flat]));
  const nested: TestableActorDef<unknown, unknown>["messages"] = {};
  for (const [role, record] of Object.entries(messages)) {
    const slots = messageSlots(record);
    if (slots !== undefined) nested[role] = slots;
  }
  return nested;
}

// --- Contract detection ---

interface ContractShape {
  readonly name: string;
  readonly def: {
    input: z.ZodType;
    /** The typed env schema (ADR-016 §4). */
    env?: EnvParser;
    init: (input: unknown, ctx?: { env: unknown; link: (name: string, id: string) => Promise<unknown> }) => unknown;
    roles: Record<string, RolePredicate<unknown>>;
    messages: Record<string, unknown>;
    views: Record<string, { readonly fn: (state: unknown, caller: string) => unknown }>;
    lifecycle?: {
      connect?(state: unknown, event: LifecycleEvent, ctx: unknown): unknown;
      disconnect?(state: unknown, event: LifecycleEvent, ctx: unknown): unknown;
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

// --- Helpers ---

const ROUTE_ERRORS = {
  message_not_found: (type: string, role: string) => `Message "${type}" not found for role "${role}"`,
  validation_failed: (type: string, _role: string, detail: string | undefined) =>
    `Validation failed for "${type}": ${detail ?? "unknown"}`,
  guard_failed: (type: string) => `Guard rejected "${type}"`,
} as const;

/** Effect hooks for a message context, recording every call instead of performing it. */
function recordEffects() {
  const captured: Pick<
    SendResult<unknown>,
    "executions" | "links" | "unlinks" | "forwards" | "schedules" | "cancels"
  > = {
    executions: [],
    links: [],
    unlinks: [],
    forwards: [],
    schedules: [],
    cancels: [],
  };
  const ctx: Pick<MessageContext, "execute" | "link" | "unlink" | "forward" | "schedule" | "cancel"> = {
    execute: (service, input) => {
      captured.executions.push({ service, input });
    },
    link: (name, id) => {
      captured.links.push({ name, id });
    },
    unlink: (name, id) => {
      captured.unlinks.push({ name, id });
    },
    forward: (linkName, targetId, message) => {
      captured.forwards.push({ linkName, targetId, message });
    },
    schedule: (timer, options) => {
      captured.schedules.push({ timer, options });
    },
    cancel: (key) => {
      captured.cancels.push(key);
    },
  };
  return { captured, ctx };
}

// --- Determinism guard (ADR-016 §5) ---

/** The same messages, each handler run under withDeterminismGuard (schemas and guards unchanged). */
function guardHandlers(
  messages: TestableActorDef<unknown, unknown>["messages"],
): TestableActorDef<unknown, unknown>["messages"] {
  return Object.fromEntries(
    Object.entries(messages).map(([role, slots]) => [
      role,
      Object.fromEntries(
        Object.entries(slots).map(([name, slot]) => [
          name,
          {
            ...slot,
            handler: (state: unknown, payload: unknown, ctx: unknown) =>
              withDeterminismGuard(() => slot.handler(state, payload, ctx)),
          },
        ]),
      ),
    ]),
  );
}

// --- Typed env (ADR-016 §4) ---

/** The env a contract's handlers see: its `env` schema's output, or `unknown` without one. */
type ContractEnv<T> = T extends { def: { env: { _output: infer E } } } ? E : unknown;

/** testActor's options: `env`, fakes typed against the contract's `env` schema. */
export interface TestActorOptions<TContract> {
  env?: ContractEnv<TContract>;
}

/** Fakes are parsed like the runtime parses the Worker env; one that doesn't match throws, naming each binding. */
function harnessEnv(name: string, schema: EnvParser | undefined, env: unknown): unknown {
  if (schema === undefined) return env ?? {};
  const parsed = parseActorEnv(schema, env);
  if (!parsed.ok) throw new Error(`testActor: ${envErrorMessage(name, parsed.issues)}`);
  return parsed.env;
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
  options?: TestActorOptions<TContract>,
): ContractTestHarness<
  ContractState<TContract>,
  ContractInput<TContract>,
  ContractMessages<TContract>,
  ContractView<TContract>
>;

// Overload 2: Raw TestableActorDef (legacy)
export function testActor<TState, TInput>(
  def: TestableActorDef<TState, TInput>,
  options?: { env?: unknown },
): TestHarness<TState, TInput>;

// Implementation
export function testActor(
  arg: TestableActorDef<unknown, unknown> | ContractShape,
  options: { env?: unknown } = {},
): TestHarness<unknown, unknown> | ContractTestHarness<unknown, unknown, unknown, unknown> {
  // Extract def from contract or use directly
  const unguarded = isContract(arg) ? extractDef(arg) : arg;
  // Message handlers and init run under the determinism guard (ADR-016 §5).
  const def = { ...unguarded, messages: guardHandlers(unguarded.messages) };
  const env = isContract(arg) ? harnessEnv(arg.name, arg.def.env, options.env) : (options.env ?? {});

  // sendWithEffects as standalone function for safe destructuring
  async function sendWithEffectsImpl(
    state: unknown,
    caller: string,
    event: { type: string; [key: string]: unknown },
    opts?: SendOptions,
  ): Promise<SendResult<unknown>> {
    const callerType = opts?.callerType ?? "user";
    const role = resolveRole(def.roles, state, caller, { callerType });
    if (role === null) throw new Error(`No role matched for caller "${caller}"`);

    const effects = recordEffects();
    const result = routeMessage(def.messages, role, state, event, {
      ...createLiveFacts().ctx,
      caller,
      callerType,
      env,
      ...(opts?.delivery === undefined ? {} : { delivery: opts.delivery }),
      ...effects.ctx,
    });
    if (!result.ok) throw new Error(ROUTE_ERRORS[result.error](event.type, role, result.detail));

    def.observe?.onTransition?.(state, result.state, event, { caller, role });

    const { type: messageType, ...payload } = event;
    const timeline: TimelineEntry[] = [
      {
        cause: { type: "message", messageType, caller, callerType, role, payload },
        stateSnapshot: result.state,
        checksum: xxh64(JSON.stringify(result.state)),
        createdAt: Date.now(),
      },
    ];

    return { state: result.state, ...effects.captured, timeline };
  }

  return {
    init(input: unknown): unknown {
      const parsed = def.input.safeParse(input);
      if (!parsed.success) {
        throw new Error(`Invalid input: ${parsed.error.message}`);
      }
      return withDeterminismGuard(() =>
        def.init(parsed.data, {
          ...createLiveFacts().ctx,
          env,
          link: async () => {
            throw new Error("link() not available in test harness init — use send() for link testing");
          },
        }),
      );
    },

    role(state: unknown, caller: string, opts?: { callerType?: "user" | "service" }): string | null {
      return resolveRole(def.roles, state, caller, {
        callerType: opts?.callerType ?? "user",
      });
    },

    send: sendWithEffectsImpl,

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
  const result: TestableActorDef<unknown, unknown> = {
    input: def.input,
    init: def.init,
    roles: def.roles,
    messages: roleNestedMessages(def.messages, def.roles),
    views: def.views,
  };
  // The harness never runs lifecycle handlers, so only observe is carried over.
  if (def.observe) result.observe = def.observe;
  return result;
}
