/**
 * @vitest-environment jsdom
 */
/**
 * useActorClient(): the client a Provider holds, for code that works with it directly (subscribe to every
 * change for an animation or a sound cue, read `client.view` in an effect). 0.52's `useClient()` with no
 * argument did this; 0.3's `useClient(options)` creates a client instead (found migrating story-nook).
 */
import type { ActorClient } from "@actor-kit/client";
import { createActorContext } from "@actor-kit/react";
import { cleanup, render } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

type View = { n: number };
type Event = { type: "INC" };
const Ctx = createActorContext<View, Event>();

const fake = (): ActorClient<View, Event> => ({
  connectionState: "connected",
  view: { n: 1 },
  role: undefined,
  subscribe: () => () => {},
  onStateChange: () => () => {},
  send: () => {},
  trigger: () => {},
  connect: () => {},
  disconnect: () => {},
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useActorClient", () => {
  it("returns the Provider's client", () => {
    const client = fake();
    const seen: unknown[] = [];
    function Probe() {
      seen.push(Ctx.useActorClient());
      return null;
    }
    render(
      <Ctx.Provider client={client}>
        <Probe />
      </Ctx.Provider>,
    );
    expect(seen[0]).toBe(client);
  });

  it("outside a Provider is a missing_provider error", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Bad() {
      Ctx.useActorClient();
      return null;
    }
    expect(() => render(<Bad />)).toThrow(expect.objectContaining({ code: "missing_provider" }));
  });
});
