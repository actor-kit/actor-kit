/** Where an actor finds the StudioRegistry: ctx.exports first, then env.STUDIO_REGISTRY. */
import { findStudioRegistry, looksLikeDONamespace } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";

const namespace = () => ({ idFromName: () => ({}), get: () => ({}) });

describe("findStudioRegistry", () => {
  it("prefers the export marked as the registry", () => {
    const registry = { ...namespace(), __actorKitStudioRegistry: true };
    const exports = { Counter: namespace(), StudioRegistry: registry };
    expect(findStudioRegistry(exports, { STUDIO_REGISTRY: namespace() })).toBe(registry);
  });

  it("falls back to the STUDIO_REGISTRY binding when no export is marked", () => {
    const binding = namespace();
    expect(findStudioRegistry({ Counter: namespace(), n: null, s: "x" }, { STUDIO_REGISTRY: binding })).toBe(binding);
    expect(findStudioRegistry(undefined, { STUDIO_REGISTRY: binding })).toBe(binding);
  });

  it("is undefined without a registry, or when the binding is not a namespace", () => {
    expect(findStudioRegistry({}, {})).toBeUndefined();
    expect(findStudioRegistry(undefined, { STUDIO_REGISTRY: { get: () => ({}) } })).toBeUndefined();
  });
});

describe("looksLikeDONamespace", () => {
  it.each([
    [namespace(), true],
    [{ idFromName: 1, get: 2 }, true],
    [{ idFromName: () => ({}) }, false],
    [{ get: () => ({}) }, false],
    [null, false],
    ["ns", false],
  ])("%j → %s", (value, expected) => {
    expect(looksLikeDONamespace(value)).toBe(expected);
  });
});
