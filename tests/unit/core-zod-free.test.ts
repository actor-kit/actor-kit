/**
 * Run Set Jimmy feedback 15: view and role code imported by the browser narrows the persisted state of an
 * actor with states with `matches()` / `localOf()` (and types it with `PathsOf`, `MergedLocal`). They come
 * from @actor-kit/core, whose runtime import graph has no zod (type-only imports are erased), so a client
 * bundle that imports them stays zod-free. The graph is walked over the sources with oxc-parser.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { localOf, matches, mergeLocals } from "@actor-kit/core";
import * as worker from "@actor-kit/worker/testing";
import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** A relative specifier as a source file (`./x` → `./x.ts`, or `./x/index.ts`). */
function resolveRelative(from: string, specifier: string): string {
  const base = resolve(dirname(from), specifier);
  const found = [`${base}.ts`, `${base}.tsx`, resolve(base, "index.ts"), base].find(isFile);
  if (found === undefined) throw new Error(`cannot resolve ${specifier} from ${from}`);
  return found;
}

/** The specifiers a module imports at runtime: `import type` / `export type` statements are erased. */
function runtimeSpecifiers(path: string): string[] {
  const source = readFileSync(path, "utf8");
  const { module } = parseSync(path, source);
  const typeOnly = (start: number) => /^(import|export)\s+type\b/.test(source.slice(start));
  const imports = module.staticImports.filter((i) => !typeOnly(i.start)).map((i) => i.moduleRequest.value);
  const exports = module.staticExports
    .filter((e) => !typeOnly(e.start))
    .flatMap((e) => e.entries.flatMap((entry) => (entry.moduleRequest === null ? [] : [entry.moduleRequest.value])));
  const dynamic = module.dynamicImports.map((d) => source.slice(d.moduleRequest.start + 1, d.moduleRequest.end - 1));
  return [...imports, ...exports, ...dynamic];
}

/** The bare (package) specifiers reachable at runtime from an entry, following relative imports. */
function packagesImported(entry: string): string[] {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
    if (seen.has(path)) continue;
    seen.add(path);
    for (const specifier of runtimeSpecifiers(path)) {
      if (specifier.startsWith(".")) queue.push(resolveRelative(path, specifier));
      else packages.add(specifier);
    }
  }
  return [...packages].sort();
}

const isZod = (specifier: string) => specifier === "zod" || specifier.startsWith("zod/");

describe("@actor-kit/core is zod-free at runtime (Run Set Jimmy feedback 15)", () => {
  it("its entry imports no package at runtime, zod included", () => {
    expect(packagesImported(resolve(root, "packages/core/src/index.ts"))).toEqual([]);
  });

  it("the walk does find zod where it is imported (the worker's runtime)", () => {
    const imported = packagesImported(resolve(root, "packages/worker/src/index.ts"));
    expect(imported.filter(isZod)).toEqual(["zod"]);
    expect(imported).toContain("@actor-kit/core");
  });

  it("exports matches, localOf and mergeLocals, the same functions the worker exports", () => {
    const state = { phase: ["playing", "window"] as const, locals: [{ round: 1 }, { buys: ["ann"] }] as const };
    expect(matches(state, "playing")).toBe(true);
    expect(matches(state, ["playing", "acting"])).toBe(false);
    expect(localOf(state)).toEqual({ round: 1, buys: ["ann"] });
    expect(mergeLocals([null, { a: 1 }])).toEqual({ a: 1 });
    expect(worker.matches).toBe(matches);
    expect(worker.localOf).toBe(localOf);
  });
});
