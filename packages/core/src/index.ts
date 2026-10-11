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
export type {
  ArrayDescriptor,
  EnumDescriptor,
  EnumValue,
  FieldDescriptor,
  Infer,
  JsonDescriptor,
  NullableDescriptor,
  PrimitiveDescriptor,
  RecordDescriptor,
  SchemaDefinition,
  UnionDescriptor,
} from "./schema";
export {
  array,
  boolean,
  enumOf,
  float32,
  float64,
  int8,
  int16,
  int32,
  json,
  literal,
  nullable,
  record,
  schema,
  string,
  uint8,
  uint16,
  uint32,
  union,
} from "./schema";
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
// Validation (StandardSchemaV1)
export type { StandardIssue, StandardProps, StandardResult, Validates } from "./validate";
export { describeIssues, SchemaValidationError } from "./validate";

// View
export type { PerCallerViewDef, SharedViewDef, ViewDef } from "./view";
export { view } from "./view";
