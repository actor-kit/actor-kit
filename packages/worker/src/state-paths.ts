/**
 * Types for a tree of states (ADR-019 A) and the view/role helpers `matches()` / `localOf()`. They live in
 * @actor-kit/core, which is zod-free at runtime, so browser code can import them from there (Run Set Jimmy
 * feedback 15); the worker re-exports them for actor code.
 */

export type {
  DeclAt,
  Dotted,
  EnterStayArgs,
  GotoArgs,
  GotoOptions,
  InputArgs,
  InputOf,
  KeptLocals,
  LeafPathsOf,
  LocalOf,
  LocalsAlong,
  Matching,
  MergedLocal,
  MergeLocals,
  ParentOf,
  PathOf,
  PathsOf,
  PathsUnder,
  PhasedState,
  StateDecl,
  StateDecls,
  StatePath,
  TargetOf,
} from "@actor-kit/core";
export { localOf, matches } from "@actor-kit/core";
