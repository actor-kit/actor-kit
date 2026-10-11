/**
 * ADR-018 C: refusals are a discriminated union { ok: false, code, message, expected?, details?, docs },
 * the same from simulate().send, testActor (thrown as RefusalError) and the runtime's admission. The
 * message is a full sentence naming the fix.
 */
import { ActorKitError, docsUrl, ERROR_CODE_LIST, ERROR_CODES, RefusalError } from "@actor-kit/core";
import { simulate, testActor } from "@actor-kit/test";
import {
  defineActor,
  message,
  refusalCode,
  refuseAdmission,
  refuseInvalidDelivery,
  refuseNoRole,
  refuseNotInitialized,
} from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { QuizContract } from "../../examples/quiz/quiz";

type S = { n: number };
const Counter = defineActor("counter", {
  input: z.object({}),
  init: (): S => ({ n: 0 }),
  roles: {
    owner: (_s: S, caller: string) => caller === "owner",
    viewer: (_s: S, caller: string) => caller !== "nobody",
  },
  messages: {
    ADD: message(z.object({ by: z.number().int() }), {
      guard: (s: S) => s.n < 1,
      handler: (s: S, { by }) => ({ n: s.n + by }),
    }),
  },
  views: { owner: { fn: (s: S) => s }, viewer: { fn: (s: S) => s } },
});

async function counter() {
  const sim = simulate({ contracts: [Counter] });
  return sim.spawn(Counter, "c", {});
}

describe("refusals from simulate().send", () => {
  it("wrong_state names the states that accept it and the current one", async () => {
    const q = await simulate({ contracts: [QuizContract] }).spawn(QuizContract, "q", {});
    expect(q.send("ann", { type: "ANSWER", text: "1" })).toEqual({
      ok: false,
      code: "wrong_state",
      message: "ANSWER is accepted in round; the actor is in lobby.",
      expected: ["round"],
      details: { phase: "lobby" },
      docs: "https://actorkit.dev/errors/wrong_state/",
    });
  });

  it("unknown_message lists what the role can send in the current state", async () => {
    const q = await simulate({ contracts: [QuizContract] }).spawn(QuizContract, "q", {});
    const result = q.send("ann", { type: "NOPE" });
    expect(result).toEqual({
      ok: false,
      code: "unknown_message",
      message: 'Message "NOPE" not found for role "player" in state "lobby". It can send: START, JOIN.',
      expected: ["START", "JOIN"],
      docs: docsUrl("unknown_message"),
    });
  });

  it("unknown_message for a role that can send nothing says it is read-only", async () => {
    const ReadOnly = defineActor("read-only", {
      input: z.object({}),
      init: (): S => ({ n: 0 }),
      roles: { viewer: () => true },
      messages: {},
      views: { viewer: { fn: (s: S) => s } },
    });
    const r = await simulate({ contracts: [ReadOnly] }).spawn(ReadOnly, "r", {});
    expect(r.send("u", { type: "ADD" })).toMatchObject({
      code: "unknown_message",
      message: 'Message "ADD" not found for role "viewer". It can send no messages (a read-only role).',
      expected: [],
    });
  });

  it("invalid_payload gives the Zod issues and names each field", async () => {
    const c = await counter();
    const result = c.send("owner", { type: "ADD", by: 1.5 });
    expect(result).toMatchObject({
      ok: false,
      code: "invalid_payload",
      message:
        'Validation failed for "ADD": by: Invalid input: expected int, received number. Fix the payload to match its schema and send it again.',
      docs: docsUrl("invalid_payload"),
    });
    expect(result.ok === false && result.details).toEqual([
      expect.objectContaining({ path: ["by"], message: "Invalid input: expected int, received number" }),
    ]);
  });

  it("guard_failed names the caller and role", async () => {
    const c = await counter();
    c.send("owner", { type: "ADD", by: 1 });
    expect(c.send("owner", { type: "ADD", by: 1 })).toEqual({
      ok: false,
      code: "guard_failed",
      message: 'Guard rejected "ADD" for caller "owner" (role "owner"). Send it only when the guard allows it.',
      docs: docsUrl("guard_failed"),
    });
  });

  it("no_role names the caller and how to fix the roles", async () => {
    const c = await counter();
    expect(c.send("nobody", { type: "ADD", by: 1 })).toEqual({
      ok: false,
      code: "no_role",
      message:
        'No role matched for caller "nobody" (user). Add a catch-all role last in roles (e.g. viewer: () => true), or check the token\'s sub and act claims.',
      docs: docsUrl("no_role"),
    });
  });
});

