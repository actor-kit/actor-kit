// @actor-kit/core — schema, view, binary, frame, types

// Schema builder
export type { FieldDescriptor, Infer, SchemaDefinition } from "./schema";
export { array, boolean, float32, float64, schema, string, uint8, uint16, uint32 } from "./schema";

// Binary encoding
export { decode, encode } from "./binary";

// Delta encoding
export { applyDelta, encodeDelta } from "./delta";

// Frame protocol
export {
  ControlType,
  createControlFrame,
  createDeltaFrame,
  createSnapshotFrame,
  FrameType,
  parseFrame,
} from "./frame";
export type { ParsedFrame } from "./frame";

// Shared types
export type {
  CallbackDef,
  Effect,
  EmitFn,
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
