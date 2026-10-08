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
 * - `branch()` copies the whole simulation, so alternative futures can be explored.
 *
 * Not simulated: link view pushes between actors (link() and unlink() are recorded on the actor).
 */

import type { ContractMessages, Duration } from "@actor-kit/core";
import {
  admitMessage,
  checksumState,
  createLiveFacts,
  type Journal,
  type JournalCheckpoint,
  type JournalEvent,
  liveStepFacts,
  parseDuration,
  resolveJournalConfig,
  resolveRole,
  type StepCause,
  type StepResult,
  step,
  stepInit,
} from "@actor-kit/worker/testing";
import type { ContractInput, ContractState } from "./contract-types";
import { nextRandom, uuidFrom } from "./seeded";
import { type SimDef, toSimDef } from "./sim-def";

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

export type SendOutcome = { ok: true } | { ok: false; error: string; detail?: string };

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
  /** Settle an execution as failed for good: runs its onError. */
  reject(effect: PendingEffect | string, error: string | { message: string }): void;
  /** Move the clock forward, firing every timer that comes due on the way. */
  advance(duration: Duration): void;
  /** Forwards whose target actor was never spawned. */
  failedForwards(): FailedForward[];
  /** An independent copy of the whole simulation. */
  branch(): Simulation;
}

export interface SimulateOptions {
  /** Contracts that forwards and init links can reach by name. Spawned contracts are added too. */
  readonly contracts?: readonly AnyContract[];
  readonly seed?: number;
  /** Start time of the virtual clock (default 0). */
  readonly now?: number;
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
}

interface SimData {
  clock: number;
  rng: number;
  actors: Record<string, ActorData>;
  pending: PendingEffect[];
  failedForwards: FailedForward[];
}

const MAX_TIMER_FIRINGS = 10_000;

const keyOf = (address: ActorAddress): string => `${address.type}/${address.id}`;

function errorOf(error: string | { message: string }): { message: string } {
  return typeof error === "string" ? { message: error } : { message: error.message };
}

