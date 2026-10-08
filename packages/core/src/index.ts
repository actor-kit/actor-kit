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
export type { FieldDescriptor, Infer, SchemaDefinition } from "./schema";
export { array, boolean, float32, float64, nullable, schema, string, uint8, uint16, uint32 } from "./schema";

// Shared types
export type {
  ContractMessages,
  DeterministicContext,
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
  TimelineEntry,
  UnlinkFn,
} from "./types";

// View
export type { PerCallerViewDef, SharedViewDef, ViewDef } from "./view";
export { view } from "./view";
