/**
 * simulate() — many actors, a virtual clock, effects as data (ADR-015 D4).
 *
 * Every transition runs through the same step core as the Durable Object (`step` / `stepInit`
 * from @actor-kit/worker/testing), so the simulator cannot drift from the runtime. What the
 * runtime does with I/O, the simulation does with data:
 *
 * - Services never run: their executions wait in `pendingEffects()` until the test resolves or
 *   rejects them (the outcome after any retries), which runs onDone/onError.
 * - Forwards are delivered at once to the target actor, with the original caller.
 * - Timers fire only when the test calls `advance()`, in (fireAt, seq, index) order, each on its
 *   own deadline (never late), exactly as alarm() orders them.
 * - `ctx.now()` reads the virtual clock; `ctx.id()` and `ctx.random()` come from a seeded PRNG.
 * - Each actor writes a journal (events + checkpoints, with checksums), verifiable by
 *   `replayJournal(contract, actor.journal)`.
 * - Link views are pushed as the runtime pushes them: after every committed transition a source
 *   sends each actor linked to it its view (projected for caller `${source}:${subscriberId}`, a
 *   service), only when it changed for that subscriber; the subscriber runs link.onUpdate with the
 *   role added. A new link (also from init) gets the current view at once.
 * - `branch()` copies the whole simulation, so alternative futures can be explored.
 */

import type { ContractMessages, Duration, Refusal } from "@actor-kit/core";
import { ActorKitError } from "@actor-kit/core";
import {
  admitStepMessage,
  checksumState,
  createLiveFacts,
  type DeliveryInfo,
  defectError,
  deliveryInfo,
  type ErrorsParser,
  effectCauseId,
  eventId,
  isBuiltInError,
  isTaggedError,
  type Journal,
  type JournalCheckpoint,
  type JournalEvent,
  journalTrace,
  liveStepFacts,
  type PublishConfig,
  type PublishedBody,
  parseDuration,
  parseEffectId,
  parseServiceResult,
  publishedMessages,
  refuseAdmission,
  refuseNoRole,
  resolveJournalConfig,
  resolvePublish,
  resolveRole,
  resolveServiceOptions,
  type StepCause,
  type StepResult,
  step,
  stepInit,
  stepInitSync,
  type TaggedError,
  type Trace,
  withDeterminismGuard,
} from "@actor-kit/worker/testing";
import { z } from "zod";
import type { ContractInput, ContractState } from "./contract-types";
import { nextRandom, uuidFrom } from "./seeded";
import { type SimDef, simEnv, toSimDef } from "./sim-def";

// --- Public types ---

export interface AnyContract {
  readonly name: string;
  readonly def: unknown;
}

export interface ActorAddress {
  readonly type: string;
  readonly id: string;
}

/** A service execution waiting for the test to resolve or reject it. */
export interface PendingEffect {
  readonly actor: ActorAddress;
  /** `seq:index` (unique per actor). */
  readonly effectId: string;
  readonly service: string;
  readonly input: unknown;
}

export interface SimTimer {
  readonly id: string;
  readonly name: string;
  readonly key: string;
  readonly payload: unknown;
  readonly fireAt: number;
}

export interface FailedForward {
  readonly from: ActorAddress;
  readonly to: ActorAddress;
  readonly message: { type: string; [key: string]: unknown };
}

/** A domain event an actor emitted, with the journal seq of the transition that emitted it. */
export interface SimEvent {
  readonly actor: ActorAddress;
  readonly seq: number;
  readonly name: string;
  readonly payload: unknown;
}

/** A message's outcome: accepted, or a typed refusal (ADR-018 C). */
export type SendOutcome = { ok: true } | Refusal;

export interface CallerOptions {
  readonly callerType?: "user" | "service";
}

export interface SimConnection {
  /** Close this connection: runs lifecycle.disconnect with the caller's remaining connections. */
  disconnect(): void;
}

export interface SimActor<C extends AnyContract> {
  readonly type: string;
  readonly id: string;
  readonly state: ContractState<C>;
  readonly journal: Journal;
  /** Pending timers, soonest first. */
  readonly timers: SimTimer[];
  /** Active links (name, target id). */
  readonly links: Array<{ name: string; id: string }>;
  send(caller: string, message: ContractMessages<C>, options?: CallerOptions): SendOutcome;
  role(caller: string, options?: CallerOptions): string | null;
  view(caller: string, options?: CallerOptions): unknown;
  connect(caller: string, options?: CallerOptions): SimConnection;
}

