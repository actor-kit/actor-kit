# ADR 023: The role tag on client views

**Date**: 2026-10-18
**Status**: Proposed (found migrating little-vigilante; for Jon to decide)
**Depends on**: ADR-011 (`LinkedView`), ADR-018 B (typed clients)

## Context

`actorContext(Contract)`, `actorContext<typeof Contract>()` and `actorClient(Contract)` type a client's
view as `LinkedView<Contract>`: the union of the roles' view data, each tagged with its role
(`{ role: "tv" } & TvView | { role: "player" } & PlayerView`). ADR-011 made that type for links, and
link pushes do carry the role.

A client's frames do not. A binary snapshot names the role by index in the frame header, a JSON
snapshot in its `role` field, and the client keeps it in `client.role`, not in the view. So after the
first frame, `view.role` is `undefined` at runtime while the type says `"tv" | "player"`. Code that
narrows on it type-checks and then silently takes the wrong branch. Only an `initialView` that was
given a role keeps one, until the first frame replaces it.

Little-vigilante doesn't read it: its screens branch on a role inside its own view. It had to put a
role into `initialView` to satisfy the type. Codebreakers doesn't read it either. Nothing failed, which
is how the gap stayed hidden.

## Options

### A. Tag views at runtime (the type stays)

The client sets `role` on every view it applies, from the frame (binary role index → role name, JSON
`role`). It strips the tag before computing the checksum it reports in `__reconnect`, so the reconnect
ack still works. Contract clients only: a client built from one schema has no roles, and its view type
has no tag.

- Pro: `view.role` is what the type says; narrowing works.
- Con: a type-only `actorContext<typeof C>()` on JSON frames knows the role (JSON carries it), but a
  binary frame needs the role names, which only the contract value has.

### B. Drop the tag from the client's view type

`useView()` and `client.view` are the union of the roles' view data with no tag. The role is
`useRole()` / `client.role`, which is already correct.

- Pro: no runtime change; the type stops lying.
- Con: a breaking type change for any app that narrows on `view.role` (none of the OGS games do), and
  `initialView` loses its role (`client.role` is then seeded from somewhere else, such as an option).

## Decision

Pending. A is less disruptive for apps; B is simpler. Either way, a type test should pin it, so the
type and the runtime cannot drift apart again.
