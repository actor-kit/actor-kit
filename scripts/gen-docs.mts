/**
 * Write the generated docs (ADR-018 H): error pages, package docs/, llms.txt and llms-full.txt.
 *
 *   node scripts/gen-docs.mts          write them
 *   node scripts/gen-docs.mts --check  exit 1 when any is out of date (CI, tests)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { generateDocs } from "./docs.mts";

const root = join(import.meta.dirname, "..");
const check = process.argv.includes("--check");
const stale: string[] = [];
for (const [path, content] of generateDocs(root)) {
  const file = join(root, path);
  const current = existsSync(file) ? readFileSync(file, "utf8") : null;
  if (current === content) continue;
  stale.push(path);
  if (!check) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}
if (check && stale.length > 0) {
  console.error(`Out of date (run pnpm docs:gen):\n${stale.join("\n")}`);
  process.exit(1);
}
console.log(check ? "Generated docs are up to date." : `Wrote ${stale.length} file(s).`);
