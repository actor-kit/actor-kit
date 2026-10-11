/**
 * Errors that teach (ADR-018 C): every error the library throws, and every refusal it returns, carries a
 * stable `code` and a `docs` URL (`https://actorkit.dev/errors/<code>/`). `ERROR_CODES` is the registry:
 * each code's one-line meaning and how to fix it. The website's error pages are generated from it, and a
 * test checks that every code has its page.
 */

export const ERRORS_DOCS_BASE = "https://actorkit.dev/errors/";

/** What a code means and how to fix it (the docs page is built from these). */
export interface ErrorCodeInfo {
  readonly title: string;
  readonly fix: string;
}

export const ERROR_CODES = {
  // --- Refusals: a message was not accepted (returned, not thrown, by the runtime) ---
  unknown_message: {
    title: "The actor has no message of that name for the caller's role (and current state).",
    fix: "Send one of the names in `expected`, or add the message to the role's `messages` (or to the state that should accept it).",
  },
  invalid_payload: {
    title: "The message's payload does not match its schema.",
    fix: "Fix the fields named in `details` (Zod issues) and send the message again.",
  },
  guard_failed: {
    title: "The message's guard returned false for this caller in the current state.",
    fix: "Send the message only when its guard holds, or change the guard.",
  },
  wrong_state: {
    title: "The message is declared only by other states than the one the actor is in.",
    fix: "Send it while the actor is in one of the states in `expected`, or declare it in the current state or at the top level.",
  },
  no_role: {
    title: "No role predicate matched the caller.",
    fix: "Add a catch-all role (e.g. `viewer: () => true`) last in `roles`, or check the token's `sub` and `act` claims.",
  },
  not_initialized: {
    title: "The actor has not been spawned yet.",
    fix: "Spawn it (`spawn({ input })`, or connect with input) before sending messages.",
  },
  invalid_delivery: {
    title: "A forwarded message carried delivery metadata that does not parse.",
    fix: "Send forwards only through `ctx.forward()`; do not build the metadata by hand.",
  },
  // --- Definitions ---
  invalid_actor_definition: {
    title: "An actor definition is missing a required part or is not an actor contract.",
    fix: "Define actors with `kit.actor(name, { input, init, roles, views, ... })` and pass the contract it returns.",
  },
  invalid_versions: {
    title: "The `versions` chain is malformed, or a state does not match its version's schema.",
    fix: "List versions in increasing order, starting with `version(1, Schema)`; each later step takes the previous version's state.",
  },
  no_version_path: {
    title: "There is no step in `versions` from a persisted version to the current one.",
    fix: "Keep every version that may still be persisted in the chain, with a `state` step from its predecessor.",
  },
  invalid_retry: {
    title: "A service's or link's `retry` option is invalid.",
    fix: "Use `{ attempts?: positive integer, backoff?: { baseMs, factor, maxMs, jitter }, while?: (error) => boolean }`.",
  },
  invalid_timeout: {
    title: "A `timeoutMs` option is not a positive number of milliseconds.",
    fix: "Pass a positive, finite number of ms (default 30 000).",
  },
  invalid_service_option: {
    title: "A service declares an invalid option (`delivery`, `result` or a reserved name).",
    fix: 'Use `delivery: "at-least-once" | "at-most-once"`, a Zod `result` schema, and a service name that does not start with `__`.',
  },
  invalid_publish: {
    title: "The `publish` option names no queue, an undeclared event, or a reserved service.",
    fix: 'Set `publish: { queue: "BINDING", events: [names declared in events] }`.',
  },
  invalid_journal_option: {
    title: "A `journal` option is invalid.",
    fix: "Use `journal: false`, or `{ keep?: positive integer, checkpointEvery?: positive integer }`.",
  },
  invalid_redact_pattern: {
    title: "A `studio.redact` pattern is empty or malformed.",
    fix: "Write dotted paths such as `players.*.token` or `**.secret`; `*` and `**` must be whole segments.",
  },
  invalid_determinism_option: {
    title: "The `determinism` option is not one of the allowed values.",
    fix: 'Use `determinism: "throw" | "warn" | "off"` (default `"warn"`).',
  },
  missing_initial: {
    title: "An actor with `states` has no `initial` state.",
    fix: 'Add `initial: "<state name>"` to the definition.',
  },
  initial_state_local: {
    title: "The initial state declares a local, but nothing exists yet to build it from.",
    fix: "Start in a state without a local and `goto` the state with the local from a message or `enter`.",
  },
  // --- Handlers ---
  async_handler: {
    title: "A handler returned a Promise. Handlers are synchronous reducers.",
    fix: "Return the next state synchronously; move async work into a service and call it with `ctx.execute()`.",
  },
  undeclared_event: {
    title: "`ctx.emit` named an event the actor does not declare.",
    fix: "Declare the event in `setup({ events })` and define the actor with `kit.actor(...)`.",
  },
  invalid_event_payload: {
    title: "An emitted event's payload does not match its schema.",
    fix: "Emit a payload that parses with the event's schema in `events`.",
  },
  undeclared_timer: {
    title: "`ctx.schedule` named a timer the actor (or its current state) does not declare.",
    fix: "Declare it in the actor's `timers` (or the state's `timers`) with `timer(schema, handler)`.",
  },
  invalid_timer_payload: {
    title: "A scheduled timer's payload does not match its schema.",
    fix: "Pass a `payload` that parses with the timer's schema.",
  },
  invalid_schedule: {
    title: "`ctx.schedule` options are invalid.",
    fix: 'Pass exactly one of `in` (a duration such as `"30s"`) and `at` (a finite time in ms).',
  },
  invalid_duration: {
    title: "A duration is not a number of ms or a number with a unit.",
    fix: 'Use ms (`500`) or a string such as `"500ms"`, `"30s"`, `"5m"`, `"2h"`, `"1d"`.',
  },
  undeclared_state: {
    title: "`goto` (or a persisted phase) names a state the actor does not declare.",
    fix: "Declare the state in `setup({ states })` and in the actor's `states`.",
  },
  invalid_local: {
    title: "A state's local does not match its schema.",
    fix: "Return a local from `enter` / `ctx.stay(shared, local)` that parses with the state's `local` schema.",
  },
  missing_state_input: {
    title: "A state that declares an enter `input` was entered on the way to another state (or as an `initial` child).",
    fix: "Goto that state itself (a goto's input goes to its target only), or drop its `input` and build its local from `ctx.local`.",
  },
  invalid_scope: {
    title: '`ctx.execute(..., { scope: "state" })` was called where no state can own the call.',
    fix: "Make scoped calls from a state's message, timer or `enter` (not `exit`, not a top-level handler of an actor without states).",
  },
  invalid_transition: {
    title: "`enter` or `exit` returned a `goto` (or `exit` returned `stay`).",
    fix: "`enter` returns its local or `ctx.stay(shared, local)`; `exit` returns the next shared state. Move to another state from a message or timer.",
  },
  archive_missing: {
    title: "An archived journal segment recorded by the actor is not in its R2 bucket.",
    fix: "Check the bucket the `journal.archive` binding points at (and its lifecycle rules); segments must not be deleted while the actor may read them.",
  },
  archive_unbound: {
    title: "`journal.archive` names a binding that is not an R2 bucket in the Worker env.",
    fix: "Add the bucket to wrangler.jsonc (`r2_buckets`) under the name `journal.archive` gives.",
  },
  invalid_archive_segment: {
    title: "An archived journal segment in R2 is not NDJSON of journal rows.",
    fix: "Do not edit archived segments by hand; restore the object from a backup of the bucket.",
  },
  invalid_phased_state: {
    title: "The persisted state of an actor with states is not `{ shared, phase, locals, stateTimers }`.",
    fix: "Do not write the persisted state by hand; restore or migrate through `versions`.",
  },
  nondeterminism: {
    title:
      "A handler read the clock or randomness directly (Date.now, new Date(), Math.random, crypto.randomUUID, ...).",
    fix: "Use `ctx.now()`, `ctx.random()` or `ctx.id()`: they are recorded in the journal, so replay reproduces them.",
  },
  invalid_result: {
    title: "A service's result does not match its `result` schema, or is larger than the size limit.",
    fix: "Return a value that parses with `result` (and stays under the limit); return a reference (an id or a URL) for large data.",
  },
  // --- Env, bindings, links, refs ---
  invalid_env: {
    title: "The Worker env does not match the actor's `env` schema (a binding is missing or of the wrong kind).",
    fix: "Add or fix each binding named in the message in wrangler.jsonc (or pass matching fakes in tests).",
  },
  queue_not_bound: {
    title: "The Queue binding `publish.queue` names is not bound in the Worker env.",
    fix: "Add the queue producer binding to wrangler.jsonc (`queues.producers`).",
  },
  undeclared_link: {
    title: "A link name is not declared in the actor's `links`.",
    fix: "Declare it: `links: { name: link(TargetContract, { onUpdate }) }`.",
  },
  link_unavailable: {
    title: "A link could not be made or read: the target is unreachable or has no role/view for the linking actor.",
    fix: "Make sure the target actor exists, gives the linking actor (a service caller) a role, and its view is an object.",
  },
  actor_not_found: {
    title:
      "No Durable Object namespace was found for an actor type, or the binding is not an actor-kit Durable Object.",
    fix: "Export the actor class from the Worker (ctx.exports) or add a Durable Object binding for it in wrangler.jsonc.",
  },
  invalid_ref: {
    title: "`createRef` was called with the wrong arguments.",
    fix: "Call `createRef(contract, env, id)` or `createRef(contract, ctx.exports, env, id)` with a string id.",
  },
  invalid_input: {
    title: "The spawn input does not match the actor's `input` schema, or the actor needs input it was not given.",
    fix: "Pass an input that parses with `input` (spawn it with `spawn({ input })` before connecting).",
  },
  no_view: {
    title: "The caller's role has no view.",
    fix: "Add a view for the role in `views` (every role a client can connect with needs one).",
  },
  invalid_token: {
    title: "The JWT is not valid for this actor (wrong actor id or type, missing `sub`, or an invalid `act`).",
    fix: "Mint the token with `createAccessToken({ actorType, actorId, callerId, callerType })` for this actor.",
  },
  // --- Journal ---
  journal_divergence: {
    title: "Replaying the journal gave a different state than was recorded.",
    fix: "A handler changed behaviour or reads something unrecorded: use ctx.now/ctx.random/ctx.id, or add a `versions` step for the change.",
  },
  journal_emitted_divergence: {
    title: "Replaying the journal emitted different domain events than were recorded.",
    fix: "Keep emitted events stable, or upcast old ones in a `versions` step (`emitted: { Name: (old) => new }`).",
  },
  journal_nondeterminism: {
    title: "A handler read a fact on replay that the journal did not record.",
    fix: "Read time, ids and randomness only through ctx.now(), ctx.id() and ctx.random().",
  },
  journal_version: {
    title: "A journal event was written by a version with no path to the current one.",
    fix: "Keep that version in `versions` with a step to its successor.",
  },
  journal_invalid: {
    title: "The journal is incomplete or out of order for what was asked of it.",
    fix: "Replay a whole journal (from init or a checkpoint) as `readJournal()` returns it.",
  },
  restore_out_of_range: {
    title: "`restore` was asked for a seq the journal cannot rebuild.",
    fix: "Restore to a seq between the oldest kept checkpoint and the newest event, written by the current version.",
  },
  // --- Studio ---
  studio_disabled: {
    title: "Studio is not enabled for this actor.",
    fix: "Set `studio: true` (or a studio config) on the actor, and mount `actorKitStudio()` in the Worker.",
  },
  studio_unavailable: {
    title: "Studio is missing a secret or got invalid options.",
    fix: "Set `STUDIO_CALLER_HASH_KEY` for agent access, and pass Studio options as documented.",
  },
  studio_request_failed: {
    title: "The Studio API answered with an error or something that is not Studio.",
    fix: "Check the Studio URL (ACTOR_KIT_STUDIO_URL), your access token and the status in the message.",
  },
  cli_usage: {
    title: "The `actor-kit studio` command line is incomplete or invalid.",
    fix: "Run `actor-kit studio --help` and pass the arguments it lists.",
  },
  // --- Client and React ---
  invalid_frame: {
    title: "A frame from the server could not be read.",
    fix: "Use the same @actor-kit version on the client and the Worker.",
  },
  missing_host: {
    title: "The client has no host to connect to (no window.location).",
    fix: "Pass `host` when creating the client outside a browser (server-side rendering, tests, React Native).",
  },
  headers_in_browser: {
    title: "`getHeaders` was used in a browser, which cannot set WebSocket upgrade headers.",
    fix: "Use `getToken` in browsers; `getHeaders` is for React Native and Node.",
  },
  missing_provider: {
    title: "A React hook was used outside its actor context's `<Provider>`.",
    fix: "Render the component inside `<ActorContext.Provider>`.",
  },
  // --- Test harness ---
  not_spawned: {
    title: "The simulation has no actor with that type and id.",
    fix: "Call `sim.spawn(contract, id, input)` first.",
  },
  already_spawned: {
    title: "An actor with that type and id is already spawned in the simulation.",
    fix: "Use a different id, or `sim.actor(contract, id)` to get the existing one.",
  },
  unknown_effect: {
    title: "No pending effect matches the id, or the id matches effects of several actors.",
    fix: "Pass a value from `sim.pendingEffects()` (it names its actor).",
  },
  invalid_rejection: {
    title: "A simulated rejection does not match the service's declared errors or a built-in error.",
    fix: 'Reject with a declared `{ _tag, ... }` error, `{ _tag: "Timeout", ms }`, `{ _tag: "Defect", message }` or a string.',
  },
  timer_loop: {
    title:
      "More timers fired in one `advance()` than the simulation allows (a timer that reschedules itself at once?).",
    fix: "Make the timer schedule its next firing in the future (`in` > 0), or advance in smaller steps.",
  },
  connection_closed: {
    title: "A simulated connection was closed twice.",
    fix: "Call `disconnect()` once per `connect()`.",
  },
} as const satisfies Record<string, ErrorCodeInfo>;

