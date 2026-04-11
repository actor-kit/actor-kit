import type { LinkedView } from "@actor-kit/core";
import { float32, schema, string, uint32, view } from "@actor-kit/core";
import { defineActor, message } from "@actor-kit/worker/testing";
import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";

// Define test contract with multiple views
const AdminView = schema({ count: uint32, revenue: float32, name: string });
const PlayerView = schema({ count: uint32, score: uint32 });
const SpectatorView = schema({ count: uint32 });

type GameState = { count: number; revenue: number; name: string; score: number };

const GameContract = defineActor("game", {
  input: z.object({}),
  init: (): GameState => ({ count: 0, revenue: 0, name: "", score: 0 }),
  roles: {
    admin: () => true,
    player: () => true,
    spectator: () => true,
  },
  messages: {
    INC: message(z.object({}), (state: GameState) => state),
  },
  views: {
    admin: view.shared(AdminView, (state: GameState) => ({
      count: state.count,
      revenue: state.revenue,
      name: state.name,
    })),
    player: view.shared(PlayerView, (state: GameState) => ({
      count: state.count,
      score: state.score,
    })),
    spectator: view.shared(SpectatorView, (state: GameState) => ({
      count: state.count,
    })),
  },
});

describe("LinkedView<T>", () => {
  it("produces a discriminated union with role field", () => {
    type GV = LinkedView<typeof GameContract>;

    // Should be a union of three variants
    expectTypeOf<GV>().toMatchTypeOf<{ role: string }>();
  });

  it("each variant has the correct fields", () => {
    type GV = LinkedView<typeof GameContract>;
    type AdminVariant = Extract<GV, { role: "admin" }>;
    type PlayerVariant = Extract<GV, { role: "player" }>;
    type SpectatorVariant = Extract<GV, { role: "spectator" }>;

    expectTypeOf<AdminVariant>().toHaveProperty("revenue");
    expectTypeOf<AdminVariant>().toHaveProperty("name");
    expectTypeOf<AdminVariant>().toHaveProperty("count");

    expectTypeOf<PlayerVariant>().toHaveProperty("score");
    expectTypeOf<PlayerVariant>().toHaveProperty("count");

    expectTypeOf<SpectatorVariant>().toHaveProperty("count");
  });

  it("common fields are accessible without narrowing", () => {
    type GV = LinkedView<typeof GameContract>;
    // count exists on all variants — should be accessible on the union
    expectTypeOf<GV>().toHaveProperty("count");
    expectTypeOf<GV>().toHaveProperty("role");
  });

  it("role-specific fields require narrowing", () => {
    type GV = LinkedView<typeof GameContract>;
    // revenue only on admin — not accessible on the union without narrowing
    // This should NOT have revenue at the union level
    type HasRevenue = GV extends { revenue: number } ? true : false;
    expectTypeOf<HasRevenue>().toEqualTypeOf<false>();
  });

  it("narrows correctly with role discriminant", () => {
    type GV = LinkedView<typeof GameContract>;

    const narrow = (view: GV) => {
      if (view.role === "admin") {
        expectTypeOf(view.revenue).toBeNumber();
        expectTypeOf(view.name).toBeString();
      }
      if (view.role === "player") {
        expectTypeOf(view.score).toBeNumber();
      }
    };

    // Use narrow to avoid unused variable
    void narrow;
  });
});
