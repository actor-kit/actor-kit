/**
 * URL builder — turns (path, host?) into a full ws:// or wss:// URL.
 *
 * Browser default: host falls back to window.location.host.
 * Protocol inference: localhost / IPv4 / IPv6 → ws, everything else → wss.
 */

export function buildUrl(path: string, host?: string): string {
  const resolvedHost = host ?? (typeof window !== "undefined" && window.location ? window.location.host : null);
  if (!resolvedHost) {
    throw new Error("host is required when window.location is not available (server-side, tests)");
  }

  const protocol = inferProtocol(resolvedHost);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${protocol}://${resolvedHost}${normalizedPath}`;
}

export function inferProtocol(host: string): "ws" | "wss" {
  // IPv6 literal: starts with "[" — always treat as local-ish (no TLS by default)
  if (host.startsWith("[")) return "ws";

  // Strip optional :port (only the LAST colon, since IPv6 is bracketed above)
  const lastColon = host.lastIndexOf(":");
  const hostname = lastColon >= 0 ? host.slice(0, lastColon) : host;

  if (hostname === "localhost") return "ws";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return "ws";
  return "wss";
}
