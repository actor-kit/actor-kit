import { ActorKitError } from "./errors";
/**
 * Binary frame format for WebSocket communication.
 *
 * Frame header: 6 bytes
 *   Byte 0: version (uint8) — schema version
 *   Byte 1: type (uint8) — frame type
 *   Bytes 2-5: payload length (uint32, big-endian)
 *
 * SNAPSHOT frame: header + role (uint8) + payload
 * DELTA frame: header + payload (bitmask + changed fields)
 * CONTROL frame: header + controlType (uint8) + payload
 * MESSAGE frame: header + payload (JSON-encoded client message)
 */

export enum FrameType {
  SNAPSHOT = 0x01,
  DELTA = 0x02,
  MESSAGE = 0x03,
  CONTROL = 0x04,
  ACK = 0x05,
}

export enum ControlType {
  REDIRECT = 0x01,
  SCHEMA_CHANGED = 0x02,
  ERROR = 0x03,
  ROLE_CHANGED = 0x04,
}

const HEADER_SIZE = 6; // version(1) + type(1) + length(4)

export function createSnapshotFrame(version: number, roleIndex: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(HEADER_SIZE + 1 + payload.byteLength);
  const view = new DataView(frame.buffer);

  view.setUint8(0, version);
  view.setUint8(1, FrameType.SNAPSHOT);
  view.setUint32(2, payload.byteLength, false);
  view.setUint8(6, roleIndex);
  frame.set(payload, HEADER_SIZE + 1);

  return frame;
}

export function createDeltaFrame(version: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(HEADER_SIZE + payload.byteLength);
  const view = new DataView(frame.buffer);

  view.setUint8(0, version);
  view.setUint8(1, FrameType.DELTA);
  view.setUint32(2, payload.byteLength, false);
  frame.set(payload, HEADER_SIZE);

  return frame;
}

export function createControlFrame(controlType: ControlType, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(HEADER_SIZE + 1 + payload.byteLength);
  const view = new DataView(frame.buffer);

  // byte 0 (version) stays 0 for control frames
  view.setUint8(1, FrameType.CONTROL);
  view.setUint32(2, payload.byteLength, false);
  view.setUint8(6, controlType);
  frame.set(payload, HEADER_SIZE + 1);

  return frame;
}

export interface ParsedFrame {
  version: number;
  type: FrameType;
  payloadLength: number;
  payload: Uint8Array;
  roleIndex?: number; // SNAPSHOT only
  controlType?: ControlType; // CONTROL only
}

function frameTypeOf(byte: number): FrameType {
  const type = Object.values(FrameType).find((t): t is FrameType => t === byte);
  if (type === undefined)
    throw new ActorKitError(
      "invalid_frame",
      `Unknown frame type: ${byte}. Use the same @actor-kit version on the client and the Worker.`,
    );
  return type;
}

function controlTypeOf(byte: number): ControlType {
  const type = Object.values(ControlType).find((t): t is ControlType => t === byte);
  if (type === undefined)
    throw new ActorKitError(
      "invalid_frame",
      `Unknown control type: ${byte}. Use the same @actor-kit version on the client and the Worker.`,
    );
  return type;
}

/** Parses a frame. Throws on a short header or an unknown frame or control type. */
export function parseFrame(frame: Uint8Array): ParsedFrame {
  if (frame.byteLength < HEADER_SIZE) {
    throw new ActorKitError(
      "invalid_frame",
      `Frame too short: ${frame.byteLength} bytes (minimum ${HEADER_SIZE}). Use the same @actor-kit version on the client and the Worker.`,
    );
  }

  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const version = view.getUint8(0);
  const type = frameTypeOf(view.getUint8(1));
  const payloadLength = view.getUint32(2, false);
  const payloadAfter = (start: number) => frame.subarray(start, start + payloadLength);

  switch (type) {
    case FrameType.SNAPSHOT:
      return { version, type, payloadLength, payload: payloadAfter(HEADER_SIZE + 1), roleIndex: view.getUint8(6) };
    case FrameType.CONTROL: {
      const controlType = controlTypeOf(view.getUint8(6));
      return { version, type, payloadLength, payload: payloadAfter(HEADER_SIZE + 1), controlType };
    }
    default:
      return { version, type, payloadLength, payload: payloadAfter(HEADER_SIZE) };
  }
}
