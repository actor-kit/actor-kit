import { describe, expect, it } from "vitest";
import { changedPaths, timelineShape } from "../../packages/studio-cli/src/shape";

function entry(id: number, causeType: string, cause: Record<string, unknown>, state: unknown, checksum = `c${id}`) {
  return {
    id,
    causeType,
    causeData: JSON.stringify(cause),
    stateSnapshot: JSON.stringify(state),
    checksum,
    createdAt: id * 10,
  };
}

describe("changedPaths", () => {
  it("lists leaf paths that differ, with array indices generalised to *", () => {
    expect(
      changedPaths(
        { a: 1, players: [{ score: 1 }, { score: 2 }], same: { x: 1 } },
        { a: 2, players: [{ score: 1 }, { score: 3 }], same: { x: 1 } },
      ),
    ).toEqual(["a", "players.*.score"]);
  });

  it("reports added and removed keys", () => {
    expect(changedPaths({ a: 1 }, { b: 1 })).toEqual(["a", "b"]);
  });

  it("reports a type change at the node, not below it", () => {
    expect(changedPaths({ a: { b: 1 } }, { a: [1] })).toEqual(["a"]);
  });

  it("reports the root for a primitive change", () => {
    expect(changedPaths(1, 2)).toEqual(["$"]);
    expect(changedPaths({ a: 1 }, { a: 1 })).toEqual([]);
  });

  it("dedupes generalised paths", () => {
    expect(changedPaths({ p: [1, 2, 3] }, { p: [4, 5, 6] })).toEqual(["p.*"]);
  });
});

describe("timelineShape", () => {
  const secret = "Juneau";
  const entries = [
    entry(
      3,
      "message",
      { messageType: "JOIN", caller: "caller:abc", callerType: "user", role: "kid", payload: { name: secret, age: 5 } },
      { players: [{ name: "[redacted]" }], round: 2 },
    ),
    entry(
      2,
      "service.onError",
      { service: "SAVE", input: { name: secret }, error: `could not save ${secret}` },
      { players: [], round: 2 },
    ),
    entry(1, "init", {}, { players: [], round: 1 }),
  ];

  it("keeps cause types, message/service names, payload keys, changed paths and checksums, oldest first", () => {
    expect(timelineShape(entries)).toEqual([
      { id: 1, at: 10, causeType: "init", checksum: "c1", changedPaths: [] },
      {
        id: 2,
        at: 20,
        causeType: "service.onError",
        service: "SAVE",
        inputKeys: ["name"],
        checksum: "c2",
        changedPaths: ["round"],
      },
      {
        id: 3,
        at: 30,
        causeType: "message",
        messageType: "JOIN",
        role: "kid",
        callerType: "user",
        payloadKeys: ["age", "name"],
        checksum: "c3",
        changedPaths: ["players.*"],
      },
    ]);
  });

  it("never contains a value, an error message or a caller", () => {
    const text = JSON.stringify(timelineShape(entries));
    expect(text).not.toContain(secret);
    expect(text).not.toContain("could not save");
    expect(text).not.toContain("caller:abc");
    expect(text).not.toContain('"5"');
  });

  it("survives unparsable cause data and snapshots", () => {
    const bad = { id: 1, causeType: "message", causeData: "{", stateSnapshot: "nope", checksum: "c", createdAt: 1 };
    expect(timelineShape([bad])).toEqual([{ id: 1, at: 1, causeType: "message", checksum: "c", changedPaths: [] }]);
  });
});

describe("timelineShape: exact output (mutation hardening)", () => {
  it("omits absent optional fields entirely", () => {
    expect(timelineShape([entry(1, "init", {}, {})])).toStrictEqual([
      { id: 1, at: 10, causeType: "init", checksum: "c1", changedPaths: [] },
    ]);
  });

  it("includes each optional field only when present", () => {
    const e = entry(1, "service.onDone", { service: "S", input: { b: 1, a: 2 } }, {});
    expect(timelineShape([e])).toStrictEqual([
      {
        id: 1,
        at: 10,
        causeType: "service.onDone",
        service: "S",
        inputKeys: ["a", "b"],
        checksum: "c1",
        changedPaths: [],
      },
    ]);
  });

  it("gives no changed paths when either neighbouring snapshot is unparsable", () => {
    const older = { ...entry(1, "init", {}, {}), stateSnapshot: "nope" };
    const newer = entry(2, "message", {}, { a: 1 });
    expect(timelineShape([older, newer])[1]?.changedPaths).toEqual([]);
    const brokenNewer = { ...entry(2, "message", {}, {}), stateSnapshot: "nope" };
    expect(timelineShape([entry(1, "init", {}, { a: 1 }), brokenNewer])[1]?.changedPaths).toEqual([]);
  });

  it("does not treat arrays as records for payload keys", () => {
    expect(timelineShape([entry(1, "message", { payload: [1, 2] }, {})])[0]).not.toHaveProperty("payloadKeys");
  });

  it("sorts changed paths", () => {
    expect(changedPaths({ z: 1, a: 1, m: 1 }, { z: 2, a: 2, m: 2 })).toEqual(["a", "m", "z"]);
  });

  it("compares an array with a non-array as a whole", () => {
    expect(changedPaths({ a: [1] }, { a: null })).toEqual(["a"]);
  });
});

it("omits payload keys for a primitive payload", () => {
  const e = {
    id: 1,
    causeType: "message",
    causeData: JSON.stringify({ payload: 5 }),
    stateSnapshot: "{}",
    checksum: "c",
    createdAt: 1,
  };
  expect(timelineShape([e])[0]).not.toHaveProperty("payloadKeys");
});

it("omits payload keys for a null payload", () => {
  const e = {
    id: 1,
    causeType: "message",
    causeData: JSON.stringify({ payload: null }),
    stateSnapshot: "{}",
    checksum: "c",
    createdAt: 1,
  };
  expect(timelineShape([e])[0]).not.toHaveProperty("payloadKeys");
});
