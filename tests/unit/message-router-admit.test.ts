/**
 * routeMessage() on top of admitMessage(): the guard sees who is calling, and a handler that
 * returns a Promise is refused.
 */
import { routeMessage } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const ctx = {
  caller: "alice",
  callerType: "service" as const,
  env: { E: 1 },
  now: () => 0,
  id: () => "",
  random: () => 0,
  execute: () => {},
  link: () => {},
  unlink: () => {},
  forward: () => {},
};

describe("routeMessage", () => {
  it("gives the guard role, caller, callerType and env", () => {
    const seen: unknown[] = [];
    const messages = {
      user: {
        GO: {
          schema: z.object({}),
          guard: (_s: unknown, _p: unknown, g: unknown) => {
            seen.push(g);
            return true;
          },
          handler: (s: number) => s + 1,
        },
      },
    };
    expect(routeMessage(messages, "user", 1, { type: "GO" }, ctx)).toEqual({ ok: true, state: 2, payload: {} });
    expect(seen).toEqual([{ role: "user", caller: "alice", callerType: "service", env: { E: 1 } }]);
  });

  it("refuses a handler that returns a Promise", () => {
    const messages = { user: { GO: { schema: z.object({}), handler: async (s: number) => s } } };
    expect(() => routeMessage(messages, "user", 1, { type: "GO" }, ctx)).toThrow(
      'Message handler for "GO" returned a Promise. Handlers must be synchronous',
    );
  });
});