export type ErrorCode = keyof typeof ERROR_CODES;

function isErrorCode(key: string): key is ErrorCode {
  return Object.hasOwn(ERROR_CODES, key);
}

/** Every error code, in registry order. */
export const ERROR_CODE_LIST: readonly ErrorCode[] = Object.keys(ERROR_CODES).filter(isErrorCode);

/** The docs page of an error code. */
export function docsUrl(code: ErrorCode): string {
  return `${ERRORS_DOCS_BASE}${code}/`;
}

/** An error thrown by actor-kit: a stable `code`, a `docs` URL, and a message that names the fix. */
export class ActorKitError extends Error {
  readonly code: ErrorCode;
  readonly docs: string;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.docs = docsUrl(code);
    this.details = details;
  }
}

// --- Refusals (ADR-018 C) ---

/** The codes a refusal can carry (ADR-018 C). */
export const REFUSAL_CODES = [
  "unknown_message",
  "invalid_payload",
  "guard_failed",
  "wrong_state",
  "no_role",
  "not_initialized",
  "invalid_delivery",
  "actor_not_found",
] as const satisfies readonly ErrorCode[];

export type RefusalCode = (typeof REFUSAL_CODES)[number];

export function isRefusalCode(value: unknown): value is RefusalCode {
  return REFUSAL_CODES.some((code) => code === value);
}

/**
 * Why a message was not accepted. `message` is a full sentence naming the fix; `expected` lists what
 * would have been accepted (message names for unknown_message, state names for wrong_state); `details`
 * carries the specifics (Zod issues for invalid_payload, the current phase for wrong_state).
 */
export interface Refusal {
  readonly ok: false;
  readonly code: RefusalCode;
  readonly message: string;
  readonly expected?: readonly string[];
  readonly details?: unknown;
  readonly docs: string;
}

export function refusal(
  code: RefusalCode,
  message: string,
  extra: { readonly expected?: readonly string[]; readonly details?: unknown } = {},
): Refusal {
  return { ok: false, code, message, ...extra, docs: docsUrl(code) };
}

/** A refusal thrown (testActor): the error's `code` is the refusal's, and `refusal` is the whole value. */
export class RefusalError extends ActorKitError {
  declare readonly code: RefusalCode;
  readonly refusal: Refusal;

  constructor(value: Refusal) {
    super(value.code, value.message, value.details);
    this.refusal = value;
  }
}
