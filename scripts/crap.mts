/**
 * CRAP (Change Risk Anti-Patterns) per function, for this repo.
 *
 *   CRAP(f) = CC(f)^2 × (1 − cov(f))^3 + CC(f)
 *
 * CC is counted on the AST (oxc-parser), ESLint-style, for the function's own
 * body only (nested functions are scored separately):
 *   1 + if, ?:, case (not default), for/for-in/for-of/while/do-while, catch,
 *   &&, ||, ??, &&=, ||=, ??=, default parameter values.
 * Optional chaining (?.) is not counted.
 *
 * Coverage comes from Vitest's v8 provider (istanbul JSON): the share of the
 * function's own statements and branch arms that ran, plus the function entry.
 *
 * Usage (from the repo root):
 *   pnpm exec vitest run --coverage --coverage.reporter=json --silent
 *   node scripts/crap.mts [--coverage coverage/coverage-final.json]... [--threshold 8] [--top 20] <dir>...
 *
 * --coverage may be given more than once (e.g. unit + integration coverage): each function takes
 * its best coverage across the files.
 *
 * Prints one row per function above the threshold (or the top N), and a
 * per-directory summary (functions, max CRAP, count over threshold).
 * Exits 1 when any function is at or above the threshold.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseSync } from "oxc-parser";
import { z } from "zod";

const Position = z.object({ line: z.number(), column: z.number().nullable() });
const Range = z.object({ start: Position, end: Position });
const FileCoverage = z.object({
  statementMap: z.record(z.string(), Range),
  s: z.record(z.string(), z.number()),
  branchMap: z.record(z.string(), z.object({ loc: Range, locations: z.array(z.unknown()) })),
  b: z.record(z.string(), z.array(z.number())),
});
const Coverage = z.record(z.string(), FileCoverage);
type FileCoverage = z.infer<typeof FileCoverage>;

const AstNode = z.looseObject({ type: z.string(), start: z.number(), end: z.number() });
type AstNode = z.infer<typeof AstNode>;

interface Row {
  file: string;
  name: string;
  line: number;
  cc: number;
  cov: number;
  crap: number;
}

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const DECISION_TYPES = new Set([
  "IfStatement",
  "ConditionalExpression",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "CatchClause",
  "AssignmentPattern",
]);
const LOGICAL_OPERATORS = new Set(["&&", "||", "??", "&&=", "||=", "??="]);

function decisionWeight(node: AstNode): number {
  if (DECISION_TYPES.has(node.type)) return 1;
  if (node.type === "SwitchCase") return node["test"] === null ? 0 : 1;
  const op = node["operator"];
  if ((node.type === "LogicalExpression" || node.type === "AssignmentExpression") && typeof op === "string") {
    return LOGICAL_OPERATORS.has(op) ? 1 : 0;
  }
  return 0;
}

function childNodes(node: AstNode): AstNode[] {
  const out: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      const parsed = AstNode.safeParse(v);
      if (parsed.success) out.push(parsed.data);
    }
  }
  return out;
}

function keyName(key: unknown): string | undefined {
  const parsed = z
    .object({ name: z.string() })
    .or(z.object({ value: z.string() }))
    .safeParse(key);
  if (!parsed.success) return undefined;
  return "name" in parsed.data ? parsed.data.name : parsed.data.value;
}

function nameFor(fn: AstNode, parent: AstNode | undefined): string {
  const own = keyName(fn["id"]);
  if (own) return own;
  if (parent?.type === "VariableDeclarator") return keyName(parent["id"]) ?? "(anonymous)";
  if (parent?.type === "MethodDefinition" || parent?.type === "Property" || parent?.type === "PropertyDefinition") {
    return keyName(parent["key"]) ?? "(anonymous)";
  }
  return "(anonymous)";
}

interface FunctionInfo {
  name: string;
  start: number;
  end: number;
  cc: number;
  nested: Array<[number, number]>;
}

function collectFunctions(program: AstNode): FunctionInfo[] {
  const out: FunctionInfo[] = [];
  const visit = (node: AstNode, parent: AstNode | undefined, owner: FunctionInfo | undefined): void => {
    let current = owner;
    if (FUNCTION_TYPES.has(node.type)) {
      current = { name: nameFor(node, parent), start: node.start, end: node.end, cc: 1, nested: [] };
      owner?.nested.push([node.start, node.end]);
      out.push(current);
    } else if (current) {
      current.cc += decisionWeight(node);
    }
    for (const child of childNodes(node)) visit(child, node, current);
  };
  visit(program, undefined, undefined);
  return out;
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
  return starts;
}

function coverageFor(fn: FunctionInfo, file: FileCoverage | undefined, starts: number[]): number {
  if (!file) return 0;
  const offset = (p: z.infer<typeof Position>): number => (starts[p.line - 1] ?? 0) + (p.column ?? 0);
  const owns = (r: z.infer<typeof Range>): boolean => {
    const at = offset(r.start);
    if (at < fn.start || at >= fn.end) return false;
    return !fn.nested.some(([s, e]) => at >= s && at < e);
  };
  let total = 1;
  let hit = 0;
  let bodyRan = false;
  for (const [id, range] of Object.entries(file.statementMap)) {
    if (!owns(range)) continue;
    total++;
    if ((file.s[id] ?? 0) > 0) {
      hit++;
      bodyRan = true;
    }
  }
  for (const [id, branch] of Object.entries(file.branchMap)) {
    if (!owns(branch.loc)) continue;
    for (const count of file.b[id] ?? []) {
      total++;
      if (count > 0) hit++;
    }
  }
  // The entry counts as covered when any of the function's own statements ran.
  if (bodyRan) hit++;
  return hit / total;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(path);
  }
  return out;
}

const FLAGS = new Set(["--coverage", "--threshold", "--top"]);

/** Every value given for a flag, in order. */
function args(name: string): string[] {
  return process.argv
    .slice(2)
    .flatMap((a, i, all) => (a === `--${name}` && all[i + 1] !== undefined ? [all[i + 1] ?? ""] : []));
}

