/**
 * An app WebSocket connect request, as the actor's fetch() sees it: the Worker has authenticated
 * the caller and stamped the identity headers (withCallerIdentity), the client asked to upgrade.
 */
import { BINARY_SUPPORT_HEADER, CALLER_ID_HEADER, CALLER_TYPE_HEADER } from "../identity";
import { isWebSocketUpgrade } from "./upgrade";

/** The subprotocol the Actor Kit client always offers; echoed back so browsers accept the upgrade. */
export const ACTOR_KIT_PROTOCOL = "actor-kit.v1";

export type ConnectRequest =
  | {
      ok: true;
      caller: string;
      callerType: "user" | "service";
      /** The client decodes binary frames. */
      binary: boolean;
      /** The subprotocol to answer with, or null when the client offered none we speak. */
      protocol: string | null;
    }
  | { ok: false; status: number; message: string };

const refuse = (status: number, message: string): ConnectRequest => ({ ok: false, status, message });

function callerTypeOf(value: string): "user" | "service" | null {
  return value === "user" || value === "service" ? value : null;
}

function responseProtocol(request: Request): string | null {
  const offered = request.headers
    .get("Sec-WebSocket-Protocol")
    ?.split(",")
    .map((p) => p.trim());
  return offered?.includes(ACTOR_KIT_PROTOCOL) ? ACTOR_KIT_PROTOCOL : null;
}

export function parseConnectRequest(request: Request): ConnectRequest {
  if (!isWebSocketUpgrade(request)) return refuse(426, "Expected WebSocket");
  const caller = request.headers.get(CALLER_ID_HEADER);
  const rawType = request.headers.get(CALLER_TYPE_HEADER);
  if (!caller || !rawType) return refuse(401, "Missing caller identity");
  const callerType = callerTypeOf(rawType);
  if (callerType === null) return refuse(401, "Invalid caller type");
  return {
    ok: true,
    caller,
    callerType,
    binary: request.headers.get(BINARY_SUPPORT_HEADER) === "1",
    protocol: responseProtocol(request),
  };
}
