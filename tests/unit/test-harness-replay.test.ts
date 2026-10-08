import { replayJournal } from "@actor-kit/test";
import { checksumState, type Journal, type JournalEvent } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";

type State = { n: number };

const initEvent = {
  causeType: "init" as const,
  name: null,
  payload: { n: 1 },
  caller: "svc",
  callerType: "service" as const,
  role: null,
  facts: {},
};

const incEvent = {
  causeType: "message" as const,
  name: "INC",
  payload: {},
  caller: "u",
  callerType: "user" as const,
  role: "player",
  facts: {},
};

function journalOf(
  steps: Array<{ event: Omit<JournalEvent, "seq" | "stateChecksum" | "codeVersion" | "createdAt">; after: State }>,
): Journal {
  return {
    events: steps.map((s, i) => ({
      ...s.event,
      seq: i + 1,
      codeVersion: 1,
      createdAt: 0,
      stateChecksum: checksumState({}, s.after),
    })),
    checkpoints: [],
  };
}

const init = (input: unknown): State => {
  const n = typeof input === "object" && input !== null && "n" in input && typeof input.n === "number" ? input.n : 0;
  return { n };
};
const inc = { handler: (s: State): State => ({ n: s.n + 1 }) };
const initOnly = journalOf([{ event: initEvent, after: { n: 1 } }]);
const initAndInc = journalOf([
  { event: initEvent, after: { n: 1 } },
  { event: incEvent, after: { n: 2 } },
]);

describe("replayJournal(): contract checks", () => {
  it.each([
    ["a null def", null],
    ["a def without init", {}],
    ["a def whose init is not a function", { init: 1 }],
    ["a primitive def", "def"],
  ])("rejects %s, naming the contract", async (_label, def) => {
    await expect(replayJournal({ name: "broken", def }, initOnly)).rejects.toThrow(
      'replayJournal: "broken" is not an actor contract',
    );
  });
});

describe("replayJournal(): message layouts", () => {
  it("replays a contract without messages", async () => {
    expect(await replayJournal({ name: "bare", def: { init } }, initOnly)).toEqual({ state: { n: 1 }, replayed: 1 });
  });

  it("replays a contract whose messages are null", async () => {
    expect(await replayJournal({ name: "bare", def: { init, messages: null } }, initOnly)).toEqual({
      state: { n: 1 },
      replayed: 1,
    });
  });

  it("applies flat messages to every role", async () => {
    const def = { init, roles: { player: () => true }, messages: { INC: inc } };
    expect(await replayJournal({ name: "flat", def }, initAndInc)).toEqual({ state: { n: 2 }, replayed: 2 });
  });

  it("uses role-nested messages as they are", async () => {
    const def = { init, roles: { player: () => true }, messages: { player: { INC: inc } } };
    expect(await replayJournal({ name: "nested", def }, initAndInc)).toEqual({ state: { n: 2 }, replayed: 2 });
  });

  it("treats a messages record with a null slot as role-nested, not flat", async () => {
    const def = { init, roles: { player: () => true }, messages: { empty: null, player: { INC: inc } } };
    expect(await replayJournal({ name: "nested", def }, initAndInc)).toEqual({ state: { n: 2 }, replayed: 2 });
  });

  it("does not treat a slot whose handler is not a function as flat", async () => {
    const def = { init, roles: { player: () => true }, messages: { other: { handler: 1 }, player: { INC: inc } } };
    expect(await replayJournal({ name: "nested", def }, initAndInc)).toEqual({ state: { n: 2 }, replayed: 2 });
  });

  it("flat messages without roles reach no role", async () => {
    const def = { init, messages: { INC: inc } };
    await expect(replayJournal({ name: "flat", def }, initAndInc)).rejects.toThrow(/message "INC" for role "player"/);
  });
});
