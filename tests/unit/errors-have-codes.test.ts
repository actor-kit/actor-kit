/**
 * ADR-018 C: every error the library throws carries a stable code and a docs URL. Library sources may
 * not construct a plain Error (ActorKitError, or a subclass of it, instead).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../..");
const SOURCES = ["core", "worker", "client", "react", "test", "storybook", "studio", "studio-cli", "projection"].map(
  (p) => join(ROOT, "packages", p, "src"),
);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "type-tests" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Stryker's instrumentation adds this guard to every file it mutates; it is not library code. */
const STRYKER_HIT_COUNT_GUARD = /new Error\('Stryker: Hit count limit reached/;

/** 1-based line numbers that construct a plain Error, TypeError or RangeError. */
function plainErrorLines(source: string): number[] {
  return source
    .split("\n")
    .flatMap((line, i) =>
      /new (Type|Range)?Error\(/.test(line) && !STRYKER_HIT_COUNT_GUARD.test(line) ? [i + 1] : [],
    );
}

describe("plain error scan", () => {
  it("flags a plain Error, TypeError or RangeError in library code", () => {
    expect(plainErrorLines('const a = 1;\nthrow new Error("x");\nthrow new RangeError("y");')).toEqual([2, 3]);
  });

  it("ignores the hit-count guard that Stryker's instrumentation adds to every mutated file", () => {
    const instrumented =
      "function stryNS_9fa48() {\n        throw new Error('Stryker: Hit count limit reached (' + ns.hitCount + ')');\n}";
    expect(plainErrorLines(instrumented)).toEqual([]);
  });
});

describe("library errors have codes", () => {
  it("no library source constructs a plain Error, TypeError or RangeError", () => {
    const offenders = SOURCES.flatMap(sourceFiles).flatMap((file) =>
      plainErrorLines(readFileSync(file, "utf8")).map((line) => `${file.slice(ROOT.length)}:${line}`),
    );
    expect(offenders).toEqual([]);
  });

  it("the CLI's errors carry a code and a docs URL too", async () => {
    const { StudioClientError } = await import("../../packages/studio-cli/src/client");
    const error = new StudioClientError("404: nope", 404);
    expect(error).toMatchObject({
      code: "studio_request_failed",
      docs: "https://actorkit.dev/errors/studio_request_failed/",
    });
  });
});
