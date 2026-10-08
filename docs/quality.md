# Code quality: mutation score and CRAP

Two gates, measured per package:

- **Mutation score** (Stryker, unit tests only): target ≥ 90%. Score = (killed + timeout) / all mutants, so
  NoCoverage mutants count against it. Integration tests (vitest-pool-workers) do not run under Stryker, so code
  reached only from integration tests shows up as NoCoverage.
- **CRAP** (`scripts/crap.mts`): every function < 8. CC is counted on the AST for the function's own body
  (if, ?:, case, loops, catch, &&, ||, ??, logical assignment, default parameters; not `?.`). Coverage is the
  share of the function's own statements and branch arms that the unit tests ran.

## How to measure

```bash
# Mutation, one package (incremental after the first run)
pnpm exec stryker run --mutate 'packages/core/src/**/*.ts,!packages/core/src/index.ts' --incremental

# CRAP, any set of source directories
pnpm crap packages/core/src packages/client/src
```

## Results per package

Before = baseline on `claude/v2-hardening` at `c1e0750` (2026-10-07). Mutation counts are
killed+timeout / total; "max CRAP" is the highest function score, with the number of functions at or over 8.

| Package | Mutation before | Mutation after | Max CRAP before (≥ 8) | Max CRAP after (≥ 8) |
|---|---|---|---|---|
| core | 78.02% (710/910) | | 27.7 `encodeDelta` (10) | |
| client | 50.23% (222/442) | | 130.0 `handleBinaryMessage` (5) | |
| react | 50.00% (26/52) | | 2.1 (0) | |
| test | 70.55% (115/163) | | 9.0 `sendWithEffectsImpl` (1) | |
| storybook | no tests (0%) | | 20.0 `send` (2) | |
| studio (server) | 75.58% (622/823) | | 42.0 middleware handler (6) | |
| studio UI (`ui/src`) | 65.45% (896/1369) | | 19.2 `alignPrimitiveArrays` (12) | |
| studio-cli | 78.87% (362/459) | | 30.0 mcp tool handler (6) | |

## Equivalent mutants

Surviving mutants that no test can kill, because the mutated program behaves identically. One line each.

| Package | Location | Mutant | Why it is equivalent |
|---|---|---|---|
