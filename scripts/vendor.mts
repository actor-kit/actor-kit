/**
 * Vendor the packages as tarballs for an app that installs them from files (Run Set Jimmy feedback 17).
 * Each published package is packed as `<name>-<version>-<short commit>.tgz` (`-dirty` added when the
 * working tree has changes), with that version inside the tarball and its `workspace:*` dependencies on
 * the other packages pinned to the same build, so a re-vendored build always has a new name and pnpm's
 * lockfile sees the change. The repository is not modified: each package is staged in a temporary
 * directory and packed there.
 *
 *   scripts/vendor.sh <dir>          # build every package, then pack them into <dir>
 *   node scripts/vendor.mts <dir>    # pack what is already built
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const Deps = z.record(z.string(), z.string());

const Manifest = z.looseObject({
  name: z.string(),
  version: z.string(),
  private: z.boolean().optional(),
  files: z.array(z.string()).optional(),
  dependencies: Deps.optional(),
  peerDependencies: Deps.optional(),
  devDependencies: Deps.optional(),
});

export type Manifest = z.infer<typeof Manifest>;

const DEPENDENCY_FIELDS = ["dependencies", "peerDependencies", "devDependencies"] as const;

/** The vendored version: the package version, then the short commit (and `-dirty` for a changed tree). */
export function vendorVersion(version: string, sha: string, dirty: boolean): string {
  return `${version}-${sha}${dirty ? "-dirty" : ""}`;
}

/** The file `npm pack` / `pnpm pack` writes: the scope's `@` dropped and its `/` turned into `-`. */
export function tarballName(name: string, version: string): string {
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

/** The manifest as packed: the vendored version, and `workspace:` dependencies pinned to the vendored ones. */
export function vendorManifest(manifest: Manifest, versions: ReadonlyMap<string, string>): Manifest {
  const pin = (deps: Record<string, string> | undefined): Record<string, string> | undefined =>
    deps === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(deps).map(([dep, range]) => {
            if (!range.startsWith("workspace:")) return [dep, range];
            const version = versions.get(dep);
            if (version === undefined) {
              throw new Error(
                `${manifest.name} depends on ${dep} (${range}), which is not one of the vendored packages`,
              );
            }
            return [dep, version];
          }),
        );
  const next: Manifest = { ...manifest, version: versions.get(manifest.name) ?? manifest.version };
  for (const field of DEPENDENCY_FIELDS) {
    const pinned = pin(manifest[field]);
    if (pinned !== undefined) next[field] = pinned;
  }
  return next;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

/** Pack every published package under `packages/` into `out`; returns the tarball names. */
export function vendor(root: string, out: string): string[] {
  const sha = git(root, ["rev-parse", "--short", "HEAD"]);
  const dirty = git(root, ["status", "--porcelain"]) !== "";
  const packages = readdirSync(resolve(root, "packages"))
    .map((dir) => ({ dir: resolve(root, "packages", dir) }))
    .filter(({ dir }) => existsSync(join(dir, "package.json")))
    .map(({ dir }) => ({ dir, manifest: Manifest.parse(JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))) }))
    .filter(({ manifest }) => manifest.private !== true);
  const versions = new Map(
    packages.map(({ manifest }) => [manifest.name, vendorVersion(manifest.version, sha, dirty)]),
  );
  mkdirSync(out, { recursive: true });
  const staging = mkdtempSync(join(tmpdir(), "actor-kit-vendor-"));
  try {
    return packages.map(({ dir, manifest }) => {
      const stage = join(staging, manifest.name.replace(/^@/, "").replace("/", "-"));
      mkdirSync(stage);
      for (const entry of [...(manifest.files ?? []), "README.md", "LICENSE"]) {
        if (existsSync(join(dir, entry))) cpSync(join(dir, entry), join(stage, entry), { recursive: true });
      }
      const packed = vendorManifest(manifest, versions);
      writeFileSync(join(stage, "package.json"), `${JSON.stringify(packed, null, 2)}\n`);
      execFileSync("pnpm", ["pack", "--pack-destination", out], { cwd: stage, stdio: "ignore" });
      return tarballName(packed.name, packed.version);
    });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (out === undefined) {
    console.error("usage: node scripts/vendor.mts <dir>   (or scripts/vendor.sh <dir> to build first)");
    process.exit(1);
  }
  const root = resolve(import.meta.dirname, "..");
  const dir = resolve(out);
  for (const name of vendor(root, dir)) console.log(join(dir, name));
}
