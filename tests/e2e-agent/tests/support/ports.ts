/**
 * Default port block 8830-8839 (never the 8799-8810 ports the root Playwright config reuses).
 * Each port can be overridden from the environment so parallel worktrees don't share servers.
 */
function portFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be a TCP port, got "${raw}"`);
  }
  return port;
}

export const STUDIO_PORT = portFromEnv("E2E_AGENT_STUDIO_PORT", 8830);
export const CHAT_ROOM_PORT = portFromEnv("E2E_AGENT_CHAT_ROOM_PORT", 8831);
/** A Studio worker the restart test starts, kills and starts again itself. */
export const RESTART_PORT = portFromEnv("E2E_AGENT_RESTART_PORT", 8832);
