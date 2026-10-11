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

describe("library errors have codes", () => {
  it("no library source constructs a plain Error, TypeError or RangeError", () => {
    const offenders = SOURCES.flatMap(sourceFiles).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, i) => (/new (Type|Range)?Error\(/.test(line) ? [`${file.slice(ROOT.length)}:${i + 1}`] : [])),
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
