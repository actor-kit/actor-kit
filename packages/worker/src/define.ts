/**
 * defineActor() — creates a typed contract from an actor definition.
 *
 * The contract is NOT a DO class. It's a plain object that preserves
 * the full type information of the definition (TState, TInput, TMessages,
 * TRoles, TViews) via generics. Everything derives from the contract:
 *
 *   const Counter = defineActor("counter", { init, roles, messages, views });
 *   const CounterDO = createActorClass(Counter); // → DO class
 *
 * init() can be async — useful for fetching initial state from KV/D1/R2:
 *   init: async (input, env) => {
 *     const config = await env.KV.get("config", "json");
 *     return { ...config, count: 0 };
 *   }
 *
 * Type extraction:
 *   type State = Awaited<ReturnType<typeof Counter.def.init>>;
 *   type Roles = keyof typeof Counter.def.roles;
 *   type Messages = keyof typeof Counter.def.messages;
 */

/**
 * A typed contract that preserves the full definition type.
 * TName is the actor name (string literal).
 * TDef is the exact type of the definition object.
 */
export interface ActorContract<TName extends string = string, TDef = unknown> {
  readonly name: TName;
  readonly def: TDef;
}

/**
 * Create a typed actor contract from a definition.
 * The contract preserves all type information for downstream consumers
 * (actorClient, actorContext, testActor, createRef).
 */
export function defineActor<
  TName extends string,
  TDef extends {
    input: import("zod").ZodType;
    init(...args: never[]): unknown;
  },
>(name: TName, def: TDef): ActorContract<TName, TDef> {
  return { name, def };
}
