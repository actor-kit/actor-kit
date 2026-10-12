/**
 * Run Set Jimmy feedback 17: re-vendored tarballs must differ in name, or pnpm's lockfile does not notice
 * a new build. The packages share one pre-release version (`0.3.0-next.N`), and `scripts/vendor.sh <dir>`
 * packs each one as `<name>-<version>-<short commit>.tgz`, with that version inside the tarball and the
 * internal `workspace:*` dependencies pinned to it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { tarballName, vendorManifest, vendorVersion } from "../../scripts/vendor.mts";

const root = resolve(import.meta.dirname, "../..");
/** Package directories, as scripts/vendor.mts finds them (stray files such as macOS .DS_Store are not packages). */
const packageDirs = readdirSync(resolve(root, "packages")).filter((dir) =>
  existsSync(resolve(root, "packages", dir, "package.json")),
);

function manifest(dir: string): { name: string; version: string } {
  const parsed: unknown = JSON.parse(readFileSync(resolve(root, "packages", dir, "package.json"), "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("name" in parsed) || !("version" in parsed)) {
    throw new Error(`packages/${dir}/package.json has no name or version`);
  }
  return { name: String(parsed.name), version: String(parsed.version) };
}

describe("package versions", () => {
  it("every package is at the 0.3.0 pre-release 0.3.0-next.0", () => {
    expect(packageDirs).toHaveLength(9);
    expect(new Set(packageDirs.map((dir) => manifest(dir).version))).toEqual(new Set(["0.3.0-next.0"]));
  });
});

describe("vendoring", () => {
  it("suffixes the version with the commit, marking a dirty tree", () => {
    expect(vendorVersion("0.3.0-next.0", "4181811", false)).toBe("0.3.0-next.0-4181811");
    expect(vendorVersion("0.3.0-next.0", "4181811", true)).toBe("0.3.0-next.0-4181811-dirty");
  });

  it("names a tarball the way npm and pnpm pack do", () => {
    expect(tarballName("@actor-kit/core", "0.3.0-next.0-4181811")).toBe("actor-kit-core-0.3.0-next.0-4181811.tgz");
    expect(tarballName("plain", "1.0.0")).toBe("plain-1.0.0.tgz");
  });

  it("rewrites the manifest: the vendored version, and workspace dependencies pinned to it", () => {
    const versions = new Map([
      ["@actor-kit/core", "0.3.0-next.0-abc1234"],
      ["@actor-kit/worker", "0.3.0-next.0-abc1234"],
    ]);
    expect(
      vendorManifest(
        {
          name: "@actor-kit/worker",
          version: "0.3.0-next.0",
          dependencies: { "@actor-kit/core": "workspace:*", zod: "^4.6.5" },
          peerDependencies: { jose: "^6.0.0" },
          devDependencies: { jose: "^6.2.12" },
          files: ["dist"],
        },
        versions,
      ),
    ).toEqual({
      name: "@actor-kit/worker",
      version: "0.3.0-next.0-abc1234",
      dependencies: { "@actor-kit/core": "0.3.0-next.0-abc1234", zod: "^4.6.5" },
      peerDependencies: { jose: "^6.0.0" },
      devDependencies: { jose: "^6.2.12" },
      files: ["dist"],
    });
  });

  it("refuses a workspace dependency that is not one of the vendored packages", () => {
    expect(() =>
      vendorManifest({ name: "a", version: "1.0.0", dependencies: { b: "workspace:*" } }, new Map([["a", "1.0.0-x"]])),
    ).toThrow("a depends on b (workspace:*), which is not one of the vendored packages");
  });

  it("packs every package into the directory (scripts/vendor.mts, run by vendor.sh after the build)", () => {
    const out = mkdtempSync(join(tmpdir(), "actor-kit-vendor-"));
    try {
      const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
      const printed = execFileSync("node", [resolve(root, "scripts/vendor.mts"), out], { cwd: root, encoding: "utf8" });
      const names = readdirSync(out).sort();
      expect(names).toHaveLength(9);
      for (const name of names)
        expect(name).toMatch(new RegExp(`^actor-kit-[a-z-]+-0\\.3\\.0-next\\.0-${sha}(-dirty)?\\.tgz$`));
      expect(names[0]).toMatch(/^actor-kit-client-/);
      expect(printed).toContain(names[0]);
      // Inside: the vendored version, and the internal dependency pinned to the same build.
      const worker = names.find((name) => name.startsWith("actor-kit-worker-"));
      if (worker === undefined) throw new Error("no worker tarball");
      const packed: unknown = JSON.parse(
        execFileSync("tar", ["-xzOf", join(out, worker), "package/package.json"], { encoding: "utf8" }),
      );
      const version = worker.replace(/^actor-kit-worker-/, "").replace(/\.tgz$/, "");
      expect(packed).toMatchObject({ version, dependencies: { "@actor-kit/core": version } });
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
