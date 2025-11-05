/**
 * Local State Machine Utility
 * A lightweight replacement for XState with essential features
 */

// ============================================================================
// Types
// ============================================================================

export type AnyEventObject = {
  type: string;
  [key: string]: any;
};

export interface StateMachineConfig<
  TContext = any,
  TEvent extends AnyEventObject = AnyEventObject,
  TInput = any
> {
  id: string;
  type?: "parallel" | "normal";
  context: (args: { input: TInput }) => TContext;
  states?: Record<string, StateNode<TContext, TEvent>>;
  on?: Record<string, Transition<TContext, TEvent>>;
}

export interface StateNode<
  TContext = any,
  TEvent extends AnyEventObject = AnyEventObject
> {
  on?: Record<string, Transition<TContext, TEvent>>;
  states?: Record<string, StateNode<TContext, TEvent>>;
}

export interface Transition<
  TContext = any,
  TEvent extends AnyEventObject = AnyEventObject
> {
  actions?: Array<string | ActionFunction<TContext, TEvent>>;
  guard?: string | GuardFunction<TContext, TEvent>;
  target?: string;
}

export type ActionFunction<TContext = any, TEvent extends AnyEventObject = AnyEventObject> = (args: {
  context: TContext;
  event: TEvent;
}) => TContext | void;

export type GuardFunction<TContext = any, TEvent extends AnyEventObject = AnyEventObject> = (args: {
  context: TContext;
  event: TEvent;
}) => boolean;

export interface MachineSetup<
  TContext = any,
  TEvent extends AnyEventObject = AnyEventObject,
  TInput = any
> {
  types?: {
    context?: TContext;
    events?: TEvent;
    input?: TInput;
  };
  actions?: Record<string, ActionFunction<TContext, TEvent>>;
  guards?: Record<string, GuardFunction<TContext, TEvent>>;
}

export interface StateMachine<
  TContext = any,
  TEvent extends AnyEventObject = AnyEventObject,
  TInput = any
> {
  id: string;
  config: StateMachineConfig<TContext, TEvent, TInput>;
  setup: MachineSetup<TContext, TEvent, TInput>;
  _types?: {
    context: TContext;
    events: TEvent;
    input: TInput;
  };
}

export type AnyStateMachine = StateMachine<any, any, any>;

export interface Snapshot<TContext = any, TEvent extends AnyEventObject = AnyEventObject> {
  context: TContext;
  value: StateValue;
  status: "active" | "done" | "error";
  _version?: number;
}

export type StateValue = string | Record<string, StateValue>;

export type Subscription = {
  unsubscribe: () => void;
};

export interface Actor<TMachine extends AnyStateMachine = AnyStateMachine> {
  id: string;
  send: (event: ExtractEvent<TMachine>) => void;
  start: () => Actor<TMachine>;
  subscribe: (
    observer: (snapshot: SnapshotFrom<TMachine>) => void
  ) => Subscription;
  getSnapshot: () => SnapshotFrom<TMachine>;
  stop: () => void;
}

// ============================================================================
// Type Utilities
// ============================================================================

export type SnapshotFrom<TMachine extends AnyStateMachine> = TMachine extends StateMachine<
  infer TContext,
  infer TEvent,
  any
>
  ? Snapshot<TContext, TEvent>
  : never;

export type InputFrom<TMachine extends AnyStateMachine> = TMachine extends StateMachine<
  any,
  any,
  infer TInput
>
  ? TInput
  : never;

export type StateValueFrom<TMachine extends AnyStateMachine> = StateValue;

export type ExtractEvent<TMachine extends AnyStateMachine> = TMachine extends StateMachine<
  any,
  infer TEvent,
  any
>
  ? TEvent
  : AnyEventObject;

// ============================================================================
// Machine Setup and Creation
// ============================================================================

interface SetupBuilder<
  TContext = any,
  TEvent extends AnyEventObject = AnyEventObject,
  TInput = any
> {
  createMachine: (
    config: StateMachineConfig<TContext, TEvent, TInput>
  ) => StateMachine<TContext, TEvent, TInput>;
}

export function setup<
  TContext = any,
  TEvent extends AnyEventObject = AnyEventObject,
  TInput = any
>(machineSetup: MachineSetup<TContext, TEvent, TInput>): SetupBuilder<TContext, TEvent, TInput> {
  return {
    createMachine(config: StateMachineConfig<TContext, TEvent, TInput>) {
      return {
        id: config.id,
        config,
        setup: machineSetup,
        _types: undefined as any,
      };
    },
  };
}

// ============================================================================
// Actor Creation and Management
// ============================================================================

export interface ActorOptions<TMachine extends AnyStateMachine> {
  input?: InputFrom<TMachine>;
  snapshot?: SnapshotFrom<TMachine>;
}

