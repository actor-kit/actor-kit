# Upgrading to 0.3

One note per breaking or behaviour change. 0.3 is a pre-release under the `next` tag.

## Published events carry `position` (ADR-019 E)

Every message `publish` sends to a Queue now has a `position` field: that actor's published events
numbered 1, 2, 3... with no gaps. Consumers that validate the body strictly must accept the new field.
Positions start at 1 for actors that publish after the upgrade (the counter starts at 0 when migration
`0018_publish_position` runs); events published before it have no position. Consumers that need
ordering should use `@actor-kit/projection`, which applies events in `position` order.

## Delta float tolerance applies to float fields only (ADR-019 C)

Deltas used to treat any two numbers within 1e-6 as unchanged. Only `float32` and `float64` fields do
now; a `json`, enum or integer value that changes by less than 1e-6 is sent.

## `create({ initialView })` now validates the view against the role's schema

`actorClient(contract).create()` checks `initialView` against the view schema of the role the view
names (`initialView.role`); a view without a role must match one role's schema (unless some role has
no schema). `actorClient(schema).create()` checks it against the schema. A mismatch throws
`InitialViewError` with `code: "invalid_initial_view"`, a message naming each wrong field, a `docs` URL
and the `issues`. Pass the view the server rendered for this caller; a placeholder no longer works.
