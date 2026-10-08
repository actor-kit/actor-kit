import { describe, expect, it } from "vitest";
import { handleStudioFrame, studioView } from "../../packages/worker/src/runtime/studio-protocol";

type State = { owner: string };
const state: State = { owner: "alice" };

// "user" matches any caller presenting as a user, so a mutant that resolves a role for a
// null caller, or that defaults callerType to something other than "user", is visible.
const source = {
  state,
  roles: {
    service: (_s: State, _c: string, { callerType }: { callerType: "user" | "service" }) => callerType === "service",
    user: (_s: State, _c: string, { callerType }: { callerType: "user" | "service" }) => callerType === "user",
  },
  views: {
    service: { kind: "shared" as const, fn: (_s: State, caller: string) => ({ seenAs: caller }) },
    user: { kind: "perCaller" as const, fn: (_s: State, caller: string) => ({ seenAs: caller }) },
  },
};

describe("studioView", () => {
  it("projects a shared view without a caller as __studio and reports no caller role", () => {
    expect(studioView({ role: "service" }, source)).toEqual({
      type: "studio.view",
      role: "service",
      caller: null,
      callerRole: null,
      data: { seenAs: "__studio" },
    });
  });

  it("defaults callerType to user when resolving the caller's role", () => {
    expect(studioView({ role: "user", caller: "bob" }, source)).toEqual({
      type: "studio.view",
      role: "user",
      caller: "bob",
      callerRole: "user",
      data: { seenAs: "bob" },
    });
  });

  it("uses an explicit service callerType", () => {
    expect(studioView({ role: "service", caller: "svc", callerType: "service" }, source)).toEqual({
      type: "studio.view",
      role: "service",
      caller: "svc",
      callerRole: "service",
      data: { seenAs: "svc" },
    });
  });
});

describe("handleStudioFrame studio.requestView callerType", () => {
  it("accepts callerType user", () => {
    const frame = JSON.stringify({ type: "studio.requestView", role: "user", caller: "bob", callerType: "user" });
    expect(handleStudioFrame(frame, source)).toEqual({
      type: "studio.view",
      role: "user",
      caller: "bob",
      callerRole: "user",
      data: { seenAs: "bob" },
    });
  });

  it("accepts callerType service", () => {
    const frame = JSON.stringify({ type: "studio.requestView", role: "user", caller: "bob", callerType: "service" });
    expect(handleStudioFrame(frame, source)).toEqual({
      type: "studio.view",
      role: "user",
      caller: "bob",
      callerRole: "service",
      data: { seenAs: "bob" },
    });
  });

  it("rejects an empty callerType", () => {
    const frame = JSON.stringify({ type: "studio.requestView", role: "user", caller: "bob", callerType: "" });
    const reply = handleStudioFrame(frame, source);
    expect(reply.type).toBe("studio.error");
    expect("error" in reply ? reply.error : "").toMatch(/^Invalid studio\.requestView: .*callerType/s);
  });
});
