/**
 * Compile-time budget for the state-tree types (ADR-019 A): typechecks the fixtures in
 * tests/unit/tsconfig.budget.json with `--extendedDiagnostics` and fails when the type
 * instantiations or the check time go over tests/unit/type-budget.json, so inference cost cannot
 * regress silently. Instantiations are deterministic (the real guard); check time has headroom for a
 * loaded machine.
 *
 *   node scripts/type-budget.mts            # check
 *   node scripts/type-budget.mts --print    # print the numbers, never fail
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const root = resolve(import.meta.dirname, "..");
const Budget = z.object({ instantiations: z.number().int().positive(), checkTimeSeconds: z.number().positive() });
const budget = Budget.parse(JSON.parse(readFileSync(resolve(root, "tests/unit/type-budget.json"), "utf8")));

/** One `Name: value` line of tsc's extended diagnostics, as a number. */
function diagnostic(output: string, name: string): number {
  const match = new RegExp(`^${name}:\\s+([\\d.]+)`, "m").exec(output);
  if (match?.[1] === undefined) throw new Error(`tsc --extendedDiagnostics printed no "${name}"`);
  return Number(match[1]);
}

const output = execFileSync(
  resolve(root, "node_modules/.bin/tsc"),
  ["-p", "tests/unit/tsconfig.budget.json", "--extendedDiagnostics"],
  { cwd: root, encoding: "utf8" },
);
const instantiations = diagnostic(output, "Instantiations");
const checkTimeSeconds = diagnostic(output, "Check time");
console.log(
  `state-tree types: ${instantiations} instantiations (budget ${budget.instantiations}), check ${checkTimeSeconds}s (budget ${budget.checkTimeSeconds}s)`,
);
const over = [
  instantiations > budget.instantiations ? "instantiations" : null,
  checkTimeSeconds > budget.checkTimeSeconds ? "check time" : null,
].filter((name) => name !== null);
if (over.length > 0 && !process.argv.includes("--print")) {
  console.error(
    `Over the compile-time budget (${over.join(", ")}). Simplify the types, or raise the budget in a reviewed change.`,
  );
  process.exit(1);
}
