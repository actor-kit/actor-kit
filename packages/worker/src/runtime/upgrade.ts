/** Whether a request asks to upgrade to a WebSocket. */
export function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}
