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
  ScheduleOptions,
  SchemaDefinition,
  StandardSchema,
  TimelineEntry,
} from "@actor-kit/core";
import { ActorKitError, parseSchema, RefusalError, xxh64 } from "@actor-kit/core";
import type {
  EnvParser,
  LifecycleEvent,
  LinkCall,
  RolePredicate,
  StepCause,
  StepDef,
  StepFacts,
  UnlinkCall,
} from "@actor-kit/worker/testing";
import {
  admitStepMessage,
  checkMessageRoles,
  createLiveFacts,
  envErrorMessage,
  initialState,
  liveStepFacts,
  parseActorEnv,
  refuseAdmission,
  refuseNoRole,
  resolveRole,
  step,
  withDeterminismGuard,
} from "@actor-kit/worker/testing";
import type { ContractState } from "./contract-types";

// --- Actor definition shape (minimal for testing) ---

interface TestableActorDef<TState, TInput> {
  input: StandardSchema<unknown, TInput>;
  init: (input: TInput, ctx?: { env: unknown; link: (name: string, id: string) => Promise<unknown> }) => TState;
  roles: Record<string, RolePredicate<TState>>;
  messages: Record<
    string,
    Record<
      string,
      {
        readonly schema: StandardSchema;
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
  /** Domain events (ADR-017 §2): emit() parses payloads by these schemas. */
  events?: Record<string, StandardSchema>;
}

// --- Contract type inference helpers ---

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
  /** ctx.emit() calls, payloads parsed by the declared events (ADR-017 §2). */
  emitted: Array<{ name: string; payload: unknown }>;
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
  readonly def: Omit<StepDef, "messages" | "init"> & {
    input: StandardSchema;
    /** The typed env schema (ADR-016 §4). */
    env?: EnvParser;
    init: (input: unknown, ctx?: { env: unknown; link: (name: string, id: string) => Promise<unknown> }) => unknown;
    roles: Record<string, RolePredicate<unknown>>;
    messages?: Record<string, unknown>;
    views: Record<string, { readonly fn: (state: unknown, caller: string) => unknown }>;
    events?: Record<string, StandardSchema>;
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

// --- Refusals (ADR-018 C, D) ---

/** The caller's role, or a `no_role` refusal. */
function roleOrRefuse(
  roles: Record<string, RolePredicate<unknown>>,
  state: unknown,
  caller: string,
  callerType: "user" | "service",
): string {
  const role = resolveRole(roles, state, caller, { callerType });
  if (role === null) throw new RefusalError(refuseNoRole(caller, callerType));
  return role;
}

/** Live facts for one transition (real clock and ids), every handler under the determinism guard. */
function harnessFacts(): StepFacts {
  return { ...liveStepFacts(createLiveFacts()), guard: withDeterminismGuard };
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
  if (!parsed.ok) throw new ActorKitError("invalid_env", `testActor: ${envErrorMessage(name, parsed.issues)}`);
  return parsed.env;
}

// --- Implementation ---

// Overload 1: Contract (from defineActor) — requires roles and views; messages may all be in states
export function testActor<
  TContract extends {
    readonly name: string;
    readonly def: {
      readonly input: { _input: unknown; _output: unknown };
      readonly init: (...args: never[]) => unknown;
      readonly roles: Record<string, unknown>;
      readonly messages?: Record<string, unknown>;
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

// Implementation: a single actor over the runtime's step core (ADR-018 D), as simulate() runs many.
export function testActor(
  arg: TestableActorDef<unknown, unknown> | ContractShape,
  options: { env?: unknown } = {},
): TestHarness<unknown, unknown> | ContractTestHarness<unknown, unknown, unknown, unknown> {
  const def: TestableActorDef<unknown, unknown> & StepDef = isContract(arg) ? harnessDef(arg) : arg;
  const env = isContract(arg) ? harnessEnv(arg.name, arg.def.env, options.env) : (options.env ?? {});

  async function send(
    state: unknown,
    caller: string,
    event: { type: string; [key: string]: unknown },
    opts?: SendOptions,
  ): Promise<SendResult<unknown>> {
    const callerType = opts?.callerType ?? "user";
    const role = roleOrRefuse(def.roles, state, caller, callerType);
    const admission = admitStepMessage(def, role, state, event, { caller, callerType, env });
    if (!admission.ok) {
      throw new RefusalError(refuseAdmission(def, state, role, event.type, admission, { caller, callerType }));
    }
    const cause: StepCause = {
      type: "message",
      name: event.type,
      payload: admission.payload,
      caller,
      callerType,
      role,
      delivery: opts?.delivery,
    };
    const result = step(def, state, cause, harnessFacts(), env);
    def.observe?.onTransition?.(state, result.handlerState, event, { caller, role });

    const { type: messageType, ...payload } = event;
    const timeline: TimelineEntry[] = [
      {
        cause: { type: "message", messageType, caller, callerType, role, payload },
        stateSnapshot: result.state,
        checksum: xxh64(JSON.stringify(result.state)),
        createdAt: Date.now(),
      },
    ];
    const effects = result.effects;
    return {
      state: result.state,
      executions: effects.getExecutions(),
      links: effects.getLinks(),
      unlinks: effects.getUnlinks(),
      forwards: effects.getForwards(),
      schedules: effects.getSchedules(),
      cancels: effects.toTimerOps().flatMap((op) => (op.op === "cancel" ? [op.key] : [])),
      emitted: effects.getEmitted().map(({ name, payload }) => ({ name, payload })),
      timeline,
    };
  }

  return {
    init(input: unknown): unknown {
      const parsed = parseSchema(def.input, input);
      if (!parsed.success) {
        throw new ActorKitError("invalid_input", `Invalid input: ${parsed.message}`);
      }
      const shared = withDeterminismGuard(() =>
        def.init(parsed.data, {
          ...createLiveFacts().ctx,
          env,
          link: async () => {
            throw new ActorKitError(
              "link_unavailable",
              "link() not available in test harness init — use send() for link testing",
            );
          },
        }),
      );
      return initialState(def, shared);
    },

    role(state: unknown, caller: string, opts?: { callerType?: "user" | "service" }): string | null {
      return resolveRole(def.roles, state, caller, {
        callerType: opts?.callerType ?? "user",
      });
    },

    send,

    view(state: unknown, caller: string, opts?: { callerType?: "user" | "service" }): { role: string; data: unknown } {
      const role = roleOrRefuse(def.roles, state, caller, opts?.callerType ?? "user");
      const viewDef = def.views[role];
      if (viewDef === undefined) {
        throw new ActorKitError("no_view", `No view defined for role "${role}"`);
      }
      return { role, data: viewDef.fn(state, caller) };
    },
  };
}

/** The definition the step core runs for a contract: its messages role-nested, as the runtime stores them. */
function harnessDef(contract: ContractShape): TestableActorDef<unknown, unknown> & StepDef {
  checkMessageRoles(contract.def);
  const { messages, ...def } = contract.def;
  return { ...def, messages: roleNestedMessages(messages ?? {}, def.roles) };
}