function arg(name: string, fallback: string): string {
  return args(name).at(-1) ?? fallback;
}

const threshold = Number(arg("threshold", "8"));
const top = Number(arg("top", "0"));
const coverageFiles = args("coverage");
const coverages = (coverageFiles.length > 0 ? coverageFiles : ["coverage/coverage-final.json"]).map((file) =>
  Coverage.parse(JSON.parse(readFileSync(resolve(file), "utf8"))),
);
const dirs = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !FLAGS.has(all[i - 1] ?? ""));

const rows: Row[] = [];
for (const dir of dirs) {
  for (const path of sourceFiles(resolve(dir))) {
    const source = readFileSync(path, "utf8");
    const program = AstNode.parse(parseSync(path, source).program);
    const starts = lineStarts(source);
    for (const fn of collectFunctions(program)) {
      const cov = Math.max(...coverages.map((coverage) => coverageFor(fn, coverage[path], starts)));
      const crap = fn.cc ** 2 * (1 - cov) ** 3 + fn.cc;
      const line = starts.filter((s) => s <= fn.start).length;
      rows.push({ file: relative(process.cwd(), path), name: fn.name, line, cc: fn.cc, cov, crap });
    }
  }
}

rows.sort((a, b) => b.crap - a.crap);
const shown = rows.filter((r, i) => r.crap >= threshold || i < top);
for (const r of shown) {
  const mark = r.crap >= threshold ? "FAIL" : "ok  ";
  console.log(
    `${mark} ${r.crap.toFixed(1).padStart(6)}  CC=${String(r.cc).padStart(2)}  cov=${(r.cov * 100).toFixed(0).padStart(3)}%  ${r.file}:${r.line} ${r.name}`,
  );
}

console.log("\ndir | functions | max CRAP | ≥ threshold");
for (const dir of dirs) {
  const own = rows.filter((r) => r.file.startsWith(relative(process.cwd(), resolve(dir))));
  const max = own.reduce((m, r) => Math.max(m, r.crap), 0);
  console.log(`${dir} | ${own.length} | ${max.toFixed(1)} | ${own.filter((r) => r.crap >= threshold).length}`);
}

process.exit(rows.some((r) => r.crap >= threshold) ? 1 : 0);
