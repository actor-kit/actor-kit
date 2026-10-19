/**
 * ADR-024: what a game's pages pay for actor-kit. @actor-kit/client, @actor-kit/react and
 * @actor-kit/core bundle for the browser with no dependency at all (no validator: a game brings its
 * own, as light as it likes), within a gzipped budget. Raise the budget only with a reason in the
 * commit; `node scripts/browser-bundle.mts` lists what is in the bundle.
 */

import { describe, expect, it } from "vitest";
import { browserBundle } from "../../scripts/browser-bundle.mts";

/** 13,199 bytes gzipped when set (2026-10-18), plus room for small changes. */
const GZIP_BUDGET_BYTES = 14_500;

describe("the actor-kit browser bundle (client + react + core)", () => {
  it(`stays within ${GZIP_BUDGET_BYTES} bytes gzipped`, async () => {
    const bundle = await browserBundle();
    expect(bundle.gzipBytes).toBeLessThanOrEqual(GZIP_BUDGET_BYTES);
  });

  it("holds no dependency: no zod or other validator reaches a game's pages through actor-kit", async () => {
    const bundle = await browserBundle();
    expect(bundle.inputs.filter((input) => input.path.includes("node_modules")).map((input) => input.path)).toEqual([]);
  });
});
