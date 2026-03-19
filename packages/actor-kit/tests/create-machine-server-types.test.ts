import { describe, expectTypeOf, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class DurableObject {
    constructor(
      public readonly state: unknown,
      public readonly env: unknown
    ) {}
  },
}));

import type {
  ActorKitEnv,
  ActorKitStateMachine,
  ActorKitSystemEvent,
  BaseActorKitEvent,
  WithActorKitEvent,
  WithActorKitInput,
} from "../src/types";
import { createMachineServer } from "../src/createMachineServer";
import { setup } from "xstate";
import { z } from "zod";

// Custom env extending ActorKitEnv with extra bindings
interface CustomEnv extends ActorKitEnv {
  EMAIL_API_KEY: string;
  DATABASE_URL: string;
}

// Client events
type AddTodo = { type: "ADD_TODO"; text: string };
type ClientEvent = AddTodo;

// Service events
type SyncTodos = {
  type: "SYNC_TODOS";
  todos: Array<{ id: string; text: string }>;
};
type ServiceEvent = SyncTodos;

// Full event type using custom env
type MachineEvent = (
  | WithActorKitEvent<ClientEvent, "client">
  | WithActorKitEvent<ServiceEvent, "service">
  | ActorKitSystemEvent
) &
  BaseActorKitEvent<CustomEnv>;

type MachineInput = WithActorKitInput<{ foo: string }, CustomEnv>;

type MachineContext = {
  public: { ownerId: string; todos: Array<{ id: string; text: string }> };
  private: Record<string, { lastAccess: number }>;
};

const testMachine = setup({
  types: {
    context: {} as MachineContext,
    events: {} as MachineEvent,
    input: {} as MachineInput,
  },
}).createMachine({
  id: "test",
  context: ({ input }) => ({
    public: { ownerId: input.caller.id, todos: [] },
    private: {},
  }),
  on: {
    ADD_TODO: {
      actions: () => {},
    },
  },
}) satisfies ActorKitStateMachine<MachineEvent, MachineInput, MachineContext>;

const ClientEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ADD_TODO"), text: z.string() }),
]);

const ServiceEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("SYNC_TODOS"),
    todos: z.array(z.object({ id: z.string(), text: z.string() })),
  }),
]);

const InputPropsSchema = z.object({ foo: z.string() });

// Create the server once at module scope to avoid lint warnings
const TestServer = createMachineServer({
  machine: testMachine,
  schemas: {
    clientEvent: ClientEventSchema,
    serviceEvent: ServiceEventSchema,
    inputProps: InputPropsSchema,
  },
});

type TestServerConstructorParams = ConstructorParameters<typeof TestServer>;
type InferredEnv = TestServerConstructorParams[1];

describe("createMachineServer type inference", () => {
  it("accepts a machine without `as any` cast and infers custom env", () => {
    // If the circular generic were still present, the createMachineServer
    // call above would require `machine: testMachine as any` to compile.
    // Verify the constructor requires the custom env type.
    expectTypeOf(TestServer).constructorParameters.toMatchTypeOf<
      [state: unknown, env: CustomEnv]
    >();
  });

  it("infers custom env bindings on the constructor", () => {
    expectTypeOf<InferredEnv>().toHaveProperty("ACTOR_KIT_SECRET");
    expectTypeOf<InferredEnv>().toHaveProperty("EMAIL_API_KEY");
    expectTypeOf<InferredEnv>().toHaveProperty("DATABASE_URL");
  });

  it("rejects plain ActorKitEnv when custom env bindings are required", () => {
    // Plain ActorKitEnv should NOT satisfy the inferred env
    // (it's missing EMAIL_API_KEY and DATABASE_URL)
    expectTypeOf<ActorKitEnv>().not.toMatchTypeOf<InferredEnv>();
  });
});