describe("refusals from testActor are thrown as RefusalError", () => {
  it("carries the same refusal value", async () => {
    const t = testActor(Counter);
    const error = await t.send({ n: 1 }, "owner", { type: "ADD", by: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RefusalError);
    expect(error).toBeInstanceOf(ActorKitError);
    if (!(error instanceof RefusalError)) return;
    expect(error.code).toBe("guard_failed");
    expect(error.docs).toBe(docsUrl("guard_failed"));
    expect(error.refusal).toMatchObject({ ok: false, code: "guard_failed" });
    expect(error.message).toBe(error.refusal.message);
  });

  it("view for a caller with no role is a no_role refusal", () => {
    const t = testActor(Counter);
    let thrown: unknown;
    try {
      t.view({ n: 0 }, "nobody");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RefusalError);
    expect(thrown instanceof RefusalError && thrown.refusal.code).toBe("no_role");
  });
});

describe("refuseAdmission", () => {
  it("builds the refusal for each admission error of the step core", () => {
    const def = { messages: { player: { A: {}, B: {} } } };
    expect(refuseAdmission(def, null, "player", "C", { ok: false, error: "message_not_found" })).toMatchObject({
      code: "unknown_message",
      expected: ["A", "B"],
    });
    expect(
      refuseAdmission(def, null, "player", "A", { ok: false, error: "validation_failed", detail: "bad" }),
    ).toMatchObject({
      code: "invalid_payload",
      message: 'Validation failed for "A": bad. Fix the payload to match its schema and send it again.',
    });
  });
});

describe("error codes", () => {
  it("every code's docs URL is under actorkit.dev/errors", () => {
    expect(ERROR_CODE_LIST).toEqual(Object.keys(ERROR_CODES));
    for (const code of ERROR_CODE_LIST) expect(docsUrl(code)).toBe(`https://actorkit.dev/errors/${code}/`);
  });

  it("ActorKitError carries code, docs and details; its name stays Error", () => {
    const error = new ActorKitError("undeclared_timer", "Timer x is not declared.", { timer: "x" });
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      code: "undeclared_timer",
      docs: docsUrl("undeclared_timer"),
      details: { timer: "x" },
    });
    expect(String(error)).toBe("Error: Timer x is not declared.");
  });
});

describe("refusal details", () => {
  const notFound = { ok: false, error: "message_not_found" } as const;

  it("invalid_payload: nested paths are dotted, a root issue has no path, issues join with '; '", () => {
    const issues = [
      { path: ["a", "b"], message: "bad a.b" },
      { path: [], message: "bad root" },
    ];
    const result = refuseAdmission({}, null, "r", "M", { ok: false, error: "validation_failed", detail: "x", issues });
    expect(result).toStrictEqual({
      ok: false,
      code: "invalid_payload",
      message:
        'Validation failed for "M": a.b: bad a.b; bad root. Fix the payload to match its schema and send it again.',
      details: issues,
      docs: docsUrl("invalid_payload"),
    });
  });

  it("invalid_payload without issues uses the detail and has no details", () => {
    expect(refuseAdmission({}, null, "r", "M", { ok: false, error: "validation_failed", detail: "bad" })).toStrictEqual(
      {
        ok: false,
        code: "invalid_payload",
        message: 'Validation failed for "M": bad. Fix the payload to match its schema and send it again.',
        docs: docsUrl("invalid_payload"),
      },
    );
  });

  it("guard_failed without a caller names only the role", () => {
    expect(refuseAdmission({}, null, "r", "M", { ok: false, error: "guard_failed" }).message).toBe(
      'Guard rejected "M" (role "r"). Send it only when the guard allows it.',
    );
  });

  it("wrong_state lists every state that accepts the message", () => {
    expect(
      refuseAdmission({}, null, "r", "M", { ok: false, error: "wrong_state", phase: "a", acceptedIn: ["b", "c"] }),
    ).toStrictEqual({
      ok: false,
      code: "wrong_state",
      message: "M is accepted in b or c; the actor is in a.",
      expected: ["b", "c"],
      details: { phase: "a" },
      docs: docsUrl("wrong_state"),
    });
  });

  it("unknown_message in an actor with states but no top-level messages, in a state without messages", () => {
    const def = { states: { idle: {}, busy: { messages: { STOP: {} } } } };
    const idle = { shared: {}, phase: "idle", local: null, stateTimers: [] };
    const busy = { ...idle, phase: "busy" };
    expect(refuseAdmission(def, idle, "r", "GO", notFound)).toMatchObject({
      message: 'Message "GO" not found for role "r" in state "idle". It can send no messages (a read-only role).',
      expected: [],
    });
    expect(refuseAdmission(def, busy, "r", "GO", notFound)).toMatchObject({ expected: ["STOP"] });
  });

  it("not_initialized, invalid_delivery and no_role read as sentences with their docs", () => {
    expect(refuseNotInitialized()).toStrictEqual({
      ok: false,
      code: "not_initialized",
      message: "The actor is not initialized. Spawn it with spawn({ input }) before sending messages.",
      docs: docsUrl("not_initialized"),
    });
    expect(refuseInvalidDelivery("attempt: expected number")).toStrictEqual({
      ok: false,
      code: "invalid_delivery",
      message:
        "The forward's delivery metadata is invalid (attempt: expected number). Send forwards only through ctx.forward().",
      docs: docsUrl("invalid_delivery"),
    });
    expect(refuseNoRole("x", "service").message).toBe(
      'No role matched for caller "x" (service). Add a catch-all role last in roles (e.g. viewer: () => true), or check the token\'s sub and act claims.',
    );
  });

  it("refusalCode maps the step core's admission errors", () => {
    expect(
      (["message_not_found", "validation_failed", "guard_failed", "wrong_state"] as const).map(refusalCode),
    ).toEqual(["unknown_message", "invalid_payload", "guard_failed", "wrong_state"]);
  });
});
