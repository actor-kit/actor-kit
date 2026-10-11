/**
 * Run Set Jimmy feedback 15, types: browser view code types the persisted state from @actor-kit/core alone
 * (zod-free at runtime): `PathsOf`, `MergedLocal`, `matches()` and `localOf()` are the worker's.
 */
import type { MergedLocal, PathsOf, PhasedState } from "@actor-kit/core";
import { localOf, matches } from "@actor-kit/core";
import type * as Worker from "@actor-kit/worker";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { rounds, Shared } from "../integration/src/rounds";

type Decls = NonNullable<typeof rounds.states>;

describe("@actor-kit/core state-path types", () => {
  it("are the worker's", () => {
    expectTypeOf<PathsOf<Decls>>().toEqualTypeOf<Worker.PathsOf<Decls>>();
    expectTypeOf<MergedLocal<Decls, readonly ["playing", "window"]>>().toEqualTypeOf<
      { round: number } & { buys: string[] }
    >();
  });

  it("narrow a view's state with matches() and read the merged local with localOf()", () => {
    const view = (st: PhasedState<Decls, Shared>) =>
      matches(st, ["playing", "window"]) ? localOf(st).buys.length + localOf(st).round : 0;
    expect(view).toBeDefined();
  });
});