export function createActor<TMachine extends AnyStateMachine>(
  machine: TMachine,
  options?: ActorOptions<TMachine>
): Actor<TMachine> {
  type TContext = TMachine extends StateMachine<infer C, any, any> ? C : any;
  type TEvent = TMachine extends StateMachine<any, infer E, any> ? E : AnyEventObject;

  const input = options?.input || ({} as InputFrom<TMachine>);

  let currentSnapshot: Snapshot<TContext, TEvent> = options?.snapshot || {
    context: machine.config.context({ input }),
    value: machine.config.type === "parallel" ? {} : "idle",
    status: "active" as const,
    _version: 1,
  };

  const observers: Array<(snapshot: SnapshotFrom<TMachine>) => void> = [];
  let started = false;

  const notify = () => {
    observers.forEach((observer) => observer(currentSnapshot as SnapshotFrom<TMachine>));
  };

  const executeAction = (
    actionNameOrFn: string | ActionFunction<TContext, TEvent>,
    context: TContext,
    event: TEvent
  ): TContext => {
    let actionFn: ActionFunction<TContext, TEvent>;

    if (typeof actionNameOrFn === "string") {
      const namedAction = machine.setup.actions?.[actionNameOrFn];
      if (!namedAction) {
        console.warn(`Action "${actionNameOrFn}" not found`);
        return context;
      }
      actionFn = namedAction;
    } else {
      actionFn = actionNameOrFn;
    }

    const result = actionFn({ context, event });
    return result !== undefined ? result : context;
  };

  const evaluateGuard = (
    guardNameOrFn: string | GuardFunction<TContext, TEvent> | undefined,
    context: TContext,
    event: TEvent
  ): boolean => {
    if (!guardNameOrFn) return true;

    let guardFn: GuardFunction<TContext, TEvent>;

    if (typeof guardNameOrFn === "string") {
      const namedGuard = machine.setup.guards?.[guardNameOrFn];
      if (!namedGuard) {
        console.warn(`Guard "${guardNameOrFn}" not found`);
        return false;
      }
      guardFn = namedGuard;
    } else {
      guardFn = guardNameOrFn;
    }

    return guardFn({ context, event });
  };

  const actor: Actor<TMachine> = {
    id: machine.id,

    send(event: ExtractEvent<TMachine>) {
      if (!started) {
        console.warn("Actor not started, cannot send event");
        return;
      }

      const typedEvent = event as TEvent;
      let newContext = currentSnapshot.context;

      // Find matching transition in machine config
      const machineTransition = machine.config.on?.[typedEvent.type];

      // Find matching transition in current state (if states exist)
      let stateTransition: Transition<TContext, TEvent> | undefined;
      if (machine.config.states && typeof currentSnapshot.value === "string") {
        const currentState = machine.config.states[currentSnapshot.value];
        stateTransition = currentState?.on?.[typedEvent.type];
      }

      // Use state transition if available, otherwise machine transition
      const transition = stateTransition || machineTransition;

      if (transition) {
        // Check guard
        if (!evaluateGuard(transition.guard, newContext, typedEvent)) {
          return; // Guard failed, don't execute transition
        }

        // Execute actions
        if (transition.actions) {
          for (const action of transition.actions) {
            newContext = executeAction(action, newContext, typedEvent);
          }
        }

        // Update state value if target is specified
        let newValue = currentSnapshot.value;
        if (transition.target) {
          newValue = transition.target;
        }

        // Update snapshot
        currentSnapshot = {
          context: newContext,
          value: newValue,
          status: "active" as const,
          _version: (currentSnapshot._version || 1) + 1,
        };

        notify();
      }
    },

    start() {
      started = true;
      notify();
      return actor;
    },

    subscribe(observer: (snapshot: SnapshotFrom<TMachine>) => void) {
      observers.push(observer);

      // Immediately call observer with current snapshot
      if (started) {
        observer(currentSnapshot as SnapshotFrom<TMachine>);
      }

      return {
        unsubscribe() {
          const index = observers.indexOf(observer);
          if (index > -1) {
            observers.splice(index, 1);
          }
        },
      };
    },

    getSnapshot() {
      return currentSnapshot as SnapshotFrom<TMachine>;
    },

    stop() {
      started = false;
      observers.length = 0;
    },
  };

  return actor;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Helper to create context update actions (similar to XState's assign)
 */
export function assign<TContext = any, TEvent extends AnyEventObject = AnyEventObject>(
  updater:
    | Partial<TContext>
    | ((args: { context: TContext; event: TEvent }) => Partial<TContext>)
    | {
        [K in keyof TContext]?: ((args: { context: TContext; event: TEvent }) => TContext[K]) | TContext[K];
      }
): ActionFunction<TContext, TEvent> {
  return (args) => {
    const { context, event } = args;

    if (typeof updater === "function") {
      return { ...context, ...updater(args) };
    }

    const updates: Partial<TContext> = {};
    for (const key in updater) {
      const value = updater[key];
      if (typeof value === "function") {
        updates[key] = (value as any)(args);
      } else {
        updates[key] = value;
      }
    }

    return { ...context, ...updates };
  };
}

/**
 * Check if current state matches a state value
 */
export function matchesState(currentState: StateValue, targetState: StateValue): boolean {
  if (typeof currentState === "string" && typeof targetState === "string") {
    return currentState === targetState;
  }

  if (typeof currentState === "object" && typeof targetState === "object") {
    for (const key in targetState) {
      if (!matchesState(currentState[key], targetState[key])) {
        return false;
      }
    }
    return true;
  }

  return false;
}

/**
 * Simple migration utility (placeholder for xstate-migrate functionality)
 */
export const xstateMigrate = {
  generateMigrations<TMachine extends AnyStateMachine>(
    machine: TMachine,
    snapshot: SnapshotFrom<TMachine>,
    input: InputFrom<TMachine>
  ): any[] {
    // Simple implementation: if versions don't match, recreate context
    return [];
  },

  applyMigrations<TContext = any, TEvent extends AnyEventObject = AnyEventObject>(
    snapshot: Snapshot<TContext, TEvent>,
    migrations: any[]
  ): Snapshot<TContext, TEvent> {
    // Simple implementation: just return snapshot as-is
    // In production, you might want to apply actual migrations
    return snapshot;
  },
};
