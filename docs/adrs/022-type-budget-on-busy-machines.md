# ADR 022: The type budget's check-time limit on busy machines

**Date**: 2026-10-18
**Status**: Proposed (for Jon to decide; nothing is changed yet)
**Depends on**: ADR-019 A (the compile-time budget)

## Context

`pnpm typecheck:budget` (`scripts/type-budget.mts`, run by `pnpm typecheck` and so by the pre-commit
hook) fails when the state-tree fixtures go over either of two limits in
`tests/unit/type-budget.json`:

- **instantiations** ≤ 750 000: deterministic. 681 460 when set; 693 939 now.
- **check time** ≤ 2 s: tsc's `Check time`, which is wall-clock time.

During the 2026-10-17/18 hardening run, Jon's Mac ran several sessions at once (iOS simulators,
Chrome, ffmpeg recordings, Stryker), with load averages from 30 to 300 on 18 cores. Measured
check times:

| Load (1-min) | Check time | Instantiations |
|---|---|---|
| idle-ish (< 10) | 0.3 s, 0.8 s, 1.1 s | 693 431 |
| 45–60 | 3.2 s, 3.7 s | 693 423, 693 939 |
| 70–140 | 5.6 s, 7.8 s | 693 431, 693 939 |
| 100–300 | 15.1 s | 693 431 |

The instantiation count never moved with load. The check time did, by 50×. About seven commits on
the branch were refused by the hook for check time alone, with unchanged types. Each one waited
from 30 s to 10 min for the load to drop and the commit to be retried. Nothing was wrong with the
types each time.

## Options

### A. Fail on instantiations only; report check time (recommended by the hardening session)

- The hook and `pnpm typecheck:budget` fail only when instantiations go over the budget.
- Check time is printed, and also fails in CI only (a dedicated runner, where wall time means
  something), or is only printed and its limit dropped.
- Pro: commits never fail for load; the deterministic guard (the one ADR-019 A relied on: "the real
  guard") stays strict.
- Con: a change that slows checking without adding instantiations (deeper conditional types that
  are cheap to instantiate but slow to relate) is caught only in CI, or not at all if the time
  limit is dropped.

### B. Keep both limits as they are

- Pro: nothing changes; a slow type change is caught on the machine that made it.
- Con: on a busy machine the hook refuses commits that change no types (above). The practical
  workaround is to wait for the load to drop and retry, which costs minutes per commit and invites
  `--no-verify`, which CLAUDE.md forbids.

### Variants considered

- Measure CPU time instead of wall time (run tsc in-process, `process.cpuUsage()`): less sensitive
  to load, but CPU time still grows under contention (cache and frequency effects), and it measures
  something tsc does not report, so the budget would need re-baselining.
- Raise the limit (say 20 s): passes today's worst case but no longer catches a 10× slowdown on
  a quiet machine.

## Decision

Pending: Jon picks A or B.
