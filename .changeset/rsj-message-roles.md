---
"@actor-kit/core": minor
"@actor-kit/worker": minor
---

Roles on messages: `message(schema, { roles: ["host"], guard?, handler })` (also `kit.message` and `kit.in(phase).message`) limits who may send a message, top-level or in a state. Any other role is refused with the new `wrong_role` refusal (`expected`: the roles, `details.role`: the caller's) before the payload is parsed or the guard runs; a role name the actor does not declare is a definition error. A message without `roles` is still accepted from every role (state messages included), as now documented. `guard` is optional in the object form.
