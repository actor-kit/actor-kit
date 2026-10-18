/**
 * Liveness of the open socket (ADR-020 A): a ping every `intervalMs`; if nothing is heard within
 * `timeoutMs` of a ping, the socket is dead. A socket can die without a close event (iOS froze the
 * page, Wi-Fi changed), so waiting for one is not enough.
 */

export interface HeartbeatOptions {
  /** Ping the actor this often while the socket is open. Default 20 000. */
  intervalMs?: number;
  /** Give up on the socket when nothing arrives this long after a ping. Default 5 000. */
  timeoutMs?: number;
}

export interface HeartbeatSettings {
  readonly intervalMs: number;
  readonly timeoutMs: number;
}

export const DEFAULT_HEARTBEAT: HeartbeatSettings = { intervalMs: 20_000, timeoutMs: 5_000 };

/** The settings for an option: the defaults for what is left out, null when turned off. */
export function resolveHeartbeat(option: HeartbeatOptions | false | undefined): HeartbeatSettings | null {
  if (option === false) return null;
  return { ...DEFAULT_HEARTBEAT, ...option };
}

export interface Liveness {
  /** A socket opened: ping it every interval (restarts the interval, drops a pending deadline). */
  start(): void;
  /** The socket closed or was abandoned: no more pings or deadlines. */
  stop(): void;
  /** Something arrived: the socket is alive. */
  heard(): void;
  /** Ping now (the page became visible, the browser came online), unless a ping is unanswered. */
  probe(): void;
}

export function createLiveness(
  settings: HeartbeatSettings,
  socket: { ping: () => void; onDead: () => void },
): Liveness {
  let interval: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;

  function stop() {
    clearInterval(interval);
    interval = undefined;
    heard();
  }

  function heard() {
    clearTimeout(deadline);
    deadline = undefined;
  }

  function probe() {
    if (interval === undefined || deadline !== undefined) return;
    socket.ping();
    deadline = setTimeout(() => {
      stop();
      socket.onDead();
    }, settings.timeoutMs);
  }

  return {
    start() {
      stop();
      interval = setInterval(probe, settings.intervalMs);
    },
    stop,
    heard,
    probe,
  };
}

/** A liveness that never pings: the heartbeat is turned off. */
export const NO_LIVENESS: Liveness = { start() {}, stop() {}, heard() {}, probe() {} };
