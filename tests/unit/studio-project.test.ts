import { describe, expect, it } from "vitest";
import {
  createCallerHasher,
  projectConnections,
  projectOutboxRow,
  projectState,
  projectTimelineEntry,
  projectView,
  type StudioProjection,
} from "../../packages/worker/src/runtime/studio-project";
import { compileRedaction, REDACTED } from "../../packages/worker/src/runtime/studio-redact";

const KEY = "test-only-hash-key";
const redactor = compileRedaction(["players.*.name", "name", "**.secretNote"]);

function human(): StudioProjection {
  return { redactor, hashCaller: null };
}
function agent(): StudioProjection {
  return { redactor, hashCaller: createCallerHasher(KEY) };
}

function entry(causeType: string, cause: Record<string, unknown>, state: unknown = { players: [{ name: "Juneau" }] }) {
  return {
    id: 1,
    causeType,
    causeData: JSON.stringify(cause),
    stateSnapshot: JSON.stringify(state),
    checksum: "abc",
    createdAt: 5,
  };
}

describe("createCallerHasher", () => {
  it("is stable, short and prefixed", async () => {
    const hash = createCallerHasher(KEY);
    const a = await hash("Juneau");
    expect(a).toMatch(/^caller:[0-9a-f]{12}$/);
    expect(await hash("Juneau")).toBe(a);
    expect(await hash("Sis")).not.toBe(a);
  });

  it("depends on the key", async () => {
    expect(await createCallerHasher("k1")("Juneau")).not.toBe(await createCallerHasher("k2")("Juneau"));
  });
});

describe("projectTimelineEntry", () => {
  it("redacts the state snapshot and keeps id, checksum and time", async () => {
    const out = await projectTimelineEntry(entry("init", {}), human());
    expect(JSON.parse(out.stateSnapshot)).toEqual({ players: [{ name: REDACTED }] });
    expect(out).toMatchObject({ id: 1, causeType: "init", checksum: "abc", createdAt: 5 });
  });

  it.each([
    ["message", { messageType: "JOIN", caller: "u1", payload: { name: "Juneau" } }, "payload"],
    ["service.onDone", { service: "s", input: { name: "Juneau" }, result: { name: "Juneau" } }, "input"],
    ["service.onDone", { service: "s", input: {}, result: { name: "Juneau" } }, "result"],
    ["service.onError", { service: "s", input: { name: "Juneau" }, error: "boom" }, "input"],
    ["link.onUpdate", { sourceType: "T", sourceId: "x", viewData: { name: "Juneau" } }, "viewData"],
  ])("redacts %s cause data relative to its %s", async (causeType, cause, field) => {
    const out = await projectTimelineEntry(entry(causeType, cause), human());
    expect(out.causeData).not.toContain("Juneau");
    expect(JSON.parse(out.causeData)[field]).toEqual({ name: REDACTED });
  });

  it("leaves causes without values alone", async () => {
    const cause = { fromVersion: 1, toVersion: 2 };
    expect(JSON.parse((await projectTimelineEntry(entry("migrate", cause), human())).causeData)).toEqual(cause);
  });

  it("shows raw callers to people and hashed callers to agents", async () => {
    const e = entry("lifecycle.connect", { caller: "Juneau", callerType: "user" });
    expect(JSON.parse((await projectTimelineEntry(e, human())).causeData).caller).toBe("Juneau");
    const agentCaller = JSON.parse((await projectTimelineEntry(e, agent())).causeData).caller;
    expect(agentCaller).toBe(await createCallerHasher(KEY)("Juneau"));
  });

  it("redacts an unparsable snapshot whole when redaction is active", async () => {
    const e = { ...entry("init", {}), stateSnapshot: "not json", causeData: "nope" };
    const out = await projectTimelineEntry(e, human());
    expect(out.stateSnapshot).toBe(JSON.stringify(REDACTED));
    expect(out.causeData).toBe(JSON.stringify(REDACTED));
  });

  it("returns the entry unchanged with no patterns and no hashing", async () => {
    const e = entry("message", { caller: "u", payload: { name: "Juneau" } });
    expect(await projectTimelineEntry(e, { redactor: compileRedaction([]), hashCaller: null })).toEqual(e);
  });
});

describe("other projections", () => {
  it("projectState redacts", () => {
    expect(projectState({ name: "Jon", n: 1 }, human())).toEqual({ name: REDACTED, n: 1 });
  });

  it("projectOutboxRow redacts the JSON payload", () => {
    const row = {
      id: "1",
      service: "s",
      payload: JSON.stringify({ name: "Juneau" }),
      status: "pending",
      attempts: 0,
      createdAt: 1,
    };
    expect(JSON.parse(projectOutboxRow(row, human()).payload)).toEqual({ name: REDACTED });
  });

  it("projectConnections hashes callers for agents only", async () => {
    const conns = [
      { connectionId: "c1", caller: "Juneau", callerType: "user" as const, connectedAt: 1, role: "player" },
    ];
    expect((await projectConnections(conns, human()))[0]?.caller).toBe("Juneau");
    expect((await projectConnections(conns, agent()))[0]?.caller).toMatch(/^caller:/);
  });

  it("projectView redacts data and hashes the echoed caller for agents", async () => {
    const reply = {
      type: "studio.view" as const,
      role: "player",
      caller: "Juneau",
      callerRole: "player",
      data: { secretNote: "x" },
    };
    const out = await projectView(reply, agent());
    expect(out).toMatchObject({ caller: expect.stringMatching(/^caller:/), data: { secretNote: REDACTED } });
    const errorReply = { type: "studio.view" as const, role: "p", caller: null, error: "No view" };
    expect(await projectView(errorReply, agent())).toEqual(errorReply);
  });
});
