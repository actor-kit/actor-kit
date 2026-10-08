// @actor-kit/test — test harness for actor definitions (no CF deps)

export { JournalDivergenceError, JournalNondeterminismError, replayJournal } from "./replay-journal";
export type {
  ActorAddress,
  AnyContract,
  CallerOptions,
  FailedForward,
  PendingEffect,
  SendOutcome,
  SimActor,
  SimConnection,
  SimTimer,
  SimulateOptions,
  Simulation,
} from "./simulate";
export { simulate } from "./simulate";
export { testActor } from "./test-actor";
