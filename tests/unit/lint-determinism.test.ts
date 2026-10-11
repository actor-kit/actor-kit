/**
 * ADR-018 E: the Biome GritQL plugin shipped in @actor-kit/worker (biome/no-nondeterminism.grit) flags
 * Date.now(), new Date(), Math.random() and crypto.randomUUID() inside handler bodies, and nowhere else.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../..");
const BIOME = join(ROOT, "node_modules/.bin/biome");
const PLUGIN = join(ROOT, "packages/worker/biome/no-nondeterminism.grit");

/** Lint `source` with only the plugin enabled; returns the 1-based lines it flagged. */
function flaggedLines(source: string): number[] {
  const dir = mkdtempSync(join(tmpdir(), "ak-lint-"));
  writeFileSync(
    join(dir, "biome.json"),
    JSON.stringify({ plugins: [PLUGIN], linter: { rules: { recommended: false } } }),
  );
  writeFileSync(join(dir, "actor.ts"), source);
  let output = "";
  try {
    output = execFileSync(BIOME, ["lint", "--max-diagnostics=100", "actor.ts"], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    output = String(Reflect.get(Object(error), "stdout") ?? "") + String(Reflect.get(Object(error), "stderr") ?? "");
  }
  return [...output.matchAll(/actor\.ts:(\d+):\d+ plugin/g)].map((m) => Number(m[1]));
}

describe("no-nondeterminism Biome plugin", () => {
  it("flags the clock and randomness in message, timer and callback bodies", () => {
    const source = [
      "const a = kit.message(s, (x: number) => x + Date.now());",
      "const b = message(s, { guard: () => Math.random() > 0.5, handler: (x: number) => x });",
      "const c = round.timer(s, (x: number) => { const d = new Date(); return x; });",
      "const d = timer(s, () => crypto.randomUUID());",
      "const e = { onDone: (x: number) => x + Date.now(), onError: () => Math.random() };",
      "const f = { connect: () => new Date(), disconnect: () => Date.now(), enter: () => Math.random() };",
      "const g = { onUpdate: () => Date.now(), onUnlink: () => Date.now(), init: () => crypto.randomUUID() };",
    ].join("\n");
    expect(flaggedLines(source)).toEqual([1, 2, 3, 4, 5, 5, 6, 6, 6, 7, 7, 7]);
  });

  it("leaves service fn, ctx.now() and code outside handlers alone", () => {
    const source = [
      "const svc = kit.service({ fn: async () => Date.now() });",
      "const ok = kit.message(s, (x: number, _p: unknown, ctx: { now(): number }) => x + ctx.now());",
      "const top = Date.now() + Math.random();",
      "function helper() { return crypto.randomUUID(); }",
      "const later = new Date(0);",
    ].join("\n");
    expect(flaggedLines(source)).toEqual([]);
  });
});
