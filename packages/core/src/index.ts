// @actor-kit/core — schema, view, binary, frame, types

// Binary encoding
export { decode, encode } from "./binary";
// Delta encoding
export { applyDelta, encodeDelta } from "./delta";
// Errors that teach (ADR-018 C)
export type { ErrorCode, ErrorCodeInfo, Refusal, RefusalCode } from "./errors";
export {
  ActorKitError,
  docsUrl,
  ERROR_CODE_LIST,
  ERROR_CODES,
  ERRORS_DOCS_BASE,
  isRefusalCode,
  REFUSAL_CODES,
  RefusalError,
  refusal,
} from "./errors";
export type { ParsedFrame } from "./frame";
// Frame protocol
export {
  ControlType,
  createControlFrame,
  createDeltaFrame,
  createSnapshotFrame,
  FrameType,
  parseFrame,
} from "./frame";
// Hashing
export { xxh64 } from "./hash";
// Schema builder
export type { FieldDescriptor, Infer, PrimitiveDescriptor, SchemaDefinition } from "./schema";
export { array, boolean, float32, float64, nullable, schema, string, uint8, uint16, uint32 } from "./schema";

// Shared types
export type {
  CancelFn,
  ContractMessages,
  DeliveryInfo,
  DeterministicContext,
  Duration,
  EmitFn,
  ExecuteFn,
  Execution,
  ForwardCall,
  ForwardFn,
  GuardContext,
  LinkedView,
  LinkFn,
  MessageContext,
  MessageDef,
  MessageEvent,
  MutationCause,
  ScheduleFn,
  ScheduleOptions,
  TimelineEntry,
  TimerContext,
  TimerDef,
  UnlinkFn,
} from "./types";

// View
export type { PerCallerViewDef, SharedViewDef, ViewDef } from "./view";
export { view } from "./view";
