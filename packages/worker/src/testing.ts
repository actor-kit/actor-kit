// Pure-logic runtime utilities — separate entrypoint to avoid cloudflare:workers via actor.ts
// Used by @actor-kit/test and unit tests that run outside CF runtime

// Contract builder
export type { ActorContract, LifecycleEvent } from "./define";
export { defineActor } from "./define";
// Identity (Worker-trust model)
export { CALLER_ID_HEADER, CALLER_TYPE_HEADER, withCallerIdentity } from "./identity";
// Link declaration
export type { LinkDef, LinkErrorCode } from "./link";
export { link } from "./link";
// Message builder
export { message } from "./message";
// Actor references
export type { ActorRef, LocationHint } from "./ref";
export { createRef } from "./ref";
// CDC
export type { ChangeEntry } from "./runtime/cdc";
export { createChangeEntry } from "./runtime/cdc";
export { parseDuration } from "./runtime/duration";
// Effect ids, retries, outbox store (ADR-015 D1)
export type { EffectIdParts } from "./runtime/effect-id";
export { formatEffectId, parseEffectId } from "./runtime/effect-id";
export { getTokenFromRequest } from "./runtime/get-token";
// Actor journal (ADR-013): facts, events, replay
export type {
  FactSources,
  Facts,
  FoldOptions,
  FoldPoint,
  Journal,
  JournalCauseType,
  JournalCheckpoint,
  JournalConfig,
  JournalDraft,
  JournalEvent,
  JournalOption,
  JournalSql,
  LiveFacts,
  ReplayableDef,
  ReplayFacts,
  ScheduledTimer,
} from "./runtime/journal";
export {
  appendJournalEvent,
  applyJournalEvent,
  applyScheduleOps,
  checkpointPoint,
  checksumState,
  clockedSources,
  createLiveFacts,
  createReplayFacts,
  foldEvents,
  foldJournal,
  JournalDivergenceError,
  JournalNondeterminismError,
  JournalVersionError,
  journalHighWater,
  nextTransitionSeq,
  readJournal,
  rebuildFromJournal,
  resolveJournalConfig,
} from "./runtime/journal";
// Live app connections from held sockets (pure)
export type { ConnectionAttachment, LiveConnection, SocketRecord } from "./runtime/live-connections";
export {
  isStudioSocket,
  nextConnectionSeq,
  readConnectionAttachment,
  toLiveConnections,
} from "./runtime/live-connections";
// Message router
export type { RouteResult } from "./runtime/message-router";
export { routeMessage } from "./runtime/message-router";
export { ACTOR_KIT_MIGRATIONS } from "./runtime/migrations";
// Outbox
export type {
  ExecutionEntry,
  ForwardCall,
  ForwardEntry,
  LinkCall,
  TimerOp,
  TimerSchedule,
  UnlinkCall,
} from "./runtime/outbox";
export { createOutbox } from "./runtime/outbox";
export type { DueExecution, NewExecution, OutboxFailedEvent, OutboxRow } from "./runtime/outbox-store";
export {
  cancelUndoneEffects,
  dueExecutions,
  finishAttempt,
  insertExecutions,
  isRunning,
  nextRetryAt,
  outboxFailedEvent,
  readOutboxRows,
  redriveExecution,
  requeueInterrupted,
  startAttempt,
} from "./runtime/outbox-store";
// Namespace resolution
export { resolveNamespace } from "./runtime/resolve-namespace";
export type { RestorePlan } from "./runtime/restore";
export { planRestore } from "./runtime/restore";
export type { AttemptSettlement, RetryOption, RetryPolicy } from "./runtime/retry";
export { DEFAULT_RETRY_POLICY, resolveRetryPolicy, retryDelay, settleAttempt } from "./runtime/retry";
// Role resolution
export type { RolePredicate } from "./runtime/roles";
export { resolveRole } from "./runtime/roles";
// Route parsing
export type { ActorRoute } from "./runtime/route-to-actor";
export { parseActorRoute } from "./runtime/route-to-actor";
// Step core (ADR-015 D4): one transition as a pure function
export type {
  Admission,
  InitCause,
  PendingLinks,
  StepCause,
  StepDef,
  StepEffects,
  StepFacts,
  StepMessageSlot,
  StepResult,
} from "./runtime/step";
export { admitMessage, liveStepFacts, liveUnlinkTargets, replayStepFacts, step, stepInit } from "./runtime/step";
// Studio protocol (pure): timeline options, timeline rows, studio WebSocket frames
export type {
  StudioActiveLink,
  StudioLinkSubscriber,
  StudioOutboxEntry,
  StudioReply,
  StudioTimelineEntry,
  TimelineQuery,
} from "./runtime/studio-protocol";
export {
  handleStudioFrame,
  parseTimelineOptions,
  resolveTimelineSize,
  toActiveLink,
  toLinkSubscriber,
  toOutboxEntry,
  toTimelineEntry,
} from "./runtime/studio-protocol";
export type { DueTimer, TimerFailedEvent, TimerRow } from "./runtime/timers-store";
export {
  applyTimerOps,
  deleteTimer,
  dueTimer,
  earliestDeadline,
  nextTimerAt,
  readTimers,
  timerByKey,
  timerFailedEvent,
} from "./runtime/timers-store";
export { isWebSocketUpgrade } from "./runtime/upgrade";
// Typed version chain (ADR-015 D5)
export type { CompiledVersions, RuntimeVersioning, VersionDef, VersionOptions } from "./runtime/versions";
export { compileVersions, toRuntimeDef, version } from "./runtime/versions";
// Timer helper (ADR-015 D2)
export { timer } from "./timer";
