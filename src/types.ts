import { DurableObject } from "cloudflare:workers";
import { Operation } from "fast-json-patch";
import type {
  AnyEventObject,
  AnyStateMachine,
  SnapshotFrom,
  StateMachine,
  StateValueFrom,
} from "./stateMachine";
import type { z } from "zod";
import type {
  AnyEventSchema,
  CallerSchema,
  RequestInfoSchema,
  SystemEventSchema,
} from "./schemas";

export type EnvWithDurableObjects = {
  ACTOR_KIT_SECRET: string;
  [key: string]: DurableObjectNamespace<ActorServer<any>> | unknown;
};

export type AnyEvent = z.infer<typeof AnyEventSchema>;

export interface ActorServerMethods<TMachine extends BaseActorKitStateMachine> {
  fetch(request: Request): Promise<Response>;
  spawn(props: {
    actorType: string;
    actorId: string;
    caller: Caller;
    input: Record<string, unknown>;
  }): void;
  send(event: ClientEventFrom<TMachine> | ServiceEventFrom<TMachine>): void;
  getSnapshot(
    caller: Caller,
    options?: {
      waitForEvent?: ClientEventFrom<TMachine>;
      waitForState?: StateValueFrom<TMachine>;
      timeout?: number;
      errorOnWaitTimeout?: boolean;
    }
  ): Promise<{
    checksum: string;
    snapshot: CallerSnapshotFrom<TMachine>;
  }>;
}

export type ActorServer<TMachine extends AnyActorKitStateMachine> =
  DurableObject & ActorServerMethods<TMachine>;
export type AnyActorServer = ActorServer<any>;

export type Caller = z.infer<typeof CallerSchema>;
export type RequestInfo = z.infer<typeof RequestInfoSchema>;

export type ActorKitInputProps = {
  id: string;
  caller: Caller;
  storage: DurableObjectStorage;
  [key: string]: unknown;
};

export type CallerType = "client" | "system" | "service";

type EventObject = {
  type: string;
};

type EventSchemaUnion = z.ZodDiscriminatedUnion<
  "type",
  [
    z.ZodObject<z.ZodRawShape & { type: z.ZodString }>,
    ...z.ZodObject<z.ZodRawShape & { type: z.ZodString }>[]
  ]
>;

export type EventSchemas = {
  client: EventSchemaUnion;
  service: EventSchemaUnion;
};

export type BaseActorKitContext<
  TPublicProps extends { [key: string]: unknown },
  TPrivateProps extends { [key: string]: unknown }
> = {
  public: TPublicProps;
  private: Record<string, TPrivateProps>;
};

export type ActorKitStateMachine<
  TEvent extends BaseActorKitEvent<EnvWithDurableObjects>,
  TInput extends {
    id: string;
    caller: Caller;
    storage: DurableObjectStorage;
  },
  TContext extends BaseActorKitContext<any, any> & {
    [key: string]: unknown;
  }
> = StateMachine<
  TContext,
  TEvent & EventObject,
  TInput
>;

export type BaseActorKitInput<TEnv = EnvWithDurableObjects> = {
  id: string;
  caller: Caller;
  env: TEnv;
  storage: DurableObjectStorage;
};

export type WithActorKitInput<
  TInputProps extends { [key: string]: unknown },
  TEnv extends EnvWithDurableObjects
> = TInputProps & BaseActorKitInput<TEnv>;

export type AnyActorKitStateMachine = ActorKitStateMachine<any, any, any>;

type AnyActorKitEvent = (
  | WithActorKitEvent<AnyEventObject, "client">
  | WithActorKitEvent<AnyEventObject, "service">
  | ActorKitSystemEvent
) &
  BaseActorKitEvent<EnvWithDurableObjects>;

type AnyActorKitInput = WithActorKitInput<
  { [key: string]: unknown },
  EnvWithDurableObjects
> & {
  storage: DurableObjectStorage;
};

type AnyActorKitContext = {
  public: { [key: string]: unknown };
  private: Record<string, { [key: string]: unknown }>;
};

export type BaseActorKitStateMachine = ActorKitStateMachine<
  AnyActorKitEvent,
  AnyActorKitInput,
  AnyActorKitContext
>;

export type MachineServerOptions = {
  persisted?: boolean;
};

export type ExtraContext = {
  requestId: string;
};

export interface BaseActorKitEvent<TEnv extends EnvWithDurableObjects> {
  caller: Caller;
  storage: DurableObjectStorage;
  requestInfo?: RequestInfo;
  env: TEnv;
}

