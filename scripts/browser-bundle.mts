/**
 * The weight a game's pages pay for actor-kit (ADR-024): @actor-kit/client, @actor-kit/react and
 * @actor-kit/core bundled for the browser (minified, React left out: the game ships it anyway), gzipped.
 *
 *   node scripts/browser-bundle.mts        prints the size and every input over 1 KB
 *
 * tests/unit/browser-bundle.test.ts holds the budget and fails on any validator in the bundle.
 */

import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));

/** What a game's page imports from actor-kit: the client, the React bindings and core's schemas. */
const ENTRY = `
export { actorClient, createActorClient } from "@actor-kit/client";
export { actorContext, createActorContext } from "@actor-kit/react";
export { schema, json, view, uint8, uint16, uint32, float64, string, boolean, array, nullable, parseSchema } from "@actor-kit/core";
`;

export interface BrowserBundle {
  readonly bytes: number;
  readonly gzipBytes: number;
  /** Every source file in the bundle, with its bytes in the output. */
  readonly inputs: ReadonlyArray<{ readonly path: string; readonly bytes: number }>;
}

export async function browserBundle(): Promise<BrowserBundle> {
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: root, loader: "ts" },
    bundle: true,
    minify: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
    metafile: true,
    external: ["react", "react-dom", "react/jsx-runtime"],
    // The sources, so the check needs no build and sees what this commit ships.
    alias: {
      "@actor-kit/core": `${root}packages/core/src/index.ts`,
      "@actor-kit/client": `${root}packages/client/src/index.ts`,
      "@actor-kit/react": `${root}packages/react/src/index.ts`,
    },
    logLevel: "silent",
  });
  const [file] = result.outputFiles;
  if (file === undefined) throw new Error("esbuild wrote no bundle");
  const output = Object.values(result.metafile.outputs)[0];
  const inputs = Object.entries(output?.inputs ?? {}).map(([path, { bytesInOutput }]) => ({
    path,
    bytes: bytesInOutput,
  }));
  return { bytes: file.contents.byteLength, gzipBytes: gzipSync(file.contents, { level: 9 }).byteLength, inputs };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bundle = await browserBundle();
  process.stdout.write(`actor-kit browser bundle: ${bundle.bytes} bytes, ${bundle.gzipBytes} gzipped\n`);
  for (const input of [...bundle.inputs].sort((a, b) => b.bytes - a.bytes).filter((i) => i.bytes > 1024)) {
    process.stdout.write(`  ${String(input.bytes).padStart(7)}  ${input.path}\n`);
  }
}
