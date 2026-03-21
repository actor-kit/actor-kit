import type { ActorLogic, BaseEnv, Caller } from "./types";

export function defineLogic<
  TState,
  TEvent extends { type: string },
  TView,
  TEnv extends BaseEnv = BaseEnv,
  TInput = Record<string, unknown>,
>(config: {
  create: (input: TInput, ctx: { id: string; caller: Caller; env: TEnv }) => TState;
  transition: (
    state: TState,
    event: TEvent & { caller: Caller; env: TEnv }
  ) => TState;
  getView: (state: TState, caller: Caller) => TView;
  serialize?: (state: TState) => unknown;
  restore?: (serialized: unknown) => TState;
  version?: number;
  migrate?: (serialized: unknown, version?: number) => TState;
  onConnect?: (state: TState, caller: Caller) => TState;
  onDisconnect?: (state: TState, caller: Caller) => TState;
  onResume?: (state: TState) => TState;
}): ActorLogic<TState, TEvent, TView, TEnv, TInput> {
  return {
    create: config.create,
    transition: config.transition,
    getView: config.getView,
    serialize:
      config.serialize ?? ((state) => JSON.parse(JSON.stringify(state))),
    restore: config.restore ?? ((serialized) => serialized as TState),
    version: config.version,
    migrate: config.migrate,
    onConnect: config.onConnect,
    onDisconnect: config.onDisconnect,
    onResume: config.onResume,
  };
}
