/**
 * ADR-019 A, types: in a tree of states, `ctx.local` at each level is the merge (intersection) of its
 * local and its ancestors', `ctx.phase` is a leaf path under the handler's level, `goto` checks the
 * path and the target's input, `enter` / `exit` are typed per level, and contract-level types (typed
 * client `send`, testActor/simulate snapshots, views through `matches` / `localOf`) see the whole tree.
 * Checked by `pnpm typecheck:types`; each @ts-expect-error must be an error.
 */
import type { ContractMessages } from "@actor-kit/core";
import { testActor } from "@actor-kit/test";
import {
  type LeafPathsOf,
  localOf,
  type MergedLocal,
  matches,
  type PathsOf,
  type PhasedStateOf,
  type PhaseHelpers,
  setup,
} from "@actor-kit/worker/testing";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { type Deep, Rounds, rounds, type Shared } from "../integration/src/rounds";

type Decls = NonNullable<typeof rounds.states>;
type Snapshot = PhasedStateOf<typeof rounds, Shared>;

describe("paths", () => {
  it("lists every declared path, and the leaves the persisted phase can be", () => {
    expectTypeOf<PathsOf<Decls>>().toEqualTypeOf<
      | readonly ["lobby"]
      | readonly ["playing"]
      | readonly ["playing", "window"]
      | readonly ["playing", "acting"]
      | readonly ["over"]
    >();
    expectTypeOf<LeafPathsOf<Decls>>().toEqualTypeOf<
      readonly ["lobby"] | readonly ["playing", "window"] | readonly ["playing", "acting"] | readonly ["over"]
    >();
    expect(Rounds.name).toBe("rounds");
  });

  it("merges locals along a path (intersection), null when none", () => {
    expectTypeOf<MergedLocal<Decls, readonly ["playing", "window"]>>().toEqualTypeOf<
      { round: number } & { buys: string[] }
    >();
    expectTypeOf<MergedLocal<Decls, readonly ["playing"]>>().toEqualTypeOf<{ round: number }>();
    expectTypeOf<MergedLocal<Decls, readonly ["lobby"]>>().toEqualTypeOf<null>();
  });
});

describe("handlers", () => {
  const window = rounds.in(["playing", "window"]);
  const playing = rounds.in("playing");
  const lobby = rounds.in("lobby");

  it("see the merged local and the leaf paths under their level", () => {
    window.message(z.object({}), (s: Shared, _p, ctx) => {
      expectTypeOf(ctx.local).toEqualTypeOf<{ round: number } & { buys: string[] }>();
      expectTypeOf(ctx.phase).toEqualTypeOf<readonly ["playing", "window"]>();
      // @ts-expect-error not a field of any level's local
      void ctx.local.actor;
      return s;
    });
    playing.message(z.object({}), (s: Shared, _p, ctx) => {
      expectTypeOf(ctx.local).toEqualTypeOf<{ round: number }>();
      expectTypeOf(ctx.phase).toEqualTypeOf<readonly ["playing", "window"] | readonly ["playing", "acting"]>();
      return s;
    });
    expect(window).toBeDefined();
  });

  it("goto checks the path and the target's input", () => {
    lobby.message(z.object({}), (s: Shared, _p, ctx) => {
      ctx.goto(["playing", "acting"], s, { actor: "a" });
      ctx.goto("playing", s, { round: 1 });
      ctx.goto(["playing", "window"], s);
      ctx.goto("over", s);
      // @ts-expect-error not a declared path
      ctx.goto(["playing", "nope"], s);
      // @ts-expect-error acting needs its input
      ctx.goto(["playing", "acting"], s);
      // @ts-expect-error wrong input
      ctx.goto(["playing", "acting"], s, { actor: 1 });
      // @ts-expect-error window is a child of playing, not a top-level state
      ctx.goto("window", s);
      return s;
    });
    expect(lobby).toBeDefined();
  });

  it("stay takes the merged local of the handler's level", () => {
    window.message(z.object({}), (s: Shared, _p, ctx) => {
      ctx.stay(s, { round: 1, buys: [] });
      // @ts-expect-error the merged local needs the parent's round too
      ctx.stay(s, { buys: [] });
      return ctx.stay(s);
    });
    lobby.message(z.object({}), (s: Shared, _p, ctx) => {
      // @ts-expect-error lobby has no local to give
      ctx.stay(s, { round: 1 });
      return s;
    });
    expect(window).toBeDefined();
  });

  it("enter sees the levels above, returns its own local or stay(shared, local); exit returns shared", () => {
    window.state({
      enter: (s: Shared, input, ctx) => {
        expectTypeOf(input).toEqualTypeOf<undefined>();
        expectTypeOf(ctx.local).toEqualTypeOf<{ round: number }>();
        expectTypeOf(ctx.phase).toEqualTypeOf<readonly ["playing", "window"]>();
        return ctx.stay(s, { buys: [] });
      },
      exit: (s: Shared, ctx) => {
        expectTypeOf(ctx.local).toEqualTypeOf<{ round: number } & { buys: string[] }>();
        return s;
      },
    });
    // @ts-expect-error enter returns the level's own local (window's), not the parent's
    window.state({ enter: () => ({ round: 1 }) });
    // @ts-expect-error exit returns the next shared state
    window.state({ exit: (_s: Shared) => 1 });
    expect(window).toBeDefined();
  });

  it("a parent names its initial child and defines its children; a leaf has neither", () => {
    // @ts-expect-error playing has child states: it needs initial and states
    playing.state({});
    // @ts-expect-error initial must be one of its children
    playing.state({ initial: "nope", states: { window: {}, acting: {} } });
    // @ts-expect-error a leaf has no child states
    lobby.state({ initial: "x", states: {} });
    expect(playing).toBeDefined();
  });

  it("PhaseHelpers types a helper shared by two states (Run Set Jimmy feedback 10)", () => {
    type AtLeastRound = PhaseHelpers<Decls, { Bought: { by: string; round: number } }, readonly ["playing", "window"]>;
    const shared = (helpers: AtLeastRound) =>
      helpers.message(z.object({}), (s: Shared, _p, ctx) => ctx.stay(s, { ...ctx.local, round: ctx.local.round + 1 }));
    expect(shared(window).schema).toBeDefined();
  });
});

