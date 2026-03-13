import fs from "node:fs";
import path from "node:path";

const srcDir = path.resolve("src");
const coveragePath = path.resolve("coverage/lcov.info");
const reportsDir = path.resolve("reports");
const outputPath = path.join(reportsDir, "crap-report.json");

fs.mkdirSync(reportsDir, { recursive: true });

const coverageByFile = parseLcov(fs.readFileSync(coveragePath, "utf8"));
const files = walk(srcDir).filter(
  (file) =>
    (file.endsWith(".ts") || file.endsWith(".tsx")) &&
    !file.endsWith(".d.ts")
);

const report = files
  .map((file) => {
    const source = fs.readFileSync(file, "utf8");
    const relativePath = normalize(file);
    const complexity = estimateCyclomaticComplexity(source);
    const coverage = coverageByFile.get(relativePath) ?? 0;
    const crap = complexity ** 2 * (1 - coverage / 100) ** 3 + complexity;

    return {
      file: relativePath,
      complexity,
      coverage,
      crap: Number(crap.toFixed(2)),
    };
  })
  .sort((a, b) => b.crap - a.crap);

fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

console.log("Top CRAP hotspots:");
for (const row of report.slice(0, 20)) {
  console.log(
    `${row.crap.toFixed(2).padStart(8)}  ${String(row.coverage).padStart(3)}%  c=${String(
      row.complexity
    ).padStart(2)}  ${row.file}`
  );
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return walk(fullPath);
    }
    return [fullPath];
  });
}

function parseLcov(text) {
  const results = new Map();
  const sections = text.split("end_of_record");

  for (const section of sections) {
    const lines = section.trim().split("\n").filter(Boolean);
    if (lines.length === 0) {
      continue;
    }

    const fileLine = lines.find((line) => line.startsWith("SF:"));
    if (!fileLine) {
      continue;
    }

    const foundLine = lines.find((line) => line.startsWith("LF:"));
    const hitLine = lines.find((line) => line.startsWith("LH:"));
    const total = foundLine ? Number(foundLine.slice(3)) : 0;
    const hit = hitLine ? Number(hitLine.slice(3)) : 0;

    results.set(normalize(fileLine.slice(3)), total > 0 ? Math.round((hit / total) * 100) : 0);
  }

  return results;
}

function estimateCyclomaticComplexity(source) {
  const matches = source.match(
    /\bif\b|\belse if\b|\bfor\b|\bwhile\b|\bcase\b|\bcatch\b|\?\s*[^:]/g
  );
  return 1 + (matches?.length ?? 0);
}

function normalize(filePath) {
  return path.relative(process.cwd(), filePath).replaceAll(path.sep, "/");
}
