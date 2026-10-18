/**
 * The mechanical part of moving a game from npm actor-kit 0.52 to the @actor-kit packages
 * (docs/migrating-from-0.52.md §7): package.json (dependencies, pnpm overrides, the 0.52 patch), the
 * vendored tarballs, import paths and the token option rename. It does not rewrite the XState
 * machine; it lists every line that still needs a person, with a hint.
 *
 *   node scripts/migrate-from-0.52.mts <game dir> <dir with vendored tarballs> [--dry]
 *
 * The tarball directory is what `scripts/vendor.sh <dir>` wrote. `--dry` prints the plan and writes
 * nothing.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Where each 0.52 import path lives in 0.3. The bare "actor-kit" import has no counterpart. */
const IMPORT_MAP: Record<string, string> = {
  "actor-kit/worker": "@actor-kit/worker",
  "actor-kit/react": "@actor-kit/react",
  "actor-kit/server": "@actor-kit/worker/token",
  "actor-kit/test": "@actor-kit/test",
  "actor-kit/storybook": "@actor-kit/storybook",
};

/** Rewrites `from "actor-kit/<subpath>"` (import and export) to the 0.3 package. */
export function rewriteImports(source: string): { source: string; rewritten: number } {
  let rewritten = 0;
  const next = source.replace(
    /(\bfrom\s+)(["'])(actor-kit\/[a-z]+)\2/g,
    (whole, from: string, quote: string, path: string) => {
      const target = IMPORT_MAP[path];
      if (target === undefined) return whole;
      rewritten += 1;
      return `${from}${quote}${target}${quote}`;
    },
  );
  return { source: next, rewritten };
}

/** 0.52's `createAccessToken({ signingKey })` is `createAccessToken({ secret })` in 0.3. */
export function renameTokenOptions(source: string): { source: string; renamed: number } {
  if (!/\bcreateAccessToken\b/.test(source)) return { source, renamed: 0 };
  let renamed = 0;
  const next = source.replace(/\bsigningKey(\s*:)/g, (_whole, colon: string) => {
    renamed += 1;
    return `secret${colon}`;
  });
  return { source: next, renamed };
}

const HINTS: Record<string, string> = {
  createMachineServer:
    "Rewrite the machine as a contract: defineActor(name, { input, init, roles, messages, views, timers }) and createActorClass (guide §2-3)",
  createActorKitRouter:
    "Your own Worker route: authenticate, then stub.fetch(withCallerIdentity(req, { callerId, callerType: 'user', supportsBinary: true }))",
  createActorKitContext: "actorContext(Contract) from @actor-kit/react",
  createActorKitClient: "actorClient(Contract).create({ path, host, initialView, getToken }) from @actor-kit/client",
  createActorKitMockClient: "createMockClient from @actor-kit/storybook, or testActor / simulate from @actor-kit/test",
  WithActorKitEvent: "Gone: each message is a Zod payload; the caller is ctx.caller and ctx.callerType",
  WithActorKitInput: "Gone: the actor's input schema is its own; the caller is not part of it",
  BaseActorKitEvent: "Gone: handlers get (state, payload, ctx)",
  ActorKitSystemEvent: "Gone: no RESUME (timers are durable); lifecycle connect/disconnect replace INITIALIZE/CONNECT",
  ActorKitEnv: "Your own Env type (an optional env schema on the actor types ctx.env)",
  ActorKitStorage: "Gone: state persists by itself",
  Caller: "A caller is a string id plus callerType 'user' | 'service'",
  fromActorKit: "Gone (XState interop): use links (ADR-011) or a service",
  FromActorKitEmitted: "Gone (XState interop)",
  CallerSnapshotFrom: "Gone: views are typed from their schema (Infer<typeof Schema>)",
  ActorKitStateMachine: "Gone: there is no machine",
};

export interface ManualWork {
  file: string;
  line: number;
  what: string;
  hint: string;
}

/** Every line that still needs a person: 0.52 symbols, xstate, and imports from the bare "actor-kit". */
export function manualWork(file: string, source: string): ManualWork[] {
  const work: ManualWork[] = [];
  source.split("\n").forEach((text, i) => {
    const line = i + 1;
    if (/\bfrom\s+["']actor-kit["']/.test(text)) {
      work.push({
        file,
        line,
        what: 'import from "actor-kit"',
        hint: "Its types have no 0.3 counterpart: see the symbols on this line",
      });
    }
    const found = Object.keys(HINTS)
      .map((symbol) => ({ symbol, at: text.search(new RegExp(`\\b${symbol}\\b`)) }))
      .filter((f) => f.at >= 0)
      .sort((a, b) => a.at - b.at);
    for (const { symbol } of found) work.push({ file, line, what: symbol, hint: HINTS[symbol] ?? "" });
    if (/\bfrom\s+["']xstate["']/.test(text)) {
      work.push({ file, line, what: "xstate", hint: "XState goes away with the machine (guide §2)" });
    }
  });
  return work;
}

const Deps = z.record(z.string(), z.string());
const Manifest = z.looseObject({
  dependencies: Deps.optional(),
  devDependencies: Deps.optional(),
  pnpm: z.looseObject({ overrides: Deps.optional(), patchedDependencies: Deps.optional() }).optional(),
});

const ZOD = "^4.6.5";
const JOSE = "^6.2.12";

export interface MigrateOptions {
  /** The build tag in the tarball names, e.g. "0.3.0-next.0-abc1234". */
  tag: string;
  /** Whether the game imports actor-kit/react, and whether it signs tokens (createAccessToken). */
  uses: { react: boolean; token: boolean };
}

/** package.json for 0.3: actor-kit swapped for the vendored packages (all pinned), the 0.52 patch dropped. */
export function migrateManifest(
  raw: unknown,
  options: MigrateOptions,
): { manifest: Record<string, unknown>; notes: string[] } {
  const manifest = Manifest.parse(raw);
  // The raw object keeps the file's key order (the parse puts known keys first).
  const original = z.record(z.string(), z.unknown()).parse(raw);
  const notes: string[] = [];
  const dependencies = { ...manifest.dependencies };
  const devDependencies = { ...manifest.devDependencies };
  const version = dependencies["actor-kit"] ?? devDependencies["actor-kit"];
  if (version === undefined) throw new Error("package.json has no actor-kit dependency: nothing to migrate");
  delete dependencies["actor-kit"];
  delete devDependencies["actor-kit"];
  notes.push(`removed actor-kit ${version}`);

  const file = (pkg: string) => `file:vendor/actor-kit/actor-kit-${pkg}-${options.tag}.tgz`;
  const runtime = ["core", "worker", "client", ...(options.uses.react ? ["react"] : [])];
  for (const pkg of runtime) dependencies[`@actor-kit/${pkg}`] = file(pkg);
  // Always: the machine's test helpers move to simulate() (guide §4), even when 0.52 tests drove XState directly.
  devDependencies["@actor-kit/test"] = file("test");
  // @actor-kit/worker's message() takes zod 4 schemas; its token helpers need jose (an optional peer).
  const zod = dependencies["zod"];
  if (zod !== undefined && !/^[\^~]?4\./.test(zod)) {
    dependencies["zod"] = ZOD;
    notes.push(`zod ${zod} → ${ZOD}: message schemas are zod 4 (check z.record and error messages)`);
  }
  if (options.uses.token && dependencies["jose"] === undefined) {
    dependencies["jose"] = JOSE;
    notes.push("added jose (createAccessToken signs actor-kit tokens with it)");
  }
  const pinned = [...runtime, "test"];
  const overrides = { ...manifest.pnpm?.overrides };
  for (const pkg of pinned) overrides[`@actor-kit/${pkg}`] = file(pkg);

  const patched = { ...manifest.pnpm?.patchedDependencies };
  for (const key of Object.keys(patched).filter((k) => k.startsWith("actor-kit@"))) {
    delete patched[key];
    notes.push(`removed the patch for ${key} (0.3 answers close codes itself)`);
  }
  const { patchedDependencies: _patched, overrides: _overrides, ...restPnpm } = manifest.pnpm ?? {};
  const pnpm = { ...restPnpm, overrides, ...(Object.keys(patched).length > 0 ? { patchedDependencies: patched } : {}) };
  if (dependencies["xstate"] !== undefined || devDependencies["xstate"] !== undefined) {
    notes.push("xstate is still a dependency: remove it once the machine is rewritten, if nothing else uses it");
  }
  return { manifest: { ...original, dependencies, devDependencies, pnpm }, notes };
}

/** The tarballs to vendor: one per pinned package (not every package in the directory). */
export function tarballsFor(files: readonly string[], tag: string, packages: readonly string[]): string[] {
  return packages.map((pkg) => {
    const name = `actor-kit-${pkg}-${tag}.tgz`;
    if (!files.includes(name)) throw new Error(`no ${name} in the tarball directory`);
    return name;
  });
}

/** The packages a migrated manifest pins (`@actor-kit/<name>` in pnpm.overrides). */
function pinnedPackages(manifest: Record<string, unknown>): string[] {
  const overrides = Manifest.parse(manifest).pnpm?.overrides ?? {};
  return Object.keys(overrides).flatMap((name) =>
    name.startsWith("@actor-kit/") ? [name.slice("@actor-kit/".length)] : [],
  );
}

/** What the game uses, from its sources: React (either import path, moved or not) and token signing. */
export function usesOf(sources: readonly string[]): MigrateOptions["uses"] {
  const all = sources.join("\n");
  return { react: /["'](@actor-kit|actor-kit)\/react["']/.test(all), token: /\bcreateAccessToken\b/.test(all) };
}

/** The build tag of a vendor directory, read from its core tarball's name. */
export function tagOf(files: readonly string[]): string {
  for (const name of files) {
    const match = /^actor-kit-core-(.+)\.tgz$/.exec(name);
    if (match?.[1] !== undefined) return match[1];
  }
  throw new Error("no actor-kit-core-<version>.tgz in the tarball directory: run scripts/vendor.sh <dir> first");
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|mts)$/.test(name) ? [path] : [];
  });
}

function main(game: string, tarballs: string, dry: boolean): void {
  const tag = tagOf(readdirSync(tarballs));
  const files = ["src", "app", "test", "tests", "e2e"].flatMap((d) => sourceFiles(join(game, d)));
  const sources = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
  const uses = usesOf([...sources.values()]);

  const manifestPath = join(game, "package.json");
  const { manifest, notes } = migrateManifest(JSON.parse(readFileSync(manifestPath, "utf8")), { tag, uses });
  const work: ManualWork[] = [];
  let imports = 0;
  let tokens = 0;
  for (const [path, original] of sources) {
    const moved = rewriteImports(original);
    const renamed = renameTokenOptions(moved.source);
    imports += moved.rewritten;
    tokens += renamed.renamed;
    work.push(...manualWork(relative(game, path), renamed.source));
    if (!dry && renamed.source !== original) writeFileSync(path, renamed.source);
  }

  const patches = existsSync(join(game, "patches"))
    ? readdirSync(join(game, "patches")).filter((p) => p.startsWith("actor-kit@"))
    : [];
  if (!dry) {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    for (const p of patches) rmSync(join(game, "patches", p));
    mkdirSync(join(game, "vendor/actor-kit"), { recursive: true });
    for (const t of tarballsFor(readdirSync(tarballs), tag, pinnedPackages(manifest))) {
      copyFileSync(join(tarballs, t), join(game, "vendor/actor-kit", t));
    }
  }

  const say = (line: string) => process.stdout.write(`${line}\n`);
  say(`${dry ? "Would migrate" : "Migrated"} ${game} to @actor-kit ${tag}`);
  for (const note of notes) say(`  package.json: ${note}`);
  for (const p of patches) say(`  deleted patches/${p}`);
  say(`  imports moved: ${imports}; createAccessToken signingKey → secret: ${tokens}`);
  say(`\nLeft for a person (${work.length}), see docs/migrating-from-0.52.md:`);
  for (const w of work) say(`  ${w.file}:${w.line}  ${w.what}: ${w.hint}`);
  if (!dry) say("\nThen: pnpm install, pnpm typecheck, and the tests (guide §4).");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [game, tarballs] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (game === undefined || tarballs === undefined) {
    process.stderr.write("usage: node scripts/migrate-from-0.52.mts <game dir> <tarball dir> [--dry]\n");
    process.exit(2);
  }
  main(game, tarballs, process.argv.includes("--dry"));
}
