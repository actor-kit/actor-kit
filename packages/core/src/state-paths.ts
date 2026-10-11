/**
 * Types for a tree of states (ADR-019 A): declarations nest (`{ local?, input?, states? }`), a state is
 * named by its path from the root (`["playing", "window"]`, or `"lobby"` for a top-level one), and a
 * handler's `ctx.local` is the merge of the locals along its path. Views and roles narrow the persisted
 * state with `matches()` and read the merged local with `localOf()`.
 *
 * In @actor-kit/core (Run Set Jimmy feedback 15) because view and role code runs in the browser: this
 * module imports zod for types only, so a client bundle that narrows a view with `matches()` stays
 * zod-free. @actor-kit/worker re-exports all of it.
 */

import type { z } from "zod";
import { ActorKitError } from "./errors";

/** A declared state: its local's schema, its enter input's schema and its child states, all optional. */
export interface StateDecl {
  readonly local?: z.ZodType;
  readonly input?: z.ZodType;
  readonly states?: StateDecls;
}

export type StateDecls = { readonly [name: string]: StateDecl };

/** A state's path: the names from the root down. */
export type StatePath = readonly string[];

/** A target as a path: a top-level name is its one-element path. */
export type PathOf<T> = T extends string ? readonly [T] : T extends StatePath ? T : never;

/** The child declarations of a state (never for a leaf). */
type ChildrenOf<D> = D extends { readonly states: infer C } ? C : never;

/** How deep a state tree's types go (levels below the root). Deeper declarations are not typed. */
type MaxDepth = 6;
type Deeper<D extends unknown[]> = [...D, unknown];

/** Every declared state's path. */
export type PathsOf<SD, D extends unknown[] = []> = D["length"] extends MaxDepth
  ? never
  : {
      [K in keyof SD & string]:
        | readonly [K]
        | ([ChildrenOf<SD[K]>] extends [never] ? never : readonly [K, ...PathsOf<ChildrenOf<SD[K]>, Deeper<D>>]);
    }[keyof SD & string];

/** The paths of the leaves: what the persisted phase can be (a goto to a parent descends to a leaf). */
export type LeafPathsOf<SD, D extends unknown[] = []> = D["length"] extends MaxDepth
  ? never
  : {
      [K in keyof SD & string]: [ChildrenOf<SD[K]>] extends [never]
        ? readonly [K]
        : readonly [K, ...LeafPathsOf<ChildrenOf<SD[K]>, Deeper<D>>];
    }[keyof SD & string];

/** What `goto` and `kit.in` take: a top-level name, or a path. */
export type TargetOf<SD> = (keyof SD & string) | PathsOf<SD>;

/** The declaration at a path. */
export type DeclAt<SD, P> = P extends readonly [infer H, ...infer R]
  ? H extends keyof SD
    ? R extends readonly []
      ? SD[H]
      : DeclAt<ChildrenOf<SD[H]>, R>
    : never
  : never;

/** The local of a state (null when it declares none). */
export type LocalOf<D> = D extends { local: z.ZodType<infer L> } ? L : null;
/** goto's input argument: required when the target declares `input`, absent otherwise. */
export type InputArgs<D> = D extends { input: z.ZodType<infer I> } ? [input: I] : [];
/** What `enter` receives as its input. */
export type InputOf<D> = InputArgs<D> extends [infer I] ? I : undefined;

/** The local of each level along a path, root first (what the persisted `locals` holds). */
export type LocalsAlong<SD, P> = P extends readonly [infer H, ...infer R]
  ? H extends keyof SD
    ? [LocalOf<SD[H]>, ...LocalsAlong<ChildrenOf<SD[H]>, R>]
    : []
  : [];

type Combine<A, B> = [A] extends [null] ? B : [B] extends [null] ? A : A & B;

/** The merged local of a list of level locals: their intersection, null levels skipped; null when all are. */
export type MergeLocals<Ls> = Ls extends readonly [infer A, ...infer R] ? Combine<A, MergeLocals<R>> : null;

/** What `ctx.local` is for a handler at path P: the merge of the locals of P and its ancestors. */
export type MergedLocal<SD, P> = MergeLocals<LocalsAlong<SD, P>>;

/** The path of P's parent (empty for a top-level state). */
export type ParentOf<P> = P extends readonly [...infer I, string] ? I : readonly [];

/** The common prefix of two paths. */
type CommonPrefix<A, B> = A extends readonly [infer H, ...infer RA]
  ? B extends readonly [H, ...infer RB]
    ? [H, ...CommonPrefix<RA, RB>]
    : []
  : [];

/** A path as its dotted name (`playing.window`). */
export type Dotted<P> = P extends readonly [infer H extends string]
  ? H
  : P extends readonly [infer H extends string, ...infer R]
    ? `${H}.${Dotted<R>}`
    : never;

