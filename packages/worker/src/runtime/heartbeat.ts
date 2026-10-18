/**
 * The client's heartbeat (ADR-020 B). The actor registers this pair with
 * `ctx.setWebSocketAutoResponse`, so the runtime answers a ping itself: a hibernated actor is not
 * woken and the ping never reaches `webSocketMessage`.
 */
export const HEARTBEAT_PING = JSON.stringify({ type: "__ping" });
export const HEARTBEAT_PONG = JSON.stringify({ type: "__pong" });