/** Run a simulation of actors on a virtual clock. */
export function simulate(options: SimulateOptions = {}): Simulation {
  const contracts = new Map<string, { contract: AnyContract; def: SimDef }>();
  for (const contract of options.contracts ?? []) contracts.set(contract.name, { contract, def: toSimDef(contract) });
  return createSimulation(
    contracts,
    { clock: options.now ?? 0, rng: options.seed ?? 1, actors: {}, pending: [], failedForwards: [] },
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

  function defOf(type: string): SimDef {
    const entry = contracts.get(type);
    if (entry === undefined) throw new Error(`simulate: unknown contract "${type}"`);
    return entry.def;
  }

  function register(contract: AnyContract): SimDef {
    const known = contracts.get(contract.name);
    if (known !== undefined) return known.def;
    const def = toSimDef(contract);
    contracts.set(contract.name, { contract, def });
    return def;
  }

  function record(address: ActorAddress): ActorData {
    const actor = data.actors[keyOf(address)];
    if (actor === undefined) throw new Error(`simulate: ${keyOf(address)} has not been spawned`);
    return actor;
  }

  function factsFor(actor: ActorData) {
    const live = createLiveFacts(sources);
    return liveStepFacts(live, (name) => actor.links.filter((l) => l.name === name).map((l) => l.id));
  }

  // --- Commit: the simulated counterpart of actor.ts commit() + writeEffects() ---

  function appendJournal(actor: ActorData, def: SimDef, event: StepResult["event"]): void {
    const config = resolveJournalConfig(def.journal);
    if (!config.enabled) return;
    const checksum = checksumState(def, actor.state);
    actor.journal.events.push({
      ...event,
      seq: actor.seq,
      codeVersion: def.version ?? 1,
      stateChecksum: checksum,
      createdAt: data.clock,
    });
    if (actor.seq % config.checkpointEvery === 0) {
      const state = JSON.stringify(def.serialize ? def.serialize(actor.state) : actor.state);
      actor.journal.checkpoints.push({ seq: actor.seq, version: def.version ?? 1, state, checksum });
    }
  }

  function applyLinks(actor: ActorData, def: SimDef, result: StepResult): void {
    for (const link of result.effects.getLinks()) {
      const declared = def.links?.[link.name] !== undefined;
      const present = actor.links.some((l) => l.name === link.name && l.id === link.id);
      if (declared && !present) actor.links.push(link);
    }
    for (const unlink of result.effects.getUnlinks()) {
      actor.links = actor.links.filter(
        (l) => l.name !== unlink.name || (unlink.id !== undefined && l.id !== unlink.id),
      );
    }
  }

  function applyTimers(actor: ActorData, result: StepResult): void {
    for (const op of result.effects.toTimerOps(actor.seq)) {
      actor.timers = actor.timers.filter((t) => t.key !== op.key);
      if (op.op === "schedule") {
        const { id, seq, index, name, key, payload, fireAt } = op;
        actor.timers.push({ id, seq, index, name, key, payload, fireAt });
      }
    }
    actor.timers.sort((a, b) => a.fireAt - b.fireAt || a.seq - b.seq || a.index - b.index);
  }

  function commit(actor: ActorData, result: StepResult, caller: string, callerType: "user" | "service"): void {
    const def = defOf(actor.type);
    actor.seq += 1;
    actor.state = result.state;
    appendJournal(actor, def, result.event);
    for (const execution of result.effects.toExecutionEntries(actor.seq)) {
      data.pending.push({
        actor: { type: actor.type, id: actor.id },
        effectId: execution.id,
        service: execution.service,
        input: execution.input,
      });
    }
    applyLinks(actor, def, result);
    applyTimers(actor, result);
    for (const forward of result.effects.toForwardEntries(actor.seq)) {
      deliver(actor, def, forward.linkName, forward.targetId, forward.message, caller, callerType);
    }
  }

  function deliver(
    from: ActorData,
    def: SimDef,
    linkName: string,
    targetId: string,
    message: { type: string; [key: string]: unknown },
    caller: string,
    callerType: "user" | "service",
  ): void {
    const type = def.links?.[linkName]?.contract.name ?? linkName.toLowerCase().replace(/_/g, "-");
    const to = { type, id: targetId };
    if (data.actors[keyOf(to)] === undefined) {
      data.failedForwards.push({ from: { type: from.type, id: from.id }, to, message });
      return;
    }
    sendTo(to, caller, message, { callerType });
  }

  /** Commit a transition only when it changed something (lifecycle, service, link callbacks). */
  function commitIfChanged(actor: ActorData, result: StepResult, caller: string, callerType: "user" | "service"): void {
    const effects = result.effects.getExecutions().length + result.effects.getForwards().length;
    const timers = result.effects.toTimerOps().length;
    if (result.state !== actor.state || effects + timers > 0) commit(actor, result, caller, callerType);
  }

  // --- Operations ---

  function sendTo(
    address: ActorAddress,
    caller: string,
    message: { type: string; [key: string]: unknown },
    options: CallerOptions = {},
  ): SendOutcome {
    const actor = record(address);
    const def = defOf(actor.type);
    const callerType = options.callerType ?? "user";
    const role = resolveRole(def.roles, actor.state, caller, { callerType });
    if (role === null) return { ok: false, error: "No role matched" };
    const admission = admitMessage(def.messages ?? {}, role, actor.state, message, { caller, callerType, env });
    if (!admission.ok) return admission;
    const cause: StepCause = {
      type: "message",
      name: message.type,
      payload: admission.payload,
      caller,
      callerType,
      role,
    };
    const result = step(def, actor.state, cause, factsFor(actor), env);
    def.observe?.onTransition?.(actor.state, result.handlerState, message, { caller, role });
    commit(actor, result, caller, callerType);
    return { ok: true };
  }

  function connect(address: ActorAddress, caller: string, options: CallerOptions = {}): SimConnection {
    const actor = record(address);
    const def = defOf(actor.type);
    const callerType = options.callerType ?? "user";
    const role = resolveRole(def.roles, actor.state, caller, { callerType });
    if (role === null) throw new Error(`simulate: no role matched for "${caller}" (connection refused)`);
    const slot = `${callerType}:${caller}`;
    const lifecycle = (type: "lifecycle.connect" | "lifecycle.disconnect", connectionRole: string | null) => {
      const callerConnections = actor.connections[slot] ?? 0;
      const cause: StepCause = { type, caller, callerType, callerConnections, role: connectionRole };
      commitIfChanged(actor, step(def, actor.state, cause, factsFor(actor), env), caller, callerType);
    };
    actor.connections[slot] = (actor.connections[slot] ?? 0) + 1;
    lifecycle("lifecycle.connect", role);
    let open = true;
    return {
      disconnect() {
        if (!open) throw new Error(`simulate: this connection of "${caller}" is already closed`);
        open = false;
        actor.connections[slot] = (actor.connections[slot] ?? 1) - 1;
        lifecycle("lifecycle.disconnect", null);
      },
    };
  }

  function findPending(effect: PendingEffect | string): PendingEffect {
    const matches =
      typeof effect === "string"
        ? data.pending.filter((p) => p.effectId === effect)
        : data.pending.filter((p) => p.effectId === effect.effectId && keyOf(p.actor) === keyOf(effect.actor));
    const [match] = matches;
    const id = typeof effect === "string" ? effect : effect.effectId;
    if (match === undefined) throw new Error(`simulate: No pending effect "${id}"`);
    if (matches.length > 1) {
      throw new Error(`simulate: effect id "${id}" is ambiguous (${matches.length} actors); pass the pending effect`);
    }
    return match;
  }

  function settle(effect: PendingEffect | string, cause: (p: PendingEffect) => StepCause): void {
    const pending = findPending(effect);
    data.pending = data.pending.filter((p) => p !== pending);
    const actor = record(pending.actor);
    const result = step(defOf(actor.type), actor.state, cause(pending), factsFor(actor), env);
    if (result.state !== actor.state) commit(actor, result, "service", "service");
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
    const cause: StepCause = { type: "timer", id, name, key, payload, fireAt, lateBy: data.clock - fireAt };
    commit(actor, step(defOf(actor.type), actor.state, cause, factsFor(actor), env), `timer:${name}`, "service");
  }

  function advance(duration: Duration): void {
    const until = data.clock + parseDuration(duration);
    for (let firings = 0; ; firings++) {
      const due = nextDueTimer(until);
      if (due === null) break;
      if (firings >= MAX_TIMER_FIRINGS) {
        throw new Error(`simulate: more than ${MAX_TIMER_FIRINGS} timers fired in one advance (a timer loop?)`);
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
        if (role === null) throw new Error(`simulate: no role matched for "${caller}"`);
        const viewDef = def.views[role];
        if (viewDef === undefined) throw new Error(`simulate: no view for role "${role}"`);
        return viewDef.fn(actor.state, caller);
      },
      connect: (caller, options) => connect(address, caller, options),
    };
  }

  async function initLink(name: string, id: string, def: SimDef): Promise<unknown> {
    const target = def.links?.[name];
    if (target === undefined) throw new Error(`Link "${name}" not declared in actor definition`);
    const linked = handle({ type: target.contract.name, id });
    const role = linked.role("system", { callerType: "service" });
    if (role === null) throw new Error(`Link "${name}": no role for the linking actor`);
    const view = linked.view("system", { callerType: "service" });
    return { role, ...(typeof view === "object" && view !== null ? view : {}) };
  }

  function spawn(
    contract: AnyContract,
    id: string,
    input: unknown,
    options: { caller?: string; callerType?: "user" | "service" } = {},
  ): Promise<SimActor<AnyContract>> {
    const def = register(contract);
    const address = { type: contract.name, id };
    return (async () => {
      if (data.actors[keyOf(address)] !== undefined) throw new Error(`simulate: ${keyOf(address)} is already spawned`);
      const parsed = def.input.safeParse(input);
      if (!parsed.success) throw new Error(`Invalid input: ${parsed.error.message}`);
      const actor: ActorData = {
        ...address,
        state: undefined,
        seq: 0,
        journal: { events: [], checkpoints: [] },
        timers: [],
        links: [],
        connections: {},
      };
      const links: Array<{ name: string; id: string }> = [];
      const live = createLiveFacts(sources);
      const facts = liveStepFacts(live, () => []);
      const link = async (name: string, targetId: string) => {
        const view = await initLink(name, targetId, def);
        live.recordLinkView(name, targetId, view);
        links.push({ name, id: targetId });
        return view;
      };
      const caller = {
        input: parsed.data,
        caller: options.caller ?? "system",
        callerType: options.callerType ?? "service",
      };
      const init = await stepInit(def, caller, facts, { env, link });
      actor.seq = 1;
      actor.state = init.state;
      actor.links = links;
      data.actors[keyOf(address)] = actor;
      appendJournal(actor, def, init.event);
      return handle(address);
    })();
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
    actor: actorTyped,
    send: sendTyped,
    pendingEffects: () => [...data.pending],
    resolve: (effect, result) =>
      settle(effect, (p) => ({ type: "service.onDone", service: p.service, input: p.input, result })),
    reject: (effect, error) =>
      settle(effect, (p) => ({ type: "service.onError", service: p.service, input: p.input, error: errorOf(error) })),
    advance,
    failedForwards: () => [...data.failedForwards],
    branch: () => createSimulation(new Map(contracts), structuredClone(data), env),
  };
  return simulation;
}