/** The non-empty prefixes of a path, the path included. */
type NonEmptyPrefixes<P> = P extends readonly [...infer I, string] ? P | NonEmptyPrefixes<I> : never;

/**
 * What a goto's `{ locals }` may name for a handler at P going to T (row 21): the levels the goto keeps
 * whatever child is active (the common prefix of P and T's parent) that declare a local, by dotted path,
 * each typed by its own local.
 */
export type KeptLocals<SD, P, T> = {
  [Q in NonEmptyPrefixes<CommonPrefix<P, ParentOf<T>>> as LocalOf<DeclAt<SD, Q>> extends null
    ? never
    : Dotted<Q>]?: LocalOf<DeclAt<SD, Q>>;
};

/** goto's options (row 21): new locals for the levels it keeps (none when it keeps no level with a local). */
export interface GotoOptions<K> {
  readonly locals?: [keyof K] extends [never] ? Record<string, never> : K;
}

/**
 * goto's arguments after the shared state: the target's input (`undefined` when it declares none), then
 * the options. A target with an input requires it.
 */
export type GotoArgs<D, K> =
  InputArgs<D> extends [infer I] ? [input: I, options?: GotoOptions<K>] : [input?: undefined, options?: GotoOptions<K>];

/** What enter's `stay(shared, local)` takes at P (row 23): its own local, plus any keys of the levels above. */
export type EnterStayArgs<SD, P> = [LocalOf<DeclAt<SD, P>>] extends [null]
  ? [MergedLocal<SD, ParentOf<P>>] extends [null]
    ? []
    : [local?: Partial<MergedLocal<SD, ParentOf<P>>>]
  : [MergedLocal<SD, ParentOf<P>>] extends [null]
    ? [local: LocalOf<DeclAt<SD, P>>]
    : [local: LocalOf<DeclAt<SD, P>> & Partial<MergedLocal<SD, ParentOf<P>>>];

/** The leaf paths at or under P: what `ctx.phase` can be for a handler at P. */
export type PathsUnder<SD, P> = P extends StatePath ? Extract<LeafPathsOf<SD>, readonly [...P, ...string[]]> : never;

/** The state an actor with states persists, as views, roles and Studio see it: a union narrowed by `matches()`. */
export type PhasedState<SD extends StateDecls, S> =
  LeafPathsOf<SD> extends infer P
    ? P extends StatePath
      ? { shared: S; phase: P; locals: LocalsAlong<SD, P>; stateTimers: string[][] }
      : never
    : never;

/** The non-empty prefixes of a path, and its first name: what `matches()` takes. */
type Prefixes<P> = P extends readonly [...infer I, string] ? P | Prefixes<I> : never;
type MatchTarget<P> = Prefixes<P> | (P extends readonly [infer H, ...string[]] ? H : never);

/** The members of a persisted-state union whose path starts with T. */
export type Matching<St, T> = Extract<St, { readonly phase: readonly [...PrefixOf<T>, ...string[]] }>;

/** A `matches()` target as a path (readonly string[] for anything else). */
type PrefixOf<T> = PathOf<T> extends infer P extends StatePath ? P : StatePath;

/**
 * Whether the actor is in the state at `path` or one of its children (a path prefix):
 * `matches(s, "playing")`, `matches(s, ["playing", "window"])`. Narrows the persisted state for views
 * and roles, so its `locals` are typed.
 */
export function matches<St extends { readonly phase: StatePath }, const T extends MatchTarget<St["phase"]>>(
  state: St,
  path: T,
): state is Matching<St, T> {
  const prefix: readonly string[] = typeof path === "string" ? [path] : path;
  // A prefix longer than the path reads past its end (undefined), so it never matches.
  return prefix.every((name, i) => state.phase[i] === name);
}

/** The merged local of the active path (what a leaf handler sees as `ctx.local`), typed by the state. */
export function localOf<St extends { readonly locals: readonly unknown[] }>(state: St): MergeLocals<St["locals"]>;
export function localOf(state: { readonly locals: readonly unknown[] }): unknown {
  return mergeLocals(state.locals);
}

/**
 * The local a handler at a level sees: the levels' locals spread root first (inner keys win), null
 * levels skipped. A single non-null local is passed as it is; none gives null.
 */
export function mergeLocals(locals: readonly unknown[]): unknown {
  const present = locals.filter((local) => local !== null);
  if (present.length < 2) return present[0] ?? null;
  // Every one is non-null here: an object that is not an array can be spread.
  if (!present.every((local) => typeof local === "object" && !Array.isArray(local))) {
    throw new ActorKitError(
      "invalid_local",
      "Nested states merge their locals, so each local on a path must be an object (declare it with z.object).",
    );
  }
  return Object.assign({}, ...present);
}
