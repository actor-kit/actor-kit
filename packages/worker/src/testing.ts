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
export { hasActorDefShape } from "./runtime/actor-def";
// Timeouts and cancellation of tries (ADR-016 §3)
export type { AttemptResult, InFlight } from "./runtime/attempt";
export { createInFlight, DEFAULT_TIMEOUT_MS, resolveTimeoutMs, runAttempt } from "./runtime/attempt";
// CDC
export type { ChangeEntry } from "./runtime/cdc";
export { createChangeEntry } from "./runtime/cdc";
export { closeCodeToSend } from "./runtime/close-code";
export type { ConnectRequest } from "./runtime/connect-request";
export { ACTOR_KIT_PROTOCOL, parseConnectRequest } from "./runtime/connect-request";
// Determinism guards for the test harness (ADR-016 §5)
export { NondeterminismError, withDeterminismGuard } from "./runtime/determinism";
export { parseDuration } from "./runtime/duration";
// Effect ids, retries, outbox store (ADR-015 D1)
export type { EffectIdParts } from "./runtime/effect-id";
export { formatEffectId, parseEffectId } from "./runtime/effect-id";
// Effect metadata: idempotency keys and forward delivery (ADR-016 §1)
export type { DeliveryInfo, EffectInfo } from "./runtime/effect-info";
export { DeliveryInfoSchema, deliveryInfo, effectInfo, idempotencyKey } from "./runtime/effect-info";
// Typed env (ADR-016 §4)
export type { EnvIssue, EnvParser, ParsedEnv } from "./runtime/env";
export {
  d1,
  durableObject,
  envErrorMessage,
  envInvalidEvent,
  kv,
  parseActorEnv,
  queue,
  r2,
  service,
} from "./runtime/env";
export { getTokenFromRequest } from "./runtime/get-token";
// Actor journal (ADR-013): facts, events, replay
export type {
  EmittedEvent,
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
  JournalEmittedDivergenceError,
  JournalNondeterminismError,
  JournalVersionError,
  journalHighWater,
  nextTransitionSeq,
  readJournal,
  rebuildFromJournal,
  resolveJournalConfig,
  snapshotSeq,
} from "./runtime/journal";
// Studio timeline read from the journal (ADR-017 §5)
export type { TimelinePageQuery, TimelineSource } from "./runtime/journal-timeline";
export { readStudioTimeline, timelineCause, timelineEntry } from "./runtime/journal-timeline";
// Live app connections from held sockets (pure)
export type { ConnectionAttachment, LiveConnection, SocketRecord } from "./runtime/live-connections";
export {
  isStudioSocket,
  nextConnectionSeq,
  readConnectionAttachment,
  toLiveConnections,
} from "./runtime/live-connections";
export type { MessageMeta, ParsedMessageMeta } from "./runtime/message-meta";
export { forwardMeta, parseMessageMeta } from "./runtime/message-meta";
// Message router
export type { RouteResult } from "./runtime/message-router";
export { routeMessage } from "./runtime/message-router";
export { ACTOR_KIT_MIGRATIONS } from "./runtime/migrations";
// Outbox
export type {
  EmittedEffect,
  ExecutionEntry,
  ForwardCall,
  ForwardEntry,
  LinkCall,
  ScheduleRequest,
  TimerOp,
  TimerSchedule,
  UnlinkCall,
} from "./runtime/outbox";
export { createOutbox } from "./runtime/outbox";
export type {
  DueExecution,
  DueForward,
  EffectTable,
  NewExecution,
  NewForward,
  OutboxFailedEvent,
  OutboxRow,
} from "./runtime/outbox-store";
export {
  cancelUndoneEffects,
  dueExecutions,
  dueForwards,
  finishAttempt,
  insertExecutions,
  insertForwards,
  isRunning,
  nextRetryAt,
  outboxFailedEvent,
  readOutboxRows,
  redriveExecution,
  requeueInterrupted,
  startAttempt,
} from "./runtime/outbox-store";
// Typed declarations: setup({ events, states }) (ADR-017)
export type { StepStateDef } from "./runtime/phases";
export { phasedState } from "./runtime/phases";
// Outbound event stream (ADR-017 §3)
export type { PublishConfig, PublishedBody, PublishedMessage, PublishOption } from "./runtime/publish";
export { PUBLISH_SERVICE, publishedMessages, resolvePublish, sendToQueue } from "./runtime/publish";
// Typed refusals (ADR-018 C, D)
export type { AdmissionError, RefusalCode } from "./runtime/refusal";
export { RefusalError, refusalCode } from "./runtime/refusal";
// Namespace resolution
export { resolveNamespace } from "./runtime/resolve-namespace";
export type { RestorePlan } from "./runtime/restore";
export { planRestore } from "./runtime/restore";
export type { AttemptSettlement, RetryOption, RetryPolicy, SettledTry, TryOutcome } from "./runtime/retry";
export {
  DEFAULT_RETRY_POLICY,
  linkRetryPolicies,
  linkRetryRules,
  resolveRetryPolicy,
  resolveRetryRule,
  retryDelay,
  settleAttempt,
  settleTry,
  shouldRetry,
} from "./runtime/retry";
// Role resolution
export type { RolePredicate } from "./runtime/roles";
export { resolveRole } from "./runtime/roles";
// Route parsing
export type { ActorRoute } from "./runtime/route-to-actor";
export { parseActorRoute } from "./runtime/route-to-actor";
// Typed service errors (ADR-016 §2)
export type {
  BuiltInError,
  DefectError,
  ErrorsParser,
  ServiceError,
  TaggedError,
  TimeoutError,
} from "./runtime/service-error";
export {
  classifyFailure,
  defectError,
  describeRecordedError,
  describeServiceError,
  fail,
  isBuiltInError,
  isTaggedError,
  ServiceFailure,
  timeoutError,
} from "./runtime/service-error";
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
export {
  admitMessage,
  admitStepMessage,
  initialState,
  liveStepFacts,
  liveUnlinkTargets,
  replayStepFacts,
  step,
  stepInit,
} from "./runtime/step";
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
  toActiveLink,
  toLinkSubscriber,
  toOutboxEntry,
} from "./runtime/studio-protocol";
export { findStudioRegistry, looksLikeDONamespace } from "./runtime/studio-registry";
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
// Causation and correlation ids (ADR-017 §4)
export type { CauseRef, Trace } from "./runtime/trace";
export { effectCauseId, eventId, journalTrace, parseCauseId } from "./runtime/trace";
export { isWebSocketUpgrade } from "./runtime/upgrade";
// Typed version chain (ADR-015 D5)
export type { CompiledVersions, RuntimeVersioning, VersionDef, VersionOptions } from "./runtime/versions";
export { compileVersions, toRuntimeDef, version } from "./runtime/versions";
export type {
  EmittingMessageContext,
  EmittingTimerContext,
  EventPayloads,
  EventSchemas,
  Goto,
  InputArgs,
  LocalOf,
  PhaseContext,
  PhasedState,
  PhasedStateOf,
  PhaseHelpers,
  PhaseMessageDef,
  PhaseResult,
  PhaseTimerDef,
  Setup,
  StateDecl,
  StateDecls,
  StateDef,
  StatePart,
  TypedEmit,
  TypedStateDef,
} from "./setup";
export { goto, PhaseTransition, setup, stay } from "./setup";
// Timer helper (ADR-015 D2)
export { timer } from "./timer";
