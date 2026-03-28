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
// Schema builder
export type { FieldDescriptor, Infer, SchemaDefinition } from "./schema";
export { array, boolean, float32, float64, schema, string, uint8, uint16, uint32 } from "./schema";

// Shared types
export type {
  CallbackDef,
  Effect,
  EmitFn,
  GuardContext,
  MessageContext,
  MessageDef,
  NormalizedRequestConfig,
  RequestConfig,
  RequestFn,
} from "./types";
export { normalizeRequest } from "./types";

// View
export type { ViewDef } from "./view";
export { view } from "./view";
