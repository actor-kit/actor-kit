// @actor-kit/core — schema, view, binary, frame, types

// Binary encoding
export { decode, encode } from "./binary";
// Delta encoding
export { applyDelta, encodeDelta } from "./delta";
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
export { SchemaValidationError } from "./validate";

// View
export type { PerCallerViewDef, SharedViewDef, ViewDef } from "./view";
export { view } from "./view";