export interface Simulation {
  /** The virtual clock, in ms. */
  readonly now: number;
  spawn<C extends AnyContract>(
    contract: C,
    id: string,
    input: ContractInput<C>,
    options?: { caller?: string; callerType?: "user" | "service" },
  ): Promise<SimActor<C>>;
  /**
   * spawn() without await, for an actor whose init is synchronous and makes no init links (an async init
   * or a link() in init throws: use spawn()). Same journal and handle as spawn().
   */
  spawnSync<C extends AnyContract>(
    contract: C,
    id: string,
    input: ContractInput<C>,
    options?: { caller?: string; callerType?: "user" | "service" },
  ): SimActor<C>;
  actor<C extends AnyContract>(contract: C, id: string): SimActor<C>;
  send<C extends AnyContract>(
    contract: C,
    id: string,
    caller: string,
    message: ContractMessages<C>,
    options?: CallerOptions,
  ): SendOutcome;
  /** Service executions not yet resolved or rejected, in the order they were declared. */
  pendingEffects(): PendingEffect[];
  /** Settle an execution as succeeded: runs its onDone. A bare effect id must be unique across actors. */
  resolve(effect: PendingEffect | string, result: unknown): void;
  /**
   * Settle an execution as failed for good: runs its onError with a typed error (ADR-016 §2). A declared
   * error (`{ _tag: "CardDeclined", ... }`) is parsed against the service's `errors`; `{ _tag: "Timeout", ms }`
   * and `{ _tag: "Defect", message }` are the built-ins; a string or an Error-like `{ message }` is a Defect.
   */
  reject(effect: PendingEffect | string, error: string | { message: string } | TaggedError): void;
  /** Move the clock forward, firing every timer that comes due on the way. */
  advance(duration: Duration): void;
  /** Forwards whose target actor was never spawned. */
  failedForwards(): FailedForward[];
  /** Every domain event any actor emitted (ADR-017 §2), in the order they were committed. */
  events(): SimEvent[];
  /** Messages published to a queue (ADR-017 §3), in commit order. Delivered at once: no retries. */
  published(queue: string): PublishedBody[];
  /** An independent copy of the whole simulation. */
  branch(): Simulation;
}

export interface SimulateOptions {
  /** Contracts that forwards and init links can reach by name. Spawned contracts are added too. */
  readonly contracts?: readonly AnyContract[];
  readonly seed?: number;
  /** Start time of the virtual clock (default 0). */
  readonly now?: number;
  /**
   * The env handlers see. For a contract that declares an `env` schema (ADR-016 §4): fakes keyed by contract
   * name, `{ checkout: { PAYMENTS: fakePayments } }`, parsed against its schema. Others get this value as is.
   */
  readonly env?: unknown;
}

// --- Internal data (plain, so branch() can copy it) ---

interface ActorData {
  type: string;
  id: string;
  state: unknown;
  seq: number;
  journal: { events: JournalEvent[]; checkpoints: JournalCheckpoint[] };
  timers: Array<SimTimer & { seq: number; index: number }>;
  links: Array<{ name: string; id: string }>;
  connections: Record<string, number>;
  /** Last view pushed to each subscriber (`type/id` → role + JSON), so unchanged views are not pushed. */
  pushed: Record<string, string>;
}

interface SimData {
  clock: number;
  rng: number;
  actors: Record<string, ActorData>;
  pending: PendingEffect[];
  /** Scoped calls cancelled because their state was left (ADR-019 B): a late result still reaches onStale. */
  stale: PendingEffect[];
  failedForwards: FailedForward[];
  events: SimEvent[];
  published: Array<{ queue: string; body: PublishedBody }>;
}

const MAX_TIMER_FIRINGS = 10_000;

/** How the runtime parses a linked actor's snapshot for init(): the view must be a record. */
const LinkedViewSchema = z.record(z.string(), z.unknown());

type Caller = { readonly caller: string; readonly callerType: "user" | "service" };

const keyOf = (address: ActorAddress): string => `${address.type}/${address.id}`;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const BuiltInErrorSchema = z.union([
  z.object({ _tag: z.literal("Timeout"), ms: z.number() }),
  z.object({ _tag: z.literal("Defect"), message: z.string() }),
  z.object({ _tag: z.literal("Evicted") }),
]);

/** A rejection as the service's onError receives it: parsed like the runtime parses a failed try. */
function errorOf(
  error: string | { message: string } | TaggedError,
  service: string,
  errors: ErrorsParser | undefined,
): Readonly<Record<string, unknown>> {
  if (typeof error === "string") return defectError(error);
  if (!isTaggedError(error)) return defectError(error.message);
  const builtIn = BuiltInErrorSchema.safeParse(error);
  if (builtIn.success) return builtIn.data;
  if (isBuiltInError(error))
    throw new ActorKitError("invalid_rejection", `simulate: invalid ${error._tag} error: ${builtIn.error.message}`);
  return declaredError(error, service, errors);
}

/** A declared rejection, parsed against the service's `errors`; one that does not parse is a test error. */
function declaredError(
  error: TaggedError,
  service: string,
  errors: ErrorsParser | undefined,
): Readonly<Record<string, unknown>> {
  if (errors === undefined)
    throw new ActorKitError(
      "invalid_rejection",
      `simulate: service "${service}" declares no errors to reject with "${error._tag}"`,
    );
  const parsed = errors.safeParse(error);
  if (!parsed.success) {
    throw new ActorKitError(
      "invalid_rejection",
      `simulate: "${error._tag}" does not match service "${service}"'s errors: ${parsed.error.message}`,
    );
  }
  return isTaggedError(parsed.data) ? { ...parsed.data } : defectError(`"${error._tag}" parsed to an untagged value`);
}

