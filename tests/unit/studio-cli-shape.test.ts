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
