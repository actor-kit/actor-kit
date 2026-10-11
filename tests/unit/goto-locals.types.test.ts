/**
 * ADR-019 A rows 21-23, types (Run Set Jimmy feedback 14): goto's `{ locals }` names the levels the
 * handler's own path keeps (dotted), each typed by its level's local; `reenter` keeps the levels above
 * the handler's; a child's `enter` may give its ancestors' keys to `stay`. Checked by
 * `pnpm typecheck:types`; each @ts-expect-error must be an error.
 */
import { type KeptLocals, setup } from "@actor-kit/worker/testing";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { roundLocals, type Shared } from "../integration/src/round-locals";

type Decls = NonNullable<typeof roundLocals.states>;
type Round = { round: number; moves: number; windows: number };

describe("goto's locals", () => {
  const window = roundLocals.in(["playing", "window"]);
  const playing = roundLocals.in("playing");
  const lobby = roundLocals.in("lobby");

  it("KeptLocals: the kept levels with a local, by dotted path", () => {
    expectTypeOf<KeptLocals<Decls, readonly ["playing", "window"], readonly ["playing", "acting"]>>().toEqualTypeOf<{
      playing?: Round;
    }>();
    // A goto to another branch, or to the handler's own level from its parent's path, keeps nothing.
    expectTypeOf<KeptLocals<Decls, readonly ["playing", "window"], readonly ["lobby"]>>().toEqualTypeOf<
      Record<never, never>
    >();
    expectTypeOf<KeptLocals<Decls, readonly ["playing"], readonly ["playing"]>>().toEqualTypeOf<Record<never, never>>();
    expect(window).toBeDefined();
  });

  it("typed per level, after the input (undefined when the target declares none)", () => {
    window.message(z.object({}), (s: Shared, _p, ctx) => {
      ctx.goto(["playing", "acting"], s, { actor: "a" }, { locals: { playing: { round: 1, moves: 0, windows: 0 } } });
      ctx.goto(["playing", "window"], s, undefined, { locals: { playing: { ...ctx.local, moves: 1 } } });
      ctx.goto(["playing", "acting"], s, { actor: "a" }, {});
      // @ts-expect-error the window is not kept by a goto to acting
      ctx.goto(["playing", "acting"], s, { actor: "a" }, { locals: { "playing.window": { buys: [] } } });
      // @ts-expect-error playing's local is { round, moves, windows }
      ctx.goto(["playing", "acting"], s, { actor: "a" }, { locals: { playing: { round: "1" } } });
      // @ts-expect-error a goto to another branch keeps no level
      ctx.goto("lobby", s, undefined, { locals: { playing: { round: 1, moves: 0, windows: 0 } } });
      // @ts-expect-error acting still needs its input
      ctx.goto(["playing", "acting"], s, undefined, {});
      return s;
    });
    playing.message(z.object({}), (s: Shared, _p, ctx) =>
      ctx.goto(["playing", "quiet"], s, undefined, { locals: { playing: { ...ctx.local, moves: 9 } } }),
    );
    lobby.message(z.object({}), (s: Shared, _p, ctx) => {
      // @ts-expect-error lobby keeps nothing
      ctx.goto(["playing", "window"], s, undefined, { locals: { playing: { round: 1, moves: 0, windows: 0 } } });
      return ctx.goto("playing", s, { round: 1 });
    });
    expect(window).toBeDefined();
  });

  it("reenter keeps the levels above the handler's", () => {
    roundLocals
      .in(["playing", "acting"])
      .message(z.object({}), (s: Shared, _p, ctx) =>
        ctx.reenter(s, { actor: "a" }, { locals: { playing: { round: 2, moves: 0, windows: 0 } } }),
      );
    playing.message(z.object({}), (s: Shared, _p, ctx) => {
      // @ts-expect-error reentering playing keeps nothing above it
      ctx.reenter(s, { round: 2 }, { locals: { playing: { round: 2, moves: 0, windows: 0 } } });
      return s;
    });
    expect(playing).toBeDefined();
  });
});

describe("enter's stay with the levels above", () => {
  it("takes its own local, plus any keys of the levels above", () => {
    const window = roundLocals.in(["playing", "window"]);
    window.state({
      enter: (s: Shared, _input, ctx) => {
        ctx.stay(s, { buys: [] });
        ctx.stay(s, { ...ctx.local, windows: 1, buys: [] });
        // @ts-expect-error windows is playing's number
        ctx.stay(s, { windows: "1", buys: [] });
        // @ts-expect-error the window's own local is still required
        return ctx.stay(s, { windows: 1 });
      },
    });
    const kit = setup({ states: { p: { local: z.object({ n: z.number() }), states: { c: {} } } } });
    kit.in(["p", "c"]).state({
      // A child without a local may update the levels above, or give nothing.
      enter: (s: number, _input, ctx) => (s > 0 ? ctx.stay(s, { n: ctx.local.n + 1 }) : ctx.stay(s)),
    });
    expect(window).toBeDefined();
  });
});