/** Run a simulation of actors on a virtual clock. */
export function simulate(options: SimulateOptions = {}): Simulation {
  const contracts = new Map<string, { contract: AnyContract; def: SimDef }>();
  for (const contract of options.contracts ?? []) contracts.set(contract.name, { contract, def: toSimDef(contract) });
  return createSimulation(
    contracts,
    {
      clock: options.now ?? 0,
      rng: options.seed ?? 1,
      actors: {},
      pending: [],
      stale: [],
      failedForwards: [],
      events: [],
      published: [],
    },
    options.env ?? {},
  );
}

function createSimulation(
  contracts: Map<string, { contract: AnyContract; def: SimDef }>,
  data: SimData,
  env: unknown,
): Simulation {
  const random = (): number => {
    const next = nextRandom(data.rng);
    data.rng = next.state;
    return next.value;
  };
  const sources = { now: () => data.clock, id: () => uuidFrom(random), random };

  const envs = new Map<string, unknown>();
  /** The env an actor type's handlers see (its parsed fakes, ADR-016 §4), parsed once per type. */
  function envFor(type: string): unknown {
    if (!envs.has(type)) envs.set(type, simEnv(defOf(type), type, env));
    return envs.get(type);
  }

  function defOf(type: string): SimDef {
    const entry = contracts.get(type);
    if (entry === undefined) throw new ActorKitError("not_spawned", `simulate: unknown contract "${type}"`);
    return entry.def;
  }

  function register(contract: AnyContract): SimDef {
    const def = toSimDef(contract);
    contracts.set(contract.name, { contract, def });
    return def;
  }

  /** The contract's publish config, validated (as the runtime does when it defines the actor). */
  const publishConfigs = new WeakMap<SimDef, PublishConfig | null>();
  function publishOf(def: SimDef): PublishConfig | null {
    let config = publishConfigs.get(def);
    if (config === undefined) {
      config = resolvePublish(def.publish, def.events, def.services);
      publishConfigs.set(def, config);
    }
    return config;
  }

  function record(address: ActorAddress): ActorData {
    const actor = data.actors[keyOf(address)];
    if (actor === undefined) throw new ActorKitError("not_spawned", `simulate: ${keyOf(address)} has not been spawned`);
    return actor;
  }

  function factsFor(actor: ActorData) {
    const live = createLiveFacts(sources);
    const facts = liveStepFacts(live, (name) => actor.links.filter((l) => l.name === name).map((l) => l.id));
    // Every handler runs under the determinism guard (ADR-016 §5); execute() returns ids under the next seq.
    return { ...facts, guard: withDeterminismGuard, seq: actor.seq + 1 };
  }

  // --- Commit: the simulated counterpart of actor.ts commit() + writeEffects() ---

  function appendJournal(actor: ActorData, def: SimDef, event: StepResult["event"]): void {
    const config = resolveJournalConfig(def.journal);
    if (!config.enabled) return;
    const checksum = checksumState(def, actor.state);
    // As the Durable Object stores it: the trace becomes the event's ids (ADR-017 §4).
    const { trace, ...draft } = event;
    const ids = journalTrace(trace, eventId(actor.type, actor.id, actor.seq));
    actor.journal.events.push({
      ...draft,
      correlationId: ids.correlationId,
      ...(ids.causationId === null ? {} : { causationId: ids.causationId }),
      seq: actor.seq,
      codeVersion: def.version ?? 1,
      stateChecksum: checksum,
      createdAt: data.clock,
    });
    if (actor.seq % config.checkpointEvery === 0) {
      const state = JSON.stringify(def.serialize ? def.serialize(actor.state) : actor.state);
      const timers = JSON.stringify(actor.timers);
      actor.journal.checkpoints.push({ seq: actor.seq, version: def.version ?? 1, state, checksum, timers });
    }
  }

  /** The flow an effect continues: its declaring event's correlation id, caused by the effect (ADR-017 §4). */
  function effectTrace(actor: ActorData, effectId: string): Trace {
    const seq = parseEffectId(effectId)?.seq ?? 0;
    // Seqs are contiguous in a simulated journal: index, not search (timer loops fire thousands).
    const { events } = actor.journal;
    const candidate = events[seq - (events[0]?.seq ?? 1)];
    const declared = candidate?.seq === seq ? candidate.correlationId : undefined;
    return {
      correlationId: declared ?? eventId(actor.type, actor.id, seq),
      causationId: effectCauseId(actor.type, actor.id, effectId),
    };
  }

  /** The flow a view push continues: the source's newest event (ADR-017 §4). */
  function sourceTrace(source: ActorData): Trace {
    const id = eventId(source.type, source.id, source.seq);
    const last = source.journal.events.at(-1);
    return { correlationId: last?.seq === source.seq ? (last.correlationId ?? id) : id, causationId: id };
  }

  /** Record links and unlinks; returns the links this transition added (they get the current view). */
  function applyLinks(actor: ActorData, def: SimDef, result: StepResult): Array<{ name: string; id: string }> {
    const added = result.effects.getLinks().filter((link) => {
      const declared = def.links?.[link.name] !== undefined;
      const present = actor.links.some((l) => l.name === link.name && l.id === link.id);
      if (!declared || present) return false;
      actor.links.push(link);
      return true;
    });
    for (const unlink of result.effects.getUnlinks()) {
      const kept = actor.links.filter((l) => l.name !== unlink.name || (unlink.id !== undefined && l.id !== unlink.id));
      // unlink(name, id) unsubscribes from that target; unlink(name) cannot (as in the runtime, the
      // ids are gone), so its targets keep the subscription and their dedupe.
      const unsubscribed = unlink.id === undefined ? [] : actor.links.filter((l) => !kept.includes(l));
      for (const link of unsubscribed) forgetPush(def, link, actor);
      actor.links = kept;
    }
    return added;
  }

  // --- Link pushes: the simulated counterpart of pushToSubscribers() / __receiveLinkUpdate() ---

  /** Whether a subscriber's (declared) link points at `source`. */
  const pointsAt = (def: SimDef, link: { name: string; id: string }, source: ActorData): boolean =>
    link.id === source.id && def.links?.[link.name]?.contract.name === source.type;

  /** The actor a link points at, if it has been spawned. */
  const linkedSource = (def: SimDef, link: { name: string; id: string }): ActorData | undefined =>
    Object.values(data.actors).find((source) => pointsAt(def, link, source));

  function forgetPush(def: SimDef, link: { name: string; id: string }, subscriber: ActorData): void {
    const source = linkedSource(def, link);
    if (source !== undefined) delete source.pushed[keyOf(subscriber)];
  }

  /** Actors with a link to `source`, and the names of those links. */
  function subscribersOf(source: ActorData): Array<{ subscriber: ActorData; names: string[] }> {
    return Object.values(data.actors).flatMap((subscriber) => {
      const def = defOf(subscriber.type);
      const names = subscriber.links.filter((l) => pointsAt(def, l, source)).map((l) => l.name);
      return names.length === 0 ? [] : [{ subscriber, names }];
    });
  }

  function pushViews(source: ActorData): void {
    for (const { subscriber, names } of subscribersOf(source)) push(source, subscriber, names);
  }

  /** Push `source`'s view to one subscriber, if it changed for it. */
  function push(source: ActorData, subscriber: ActorData, names: readonly string[]): void {
    const def = defOf(source.type);
    const caller = `${source.type}:${subscriber.id}`;
    const role = resolveRole(def.roles, source.state, caller, { callerType: "service" });
    if (role === null) return;
    const viewDef = def.views[role];
    if (viewDef === undefined) return;
    const view = viewDef.fn(source.state, caller);
    const dedupeKey = `${role}:${JSON.stringify(view)}`;
    if (source.pushed[keyOf(subscriber)] === dedupeKey) return;
    source.pushed[keyOf(subscriber)] = dedupeKey;
    const viewWithRole = { ...(isPlainRecord(view) ? view : {}), role };
    const trace = sourceTrace(source);
    for (const name of names) receive(subscriber, name, source.id, viewWithRole, trace);
  }

  function receive(
    subscriber: ActorData,
    link: string,
    sourceId: string,
    view: Record<string, unknown>,
    trace: Trace,
  ): void {
    const cause: StepCause = { type: "link.onUpdate", link, sourceId, view, trace };
    const result = step(defOf(subscriber.type), subscriber.state, cause, factsFor(subscriber), envFor(subscriber.type));
    if (changed(subscriber, result)) commit(subscriber, result, null);
  }

  /** A new link gets the target's current view at once (if the target exists yet). */
  function subscribe(subscriber: ActorData, def: SimDef, link: { name: string; id: string }): void {
    const source = linkedSource(def, link);
    if (source !== undefined) push(source, subscriber, [link.name]);
  }

  function applyTimers(actor: ActorData, result: StepResult): void {
    for (const op of result.effects.toTimerOps(actor.seq)) {
      actor.timers = actor.timers.filter((t) => t.key !== op.key);
      if (op.op === "schedule") {
        const { id, seq, index, name, key, payload, fireAt } = op;
        actor.timers.push({ id, seq, index, name, key, payload, fireAt });
      }
    }
    // Timers are appended in (seq, index) order and the sort is stable, so equal deadlines keep it.
    actor.timers.sort((a, b) => a.fireAt - b.fireAt);
  }

  /**
   * ctx.cancel(effectId) (ADR-018 G): the actor's calls with those ids leave pendingEffects, never to run.
   * A call cancelled because its state was left (ADR-019 B) is kept aside: its late result goes to onStale.
   */
  function cancelPending(actor: ActorData, result: StepResult): void {
    const cancels = result.effects.toTimerOps().flatMap((op) => (op.op === "cancel" ? [op] : []));
    const ofActor = (p: PendingEffect, keys: ReadonlySet<string>) =>
      keyOf(p.actor) === keyOf(actor) && keys.has(p.effectId);
    const all = new Set(cancels.map((op) => op.key));
    const stale = new Set(cancels.flatMap((op) => (op.stale === true ? [op.key] : [])));
    data.stale.push(...data.pending.filter((p) => ofActor(p, stale)));
    data.pending = data.pending.filter((p) => !ofActor(p, all));
  }

  /** Published events (ADR-017 §3) are delivered to their queue at once. */
  function publish(actor: ActorData, def: SimDef, result: StepResult): void {
    const config = publishOf(def);
    if (config === null) return;
    const { correlationId } = journalTrace(result.event.trace, eventId(actor.type, actor.id, actor.seq));
    const transition = { actorType: actor.type, actorId: actor.id, seq: actor.seq, at: data.clock, correlationId };
    for (const { body } of publishedMessages(config, result.effects.getEmitted(), transition)) {
      data.published.push({ queue: config.queue, body });
    }
  }

  /** `from`: who forwarded messages are sent as (null for transitions that cannot forward). */
  function commit(actor: ActorData, result: StepResult, from: Caller | null): void {
    const def = defOf(actor.type);
    actor.seq += 1;
    actor.state = result.state;
    for (const execution of result.effects.toExecutionEntries(actor.seq)) {
      data.pending.push({
        actor: { type: actor.type, id: actor.id },
        effectId: execution.id,
        service: execution.service,
        input: execution.input,
      });
    }
    const added = applyLinks(actor, def, result);
    applyTimers(actor, result);
    cancelPending(actor, result);
    appendJournal(actor, def, result.event);
    for (const { name, payload } of result.event.emitted ?? []) {
      data.events.push({ actor: { type: actor.type, id: actor.id }, seq: actor.seq, name, payload });
    }
    publish(actor, def, result);
    for (const forward of result.effects.toForwardEntries(actor.seq)) {
      if (from !== null) deliver(actor, def, forward, from, effectTrace(actor, forward.id));
    }
    pushViews(actor);
    for (const link of added) subscribe(actor, def, link);
  }

  /** Deliver a forward at once (its first and only try), carrying its effect to the target (ADR-016 §1). */
  function deliver(
    source: ActorData,
    def: SimDef,
    forward: { id: string; linkName: string; targetId: string; message: { type: string; [key: string]: unknown } },
    as: Caller,
    trace: Trace,
  ): void {
    const { linkName, targetId, message } = forward;
    const type = def.links?.[linkName]?.contract.name ?? linkName.toLowerCase().replace(/_/g, "-");
    const to = { type, id: targetId };
    if (data.actors[keyOf(to)] === undefined) {
      data.failedForwards.push({ from: { type: source.type, id: source.id }, to, message });
      return;
    }
    const delivery = deliveryInfo({ actorType: source.type, actorId: source.id, effectId: forward.id, attempt: 1 });
    sendTo(to, as.caller, message, { callerType: as.callerType }, { delivery, trace });
  }

  /**
   * Whether a callback's transition is committed: it changed the state or declared something (executions,
   * forwards, timers, emitted events: a transition that only emits is journaled, ADR-018 F).
   */
  function changed(actor: ActorData, result: StepResult): boolean {
    const { effects } = result;
    const declared = effects.getExecutions().length + effects.getForwards().length + effects.getEmitted().length;
    return result.alwaysJournal === true || result.state !== actor.state || declared + effects.toTimerOps().length > 0;
  }

  /** Commit a transition only when it changed something (lifecycle, service, link callbacks). */
  function commitIfChanged(actor: ActorData, result: StepResult, from: Caller | null): void {
    if (changed(actor, result)) commit(actor, result, from);
  }

  // --- Operations ---

  function sendTo(
    address: ActorAddress,
    caller: string,
    message: { type: string; [key: string]: unknown },
    options: CallerOptions = {},
    meta: { delivery?: DeliveryInfo; trace?: Trace } = {},
  ): SendOutcome {
    const actor = record(address);
    const def = defOf(actor.type);
    const callerType = options.callerType ?? "user";
    const role = resolveRole(def.roles, actor.state, caller, { callerType });
    if (role === null) return refuseNoRole(caller, callerType);
    const admission = admitStepMessage(def, role, actor.state, message, {
      caller,
      callerType,
      env: envFor(actor.type),
    });
    if (!admission.ok) return refuseAdmission(def, actor.state, role, message.type, admission, { caller, callerType });
    const cause: StepCause = {
      type: "message",
      name: message.type,
      payload: admission.payload,
      caller,
      callerType,
      role,
      delivery: meta.delivery,
      trace: meta.trace,
    };
    const result = step(def, actor.state, cause, factsFor(actor), envFor(actor.type));
    def.observe?.onTransition?.(actor.state, result.handlerState, message, { caller, role });
    commit(actor, result, { caller, callerType });
    return { ok: true };
  }

  function connect(address: ActorAddress, caller: string, options: CallerOptions = {}): SimConnection {
    const actor = record(address);
    const def = defOf(actor.type);
    const callerType = options.callerType ?? "user";
    const role = resolveRole(def.roles, actor.state, caller, { callerType });
    if (role === null)
      throw new ActorKitError("no_role", `simulate: no role matched for "${caller}" (connection refused)`);
    const slot = `${callerType}:${caller}`;
    const lifecycle = (type: "lifecycle.connect" | "lifecycle.disconnect", connectionRole: string | null) => {
      const callerConnections = actor.connections[slot] ?? 0;
      const cause: StepCause = { type, caller, callerType, callerConnections, role: connectionRole };
      commitIfChanged(actor, step(def, actor.state, cause, factsFor(actor), envFor(actor.type)), {
        caller,
        callerType,
      });
    };
    actor.connections[slot] = (actor.connections[slot] ?? 0) + 1;
    lifecycle("lifecycle.connect", role);
    let open = true;
    return {
      disconnect() {
        if (!open)
          throw new ActorKitError("connection_closed", `simulate: this connection of "${caller}" is already closed`);
        open = false;
        actor.connections[slot] = (actor.connections[slot] ?? 1) - 1;
        lifecycle("lifecycle.disconnect", null);
      },
    };
  }

  /** The effect in `list` (pending or stale calls) a bare id or a pending effect names; undefined when none. */
  function matching(list: readonly PendingEffect[], effect: PendingEffect | string): PendingEffect[] {
    return typeof effect === "string"
      ? list.filter((p) => p.effectId === effect)
      : list.filter((p) => p.effectId === effect.effectId && keyOf(p.actor) === keyOf(effect.actor));
  }

  function findPending(effect: PendingEffect | string): PendingEffect {
    const matches = matching(data.pending, effect);
    const [match] = matches;
    const id = typeof effect === "string" ? effect : effect.effectId;
    if (match === undefined) throw new ActorKitError("unknown_effect", `simulate: No pending effect "${id}"`);
    if (matches.length > 1) {
      throw new ActorKitError(
        "unknown_effect",
        `simulate: effect id "${id}" is ambiguous (${matches.length} actors); pass the pending effect`,
      );
    }
    return match;
  }

  function settle(effect: PendingEffect | string, cause: (p: PendingEffect) => StepCause): void {
    const pending = findPending(effect);
    // The cause first: a rejection that does not parse throws before the effect is settled.
    const settled = cause(pending);
    data.pending = data.pending.filter((p) => p !== pending);
    const actor = record(pending.actor);
    const traced = { ...settled, trace: effectTrace(actor, pending.effectId) };
    const result = step(defOf(actor.type), actor.state, traced, factsFor(actor), envFor(actor.type));
    if (changed(actor, result)) commit(actor, result, null);
  }

  /**
   * A late result for a call whose state was left (ADR-019 B): resolved, it is a `service.stale` transition
   * (onStale, or journaled and ignored); rejected, it is dropped. False when the effect is not stale.
   */
  function settleStale(effect: PendingEffect | string, result: { readonly value: unknown } | null): boolean {
    const [late] = matching(data.stale, effect);
    if (late === undefined) return false;
    data.stale = data.stale.filter((p) => p !== late);
    if (result === null) return true;
    const actor = record(late.actor);
    const cause: StepCause = {
      type: "service.stale",
      service: late.service,
      input: late.input,
      result: resultOf(late, result.value),
      effectId: late.effectId,
      trace: effectTrace(actor, late.effectId),
    };
    commitIfChanged(actor, step(defOf(actor.type), actor.state, cause, factsFor(actor), envFor(actor.type)), null);
    return true;
  }

  /** A resolved result as onDone gets it (ADR-018 G): parsed by the service's `result`, within its size limit. */
  function resultOf(pending: PendingEffect, result: unknown): unknown {
    const service = defOf(pending.actor.type).services?.[pending.service] ?? {};
    const parsed = parseServiceResult(pending.service, resolveServiceOptions(pending.service, service), result);
    if (!parsed.ok) throw new ActorKitError("invalid_result", `simulate: ${parsed.error.message}`);
    return parsed.value;
  }

  function nextDueTimer(until: number): { actor: ActorData; timer: ActorData["timers"][number] } | null {
    let best: { actor: ActorData; timer: ActorData["timers"][number] } | null = null;
    for (const actor of Object.values(data.actors)) {
      const timer = actor.timers[0];
      if (timer !== undefined && timer.fireAt <= until && (best === null || timer.fireAt < best.timer.fireAt)) {
        best = { actor, timer };
      }
    }
    return best;
  }

  function fire(actor: ActorData, timer: ActorData["timers"][number]): void {
    data.clock = Math.max(data.clock, timer.fireAt);
    actor.timers = actor.timers.filter((t) => t !== timer);
    const { id, name, key, payload, fireAt } = timer;
    const trace = effectTrace(actor, id);
    const cause: StepCause = { type: "timer", id, name, key, payload, fireAt, lateBy: data.clock - fireAt, trace };
    commit(actor, step(defOf(actor.type), actor.state, cause, factsFor(actor), envFor(actor.type)), {
      caller: `timer:${name}`,
      callerType: "service",
    });
  }

  function advance(duration: Duration): void {
    const until = data.clock + parseDuration(duration);
    for (let firings = 0; ; firings++) {
      const due = nextDueTimer(until);
      if (due === null) break;
      if (firings >= MAX_TIMER_FIRINGS) {
        throw new ActorKitError(
          "timer_loop",
          `simulate: more than ${MAX_TIMER_FIRINGS} timers fired in one advance (a timer loop?)`,
        );
      }
      fire(due.actor, due.timer);
    }
    data.clock = until;
  }

  // --- Handles ---

  function handle(address: ActorAddress): SimActor<AnyContract> {
    return {
      type: address.type,
      id: address.id,
      get state() {
        return record(address).state;
      },
      get journal() {
        const { events, checkpoints } = record(address).journal;
        return { events: [...events], checkpoints: [...checkpoints] };
      },
      get timers() {
        return record(address).timers.map(({ id, name, key, payload, fireAt }) => ({ id, name, key, payload, fireAt }));
      },
      get links() {
        return [...record(address).links];
      },
      send: (caller, message, options) => sendTo(address, caller, message, options),
      role(caller, options = {}) {
        const actor = record(address);
        return resolveRole(defOf(actor.type).roles, actor.state, caller, { callerType: options.callerType ?? "user" });
      },
      view(caller, options = {}) {
        const actor = record(address);
        const def = defOf(actor.type);
        const role = resolveRole(def.roles, actor.state, caller, { callerType: options.callerType ?? "user" });
        if (role === null) throw new ActorKitError("no_role", `simulate: no role matched for "${caller}"`);
        const viewDef = def.views[role];
        if (viewDef === undefined) throw new ActorKitError("no_view", `simulate: no view for role "${role}"`);
        return viewDef.fn(actor.state, caller);
      },
      connect: (caller, options) => connect(address, caller, options),
    };
  }

  async function initLink(name: string, id: string, def: SimDef): Promise<unknown> {
    const target = def.links?.[name];
    if (target === undefined)
      throw new ActorKitError("undeclared_link", `Link "${name}" not declared in actor definition`);
    const linked = handle({ type: target.contract.name, id });
    const role = linked.role("system", { callerType: "service" });
    if (role === null) throw new ActorKitError("link_unavailable", `Link "${name}": no role for the linking actor`);
    const view = LinkedViewSchema.safeParse(linked.view("system", { callerType: "service" }));
    if (!view.success) {
      throw new ActorKitError(
        "link_unavailable",
        `Link "${name}": the target's view is not an object: ${view.error.issues[0]?.message}`,
      );
    }
    return { role, ...view.data };
  }

  /** What spawning needs before init runs: the def, the parsed input, the caller and live facts. */
  function prepareSpawn(
    def: SimDef,
    contract: AnyContract,
    id: string,
    input: unknown,
    options: { caller?: string; callerType?: "user" | "service" },
  ) {
    const address = { type: contract.name, id };
    if (data.actors[keyOf(address)] !== undefined)
      throw new ActorKitError("already_spawned", `simulate: ${keyOf(address)} is already spawned`);
    publishOf(def);
    const parsed = def.input.safeParse(input);
    if (!parsed.success) throw new ActorKitError("invalid_input", `Invalid input: ${parsed.error.message}`);
    const live = createLiveFacts(sources);
    const facts = { ...liveStepFacts(live, () => []), guard: withDeterminismGuard };
    const cause = {
      input: parsed.data,
      caller: options.caller ?? "system",
      callerType: options.callerType ?? "service",
    };
    return { address, live, facts, cause };
  }

  /** Store a spawned actor (its init committed) and subscribe its init links. */
  function placeSpawned(
    def: SimDef,
    address: ActorAddress,
    init: { state: unknown; event: StepResult["event"] },
    links: Array<{ name: string; id: string }>,
  ): SimActor<AnyContract> {
    const actor: ActorData = {
      ...address,
      state: init.state,
      seq: 1,
      journal: { events: [], checkpoints: [] },
      timers: [],
      links,
      connections: {},
      pushed: {},
    };
    data.actors[keyOf(address)] = actor;
    appendJournal(actor, def, init.event);
    for (const link of links) subscribe(actor, def, link);
    return handle(address);
  }

  function spawn(
    contract: AnyContract,
    id: string,
    input: unknown,
    options: { caller?: string; callerType?: "user" | "service" } = {},
  ): Promise<SimActor<AnyContract>> {
    // An invalid contract throws at once (as it always has); everything else rejects the promise.
    const def = register(contract);
    return (async () => {
      const { address, live, facts, cause } = prepareSpawn(def, contract, id, input, options);
      const links: Array<{ name: string; id: string }> = [];
      const link = async (name: string, targetId: string) => {
        const view = await initLink(name, targetId, def);
        live.recordLinkView(name, targetId, view);
        links.push({ name, id: targetId });
        return view;
      };
      const init = await stepInit(def, cause, facts, { env: envFor(contract.name), link });
      return placeSpawned(def, address, init, links);
    })();
  }

  function spawnSync(
    contract: AnyContract,
    id: string,
    input: unknown,
    options: { caller?: string; callerType?: "user" | "service" } = {},
  ): SimActor<AnyContract> {
    const def = register(contract);
    const { address, facts, cause } = prepareSpawn(def, contract, id, input, options);
    const link = (name: string): Promise<unknown> => {
      throw new ActorKitError(
        "link_unavailable",
        `simulate: "${contract.name}" links in init (link "${name}"): spawnSync cannot wait for the view. Use await sim.spawn().`,
      );
    };
    const onAsync = () =>
      new ActorKitError(
        "async_handler",
        `simulate: "${contract.name}" has an async init: spawnSync needs a synchronous init. Use await sim.spawn().`,
      );
    const init = stepInitSync(def, cause, facts, { env: envFor(contract.name), link, onAsync });
    return placeSpawned(def, address, init, []);
  }

  function actor(contract: AnyContract, id: string): SimActor<AnyContract> {
    record({ type: contract.name, id });
    return handle({ type: contract.name, id });
  }

  // Typed per contract for callers; the implementations parse inputs and messages at runtime.
  function spawnTyped<C extends AnyContract>(
    contract: C,
    id: string,
    input: ContractInput<C>,
    options?: { caller?: string; callerType?: "user" | "service" },
  ): Promise<SimActor<C>>;
  function spawnTyped(
    contract: AnyContract,
    id: string,
    input: unknown,
    options?: { caller?: string; callerType?: "user" | "service" },
  ): Promise<SimActor<AnyContract>>;
  function spawnTyped(
    contract: AnyContract,
    id: string,
    input: unknown,
    options?: { caller?: string; callerType?: "user" | "service" },
  ): Promise<SimActor<AnyContract>> {
    return spawn(contract, id, input, options);
  }

  function spawnSyncTyped<C extends AnyContract>(
    contract: C,
    id: string,
    input: ContractInput<C>,
    options?: { caller?: string; callerType?: "user" | "service" },
  ): SimActor<C>;
  function spawnSyncTyped(
    contract: AnyContract,
    id: string,
    input: unknown,
    options?: { caller?: string; callerType?: "user" | "service" },
  ): SimActor<AnyContract>;
  function spawnSyncTyped(
    contract: AnyContract,
    id: string,
    input: unknown,
    options?: { caller?: string; callerType?: "user" | "service" },
  ): SimActor<AnyContract> {
    return spawnSync(contract, id, input, options);
  }

  function actorTyped<C extends AnyContract>(contract: C, id: string): SimActor<C>;
  function actorTyped(contract: AnyContract, id: string): SimActor<AnyContract>;
  function actorTyped(contract: AnyContract, id: string): SimActor<AnyContract> {
    return actor(contract, id);
  }

  function sendTyped<C extends AnyContract>(
    contract: C,
    id: string,
    caller: string,
    message: ContractMessages<C>,
    options?: CallerOptions,
  ): SendOutcome;
  function sendTyped(
    contract: AnyContract,
    id: string,
    caller: string,
    message: { type: string; [key: string]: unknown },
    options?: CallerOptions,
  ): SendOutcome;
  function sendTyped(
    contract: AnyContract,
    id: string,
    caller: string,
    message: { type: string; [key: string]: unknown },
    options?: CallerOptions,
  ): SendOutcome {
    return sendTo({ type: contract.name, id }, caller, message, options);
  }

  const simulation: Simulation = {
    get now() {
      return data.clock;
    },
    spawn: spawnTyped,
    spawnSync: spawnSyncTyped,
    actor: actorTyped,
    send: sendTyped,
    pendingEffects: () => [...data.pending],
    resolve: (effect, result) =>
      settleStale(effect, { value: result }) ||
      settle(effect, (p) => ({
        type: "service.onDone",
        service: p.service,
        input: p.input,
        result: resultOf(p, result),
        effectId: p.effectId,
      })),
    reject: (effect, error) =>
      settleStale(effect, null) ||
      settle(effect, (p) => ({
        type: "service.onError",
        service: p.service,
        input: p.input,
        error: errorOf(error, p.service, defOf(p.actor.type).services?.[p.service]?.errors),
        effectId: p.effectId,
      })),
    advance,
    failedForwards: () => [...data.failedForwards],
    events: () => [...data.events],
    published: (queue) => data.published.filter((p) => p.queue === queue).map((p) => p.body),
    branch: () => createSimulation(new Map(contracts), structuredClone(data), env),
  };
  return simulation;
}
