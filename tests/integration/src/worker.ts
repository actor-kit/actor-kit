import { nullable, schema, string, uint32, view } from "@actor-kit/core";
import { StudioRegistry } from "@actor-kit/studio";
import { createActorClass, defineActor, message } from "@actor-kit/worker";
import { z } from "zod";

import { ChatRoomContract } from "../../../examples/chat-room/src/chat";

export { StampOff, StampThrow, StampWarn } from "./determinism-actors";
export { ExampleAuction, ExampleChatRoom, ExampleCounter, ExampleTodoList } from "./example-actors";
export { Courier, FlakyInbox } from "./forward-retry-actors";
export { Kiosk } from "./init-link-actors";
export { JournalKeep, JournalOff, JournalProbe, NotAnActor } from "./journal-actors";
export { Notice, NoticeNoJournal, NoticeStudio, Reader } from "./link-version-actors";
export { Retrier, RetrierNoJournal } from "./outbox-retry";
export { Lot, LotTyped, LotUnbound } from "./publish-actors";
export { QuizStates } from "./quiz-states";

import { ensureLotReadModel, lotProjection, type ProjectionEnv } from "./lot-projection";

export { Ledger, LedgerNoJournal, LedgerNoStudio } from "./restore-actors";
export { Scoreboard } from "./rich-view-actors";
export { CashierActor } from "./service-handles-actors";
export { Bulletin, Desk } from "./studio-effects";
export { StudioOff, StudioProbe } from "./studio-probe";
export { StudioRedacted } from "./studio-redacted";
export { Quiz, QuizLifecycle, QuizNoJournal, QuizNoStudio } from "./timers-actors";
export { EnvMisbound, EnvTyped, Teller, Till } from "./typed-services-actors";
export { RosterActor } from "./versions-actors";
export { StudioRegistry };

// --- Counter actor (v3: defineActor + flat messages + guards) ---

type CounterState = { count: number; lastCaller: string | null };

const CounterView = schema({ count: uint32, lastCaller: string });

const increment = message(
  z.object({ amount: z.number().int().positive() }),
  (state: CounterState, { amount }, { caller }) => ({
    count: state.count + amount,
    lastCaller: caller,
  }),
);

const decrement = message(z.object({ amount: z.number().int().positive() }), {
  guard: (_state: CounterState, _payload: { amount: number }, ctx: { role: string }) => ctx.role === "admin",
  handler: (state: CounterState, { amount }, { caller }) => ({
    count: state.count - amount,
    lastCaller: caller,
  }),
});

const reset = message(z.object({}), {
  guard: (_state: CounterState, _payload: Record<string, never>, ctx: { role: string }) => ctx.role === "admin",
  handler: (_state: CounterState) => ({ count: 0, lastCaller: null }),
});

const notify = message(z.object({}), {
  guard: (_state: CounterState, _payload: Record<string, never>, ctx: { role: string }) => ctx.role === "admin",
  handler: (
    state: CounterState,
    _payload: Record<string, never>,
    ctx: { execute: (service: string, input: unknown) => void },
  ) => {
    ctx.execute("ANALYTICS", { count: state.count });
    return state;
  },
});

const forwardTo = message(
  z.object({ targetId: z.string() }),
  (
    state: CounterState,
    { targetId }: { targetId: string },
    ctx: {
      forward: (linkName: string, targetId: string, message: { type: string; [key: string]: unknown }) => void;
    },
  ) => {
    ctx.forward("COUNTER", targetId, { type: "INCREMENT", amount: 5 });
    return state;
  },
);

const guardedAdd = message(z.object({ amount: z.number().int().positive() }), {
  guard: (state: CounterState, { amount }: { amount: number }) => state.count + amount <= 100,
  handler: (state: CounterState, { amount }, { caller }) => ({
    ...state,
    count: state.count + amount,
    lastCaller: caller,
  }),
});

const CounterContract = defineActor("counter", {
  input: z.object({}),
  init: (): CounterState => ({ count: 0, lastCaller: null }),
  roles: {
    admin: (_state: CounterState, _caller: string, { callerType }: { callerType: "user" | "service" }) =>
      callerType === "service",
    user: () => true,
  },
  messages: {
    INCREMENT: increment,
    DECREMENT: decrement,
    RESET: reset,
    NOTIFY: notify,
    GUARDED_ADD: guardedAdd,
    FORWARD_TO: forwardTo,
  },
  views: {
    admin: view.shared(CounterView, (state: CounterState) => ({
      count: state.count,
      lastCaller: state.lastCaller ?? "",
    })),
    user: view.shared(CounterView, (state: CounterState) => ({
      count: state.count,
      lastCaller: state.lastCaller ?? "",
    })),
  },
  studio: { enabled: true },
});

export const Counter = createActorClass(CounterContract);

// --- NullableCounter actor (tests nullable schema fields) ---

type NullableCounterState = { count: number; lastUpdatedBy: string | null };

const NullableCounterView = schema({ count: uint32, lastUpdatedBy: nullable(string) });

const setCount = message(
  z.object({ value: z.number().int() }),
  (_state: NullableCounterState, { value }, { caller }) => ({
    count: value,
    lastUpdatedBy: caller,
  }),
);

const clearUpdater = message(z.object({}), (state: NullableCounterState) => ({
  ...state,
  lastUpdatedBy: null,
}));

const NullableCounterContract = defineActor("nullable-counter", {
  input: z.object({}),
  init: (): NullableCounterState => ({ count: 0, lastUpdatedBy: null }),
  roles: {
    user: () => true,
  },
  messages: {
    SET_COUNT: setCount,
    CLEAR_UPDATER: clearUpdater,
  },
  views: {
    user: view.shared(NullableCounterView, (state: NullableCounterState) => ({
      count: state.count,
      lastUpdatedBy: state.lastUpdatedBy,
    })),
  },
});

export const NullableCounter = createActorClass(NullableCounterContract);

// --- ChatRoom actor: the examples/chat-room contract, unchanged (presence per socket) ---

export const ChatRoom = createActorClass(ChatRoomContract);

// --- Worker entrypoint ---

export default {
  /** ADR-019 E: the lot-events consumer keeps a D1 read model (lot-projection.ts). */
  async queue(batch: MessageBatch<unknown>, env: ProjectionEnv): Promise<void> {
    await ensureLotReadModel(env.PROJECTION_DB);
    await lotProjection.queue(batch, env);
  },

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response("ok");
    }
    return new Response("Actor Kit v3 test worker", { status: 200 });
  },
};
