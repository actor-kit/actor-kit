/**
 * ADR-018 H: docs ship with the code. Generated files are up to date, every error code has its page
 * (so every `docs` URL resolves), every package publishes docs/, and llms.txt indexes everything.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ERROR_CODE_LIST } from "@actor-kit/core";
import { describe, expect, it } from "vitest";
import { absoluteLinks, generateDocs, PACKAGE_DOCS, parsePage, SECTIONS, SITE } from "../../scripts/docs.mts";

const ROOT = join(__dirname, "../..");
const PACKAGES = ["core", "worker", "client", "react", "test", "storybook", "studio", "studio-cli"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("generated docs", () => {
  it("are up to date (run pnpm docs:gen)", () => {
    const stale = [...generateDocs(ROOT)].filter(([path, content]) => {
      const file = join(ROOT, path);
      return !existsSync(file) || readFileSync(file, "utf8") !== content;
    });
    expect(stale.map(([path]) => path)).toEqual([]);
  });

  it("every error code has a page on the site", () => {
    const missing = ERROR_CODE_LIST.filter(
      (code) => !existsSync(join(ROOT, `website/src/content/docs/errors/${code}.md`)),
    );
    expect(missing).toEqual([]);
  });

  it("every errors URL written in the packages' sources resolves to a page", () => {
    const urls = PACKAGES.flatMap((pkg) => sourceFiles(join(ROOT, "packages", pkg, "src"))).flatMap((file) => [
      ...readFileSync(file, "utf8").matchAll(/actorkit\.dev\/errors\/([a-z_]+)\//g),
    ]);
    expect(urls.length).toBeGreaterThan(0);
    const broken = urls
      .map((m) => m[1])
      .filter((code) => !existsSync(join(ROOT, `website/src/content/docs/errors/${code}.md`)));
    expect(broken).toEqual([]);
  });

  it("every package publishes its docs/ with an index", () => {
    for (const pkg of PACKAGES) {
      const files: unknown = JSON.parse(readFileSync(join(ROOT, "packages", pkg, "package.json"), "utf8")).files;
      expect(Array.isArray(files) && files.includes("docs"), pkg).toBe(true);
      expect(existsSync(join(ROOT, "packages", pkg, "docs/README.md")), pkg).toBe(true);
      expect(Object.keys(PACKAGE_DOCS)).toContain(pkg);
      expect(readFileSync(join(ROOT, "packages", pkg, "README.md"), "utf8")).toContain("llms.txt");
    }
  });

  it("llms.txt links every page and every error code; llms-full.txt holds every page", () => {
    const index = readFileSync(join(ROOT, "llms.txt"), "utf8");
    const full = readFileSync(join(ROOT, "llms-full.txt"), "utf8");
    for (const slug of SECTIONS.flatMap((s) => s.slugs)) {
      expect(index).toContain(`${SITE}/${slug}/`);
      expect(full).toContain(`Source: ${SITE}/${slug}/`);
    }
    for (const code of ERROR_CODE_LIST) expect(index).toContain(`${SITE}/errors/${code}/`);
    expect(readFileSync(join(ROOT, "website/public/llms.txt"), "utf8")).toBe(index);
  });

  it("parses frontmatter and makes site links absolute", () => {
    expect(parsePage("x", '---\ntitle: "A \\"b\\""\ndescription: D\n---\nBody')).toEqual({
      slug: "x",
      title: 'A "b"',
      description: "D",
      body: "Body",
    });
    expect(absoluteLinks("[a](/concepts/states/) [b](https://x.dev/) [c](//cdn)")).toBe(
      `[a](${SITE}/concepts/states/) [b](https://x.dev/) [c](//cdn)`,
    );
    expect(() => parsePage("y", "no frontmatter")).toThrow("y: no frontmatter");
  });
});