describe("contract-level types", () => {
  it("ContractMessages includes the messages of nested states", () => {
    type M = ContractMessages<typeof Rounds>["type"];
    expectTypeOf<M>().toEqualTypeOf<
      | "PING"
      | "START"
      | "JUMP"
      | "NEXT_ROUND"
      | "END"
      | "BUMP"
      | "PEEK"
      | "TICK_AGAIN"
      | "LOST"
      | "BUY"
      | "ACT"
      | "REOPEN"
      | "STAY"
      | "PLAN"
      | "RETICK"
      | "DONE"
      | "BACK"
      | "AGAIN"
    >();
    expectTypeOf<ContractMessages<typeof Deep>["type"]>().toEqualTypeOf<"NOTE" | "MOVE" | "WAIT">();
  });

  it("testActor's state is the union over leaf paths, with a local per level", () => {
    const t = testActor(Rounds);
    const s0 = t.init({});
    expectTypeOf(s0.phase).toEqualTypeOf<
      readonly ["lobby"] | readonly ["playing", "window"] | readonly ["playing", "acting"] | readonly ["over"]
    >();
    if (matches(s0, ["playing", "acting"])) {
      expectTypeOf(s0.locals).toEqualTypeOf<[{ round: number }, { actor: string }]>();
    }
    expect(s0.phase).toEqual(["lobby"]);
  });

  it("views narrow with matches() and read the merged local with localOf()", () => {
    const view = (st: Snapshot) => {
      if (matches(st, ["playing", "window"])) return localOf(st).buys.length + localOf(st).round;
      if (matches(st, "playing")) {
        // The window returned above, so only acting is left.
        expectTypeOf(st.phase).toEqualTypeOf<readonly ["playing", "acting"]>();
        return localOf(st).round + localOf(st).actor.length;
      }
      expectTypeOf(localOf(st)).toEqualTypeOf<null>();
      // @ts-expect-error not a declared path
      matches(st, "nope");
      return 0;
    };
    expect(view).toBeDefined();
  });

  it("deep trees type their paths", () => {
    const deep = setup({
      states: { a: { states: { b: { states: { c: { local: z.object({ x: z.number() }) } } } } } },
    });
    const c = deep.in(["a", "b", "c"]);
    c.message(z.object({}), (s: number, _p, ctx) => {
      expectTypeOf(ctx.local).toEqualTypeOf<{ x: number }>();
      expectTypeOf(ctx.phase).toEqualTypeOf<readonly ["a", "b", "c"]>();
      return s;
    });
    expect(c).toBeDefined();
  });
});
