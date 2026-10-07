/**
 * URL builder — turns (path, host?) into a full ws:// or wss:// URL.
 *
 * Browser default: host falls back to window.location.host, and the scheme follows the page
 * (https → wss, http → ws).
 * Protocol inference: localhost / IPv4 / IPv6 → ws, everything else → wss.
 */

export function buildUrl(path: string, host?: string): string {
  const location = typeof window !== "undefined" && window.location ? window.location : null;
  const resolvedHost = host ?? location?.host ?? null;
  if (!resolvedHost) {
    throw new Error("host is required when window.location is not available (server-side, tests)");
  }

  // Same-origin: the page's own scheme decides (an https page must use wss, even on a LAN IP).
  const pageScheme = host === undefined ? location?.protocol : undefined;
  const protocol = pageScheme === "https:" ? "wss" : pageScheme === "http:" ? "ws" : inferProtocol(resolvedHost);
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
