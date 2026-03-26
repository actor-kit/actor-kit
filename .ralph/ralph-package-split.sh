#!/usr/bin/env bash
set -euo pipefail

# Ralph: Package Split — @actor-kit/* monorepo
# Splits packages/actor-kit/ into @actor-kit/core, @actor-kit/worker,
# @actor-kit/client, @actor-kit/react, @actor-kit/test
# Each iteration: execute task → verify → codex review → fix → commit

ITERATIONS="${1:-13}"
LOGDIR=".ralph/logs"
mkdir -p "$LOGDIR"

for i in $(seq 1 "$ITERATIONS"); do
  echo ""
  echo "=== Ralph iteration $i / $ITERATIONS ==="
  echo ""

  LOGFILE="$LOGDIR/iteration-${i}.log"

  claude -p --dangerously-skip-permissions \
    "@.ralph/backlog.md @.ralph/progress.md @.ralph/lessons.md @CLAUDE.md YOUR JOB: Complete ONE task from the backlog, run codex review, fix issues, and commit.

STEPS:
1. Read backlog.md — find the first unchecked task.
2. Read progress.md — check for in-progress work from a previous iteration.
3. Read lessons.md — avoid past mistakes.
4. Execute the task. Follow the dependency graph in backlog.md exactly. Each package gets: package.json, tsconfig.json, src/index.ts, and the source files.
5. For package.json: use name like @actor-kit/core, set main/types/exports fields, list only the deps specified in the backlog.
6. After making changes, run: pnpm install && pnpm typecheck. Fix any errors before proceeding.
7. If the task involves tests, run: pnpm test:unit. All must pass.
8. Run codex review: codex review --uncommitted -c model_reasoning_effort=\"high\" 2>&1 | tee .ralph/codex-review.md
9. Read .ralph/codex-review.md. For each P1/P2 finding: fix it. For P3/nits: fix if quick. Re-run typecheck/tests after fixes.
10. Stage and commit with a descriptive conventional commit message. Include Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
11. Mark the task done in backlog.md (change [ ] to [x]).
12. Update progress.md with what you did, codex findings addressed, and any issues encountered.
13. If you learned something, add it to lessons.md.

RULES:
- ONLY work on ONE task. Do not continue to the next.
- Do NOT summarize the backlog. Just execute.
- Do NOT ask what to work on. Pick the first unchecked task.
- Do NOT skip typecheck verification. Every iteration must leave the project in a compilable state.
- Do NOT skip codex review. Every iteration gets reviewed before commit.
- Do NOT re-export between packages. Each package has its own explicit exports.
- Do NOT use any or as casts in new code.
- Use pnpm, not npm or yarn.
- Commit after each task, not at the end.
- If all tasks are done, output <promise>COMPLETE</promise>." \
    2>&1 | tee "$LOGFILE"

  if grep -q "<promise>COMPLETE</promise>" "$LOGFILE"; then
    echo ""
    echo "=== Ralph: ALL TASKS COMPLETE ==="
    break
  fi
done