export type ActorKitSystemEvent = z.infer<typeof SystemEventSchema>;

// Utility type to merge custom event types with the base event
export type WithActorKitEvent<
  T extends { type: string },
  C extends CallerType
> = T & BaseActorKitEvent<EnvWithDurableObjects> & { caller: { type: C } };

export type WithActorKitContext<
  TExtraProps extends { [key: string]: unknown },
  TPrivateProps extends { [key: string]: unknown },
  TPublicProps extends { [key: string]: unknown }
> = TExtraProps & {
  public: TPublicProps;
  private: Record<string, TPrivateProps>;
};

export type CallerSnapshotFrom<TMachine extends AnyStateMachine> = {
  public: SnapshotFrom<TMachine> extends { context: { public: infer P } }
    ? P
    : unknown;
  private: SnapshotFrom<TMachine> extends {
    context: { private: Partial<Record<string, infer PR>> };
  }
    ? PR
    : unknown;
  value: SnapshotFrom<TMachine> extends { value: infer V } ? V : unknown;
};

export type ClientEventFrom<T extends AnyActorKitStateMachine> =
  T extends StateMachine<
    any,
    infer TEvent,
    any
  >
    ? TEvent extends WithActorKitEvent<infer E, "client">
      ? Omit<E, keyof BaseActorKitEvent<EnvWithDurableObjects>>
      : never
    : never;

export type ServiceEventFrom<T extends AnyActorKitStateMachine> =
  T extends StateMachine<
    any,
    infer TEvent,
    any
  >
    ? TEvent extends WithActorKitEvent<infer E, "service">
      ? Omit<E, keyof BaseActorKitEvent<EnvWithDurableObjects>>
      : never
    : never;

// Helper type to convert from SCREAMING_SNAKE_CASE to kebab-case
export type ScreamingSnakeToKebab<S extends string> =
  S extends `${infer T}_${infer U}`
    ? `${Lowercase<T>}-${ScreamingSnakeToKebab<U>}`
    : Lowercase<S>;

export type DurableObjectActor<TMachine extends AnyActorKitStateMachine> =
  ActorServer<TMachine>;

type CamelToSnakeCase<S extends string> = S extends `${infer T}${infer U}`
  ? U extends Uncapitalize<U>
    ? `${Lowercase<T>}${CamelToSnakeCase<U>}`
    : `${Lowercase<T>}_${CamelToSnakeCase<U>}`
  : S;

type KebabToCamelCase<S extends string> = S extends `${infer T}-${infer U}`
  ? `${T}${Capitalize<KebabToCamelCase<U>>}`
  : S;

export type KebabToScreamingSnake<S extends string> = Uppercase<
  CamelToSnakeCase<KebabToCamelCase<S>>
>;
export interface MatchesProps<TMachine extends AnyActorKitStateMachine> {
  state: StateValueFrom<TMachine>;
  and?: StateValueFrom<TMachine>;
  or?: StateValueFrom<TMachine>;
  not?: boolean;
  initialValueOverride?: boolean;
}

export type MachineFromServer<T> = T extends ActorServer<infer M> ? M : never;

export type ActorKitEmittedEvent = {
  operations: Operation[];
  checksum: string;
};
// | {
//     snapshot: CallerSnapshotFrom<TMachine>;
//     checksum: string;
//   };

export type ActorKitClient<TMachine extends AnyActorKitStateMachine> = {
  connect: () => Promise<void>;
  disconnect: () => void;
  send: (event: ClientEventFrom<TMachine>) => void;
  getState: () => CallerSnapshotFrom<TMachine>;
  subscribe: (
    listener: (state: CallerSnapshotFrom<TMachine>) => void
  ) => () => void;
  waitFor: (
    predicateFn: (state: CallerSnapshotFrom<TMachine>) => boolean,
    timeoutMs?: number
  ) => Promise<void>;
};

// First define a helper to extract the event type from a machine
type ExtractEventType<TMachine> = TMachine extends ActorKitStateMachine<
  infer TEvent,
  any,
  any
>
  ? TEvent
  : never;

// Then extract the env type from the event
type ExtractEnvType<TEvent> = TEvent extends { env: infer TEnv } ? TEnv : never;

// Finally, our InferEnvFromMachine type that ensures EnvWithDurableObjects
export type EnvFromMachine<TMachine extends AnyActorKitStateMachine> =
  ExtractEnvType<ExtractEventType<TMachine>> extends never
    ? EnvWithDurableObjects
    : ExtractEnvType<ExtractEventType<TMachine>> & EnvWithDurableObjects;
