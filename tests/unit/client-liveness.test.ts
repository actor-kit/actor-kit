/**
 * The client's liveness check (ADR-020 A): a ping every interval, a deadline after each ping that
 * any frame clears, and a probe that pings at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLiveness, DEFAULT_HEARTBEAT, resolveHeartbeat } from "../../packages/client/src/liveness";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function probeOf(intervalMs = 1000, timeoutMs = 300) {
  const ping = vi.fn();
  const onDead = vi.fn();
  const liveness = createLiveness({ intervalMs, timeoutMs }, { ping, onDead });
  return { liveness, ping, onDead };
}

describe("resolveHeartbeat", () => {
  it("defaults to a ping every 20 s with 5 s to answer", () => {
    expect(DEFAULT_HEARTBEAT).toEqual({ intervalMs: 20_000, timeoutMs: 5_000 });
    expect(resolveHeartbeat(undefined)).toEqual({ intervalMs: 20_000, timeoutMs: 5_000 });
  });

  it("fills in what is left out", () => {
    expect(resolveHeartbeat({ intervalMs: 50 })).toEqual({ intervalMs: 50, timeoutMs: 5_000 });
    expect(resolveHeartbeat({ timeoutMs: 70 })).toEqual({ intervalMs: 20_000, timeoutMs: 70 });
    expect(resolveHeartbeat({})).toEqual(DEFAULT_HEARTBEAT);
  });

  it("false turns it off", () => {
    expect(resolveHeartbeat(false)).toBeNull();
  });
});

describe("createLiveness", () => {
  it("pings once per interval after start(), not before", () => {
    const { liveness, ping } = probeOf();
    vi.advanceTimersByTime(5000);
    expect(ping).not.toHaveBeenCalled();

    liveness.start();
    vi.advanceTimersByTime(999);
    expect(ping).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ping).toHaveBeenCalledTimes(1);
    liveness.heard();
    vi.advanceTimersByTime(1000);
    expect(ping).toHaveBeenCalledTimes(2);
    liveness.stop();
  });

  it("calls onDead when nothing is heard within timeoutMs of a ping, and stops pinging", () => {
    const { liveness, ping, onDead } = probeOf();
    liveness.start();
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(299);
    expect(onDead).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDead).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_000);
    expect(onDead).toHaveBeenCalledTimes(1);
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it("leaves no timer behind once the socket is dead, or after stop()", () => {
    const dead = probeOf();
    dead.liveness.start();
    vi.advanceTimersByTime(1300);
    expect(dead.onDead).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    const stopped = probeOf();
    stopped.liveness.start();
    stopped.liveness.probe();
    stopped.liveness.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("anything heard before the deadline keeps the socket", () => {
    const { liveness, onDead } = probeOf();
    liveness.start();
    vi.advanceTimersByTime(700);
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(599);
      liveness.heard(); // 299 ms after this interval's ping
      vi.advanceTimersByTime(401);
    }
    expect(onDead).not.toHaveBeenCalled();
    liveness.stop();
  });

  it("probe() pings at once and starts the deadline", () => {
    const { liveness, ping, onDead } = probeOf();
    liveness.start();
    liveness.probe();
    expect(ping).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300);
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it("a ping while one is unanswered does not push the deadline back", () => {
    const { liveness, ping, onDead } = probeOf(1000, 300);
    liveness.start();
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(200);
    liveness.probe();
    expect(ping).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it("stop() cancels the interval and a pending deadline", () => {
    const { liveness, ping, onDead } = probeOf();
    liveness.start();
    liveness.probe();
    liveness.stop();
    vi.advanceTimersByTime(10_000);
    expect(onDead).not.toHaveBeenCalled();
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it("start() again restarts the interval and drops the old deadline", () => {
    const { liveness, ping, onDead } = probeOf();
    liveness.start();
    liveness.probe();
    liveness.start();
    vi.advanceTimersByTime(999);
    expect(onDead).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ping).toHaveBeenCalledTimes(2);
    liveness.stop();
  });

  it("probe() before start() does nothing (no socket to check)", () => {
    const { liveness, ping, onDead } = probeOf();
    liveness.probe();
    vi.advanceTimersByTime(10_000);
    expect(ping).not.toHaveBeenCalled();
    expect(onDead).not.toHaveBeenCalled();
  });
});
