---
"@actor-kit/client": minor
---

`actorClient<typeof Contract>({ roles, views })` builds a typed client from just the contract's zod-free roles and view schemas, with the contract imported as a type only, so zod and the message handlers stay out of browser bundles. Docs: a recipe for keeping zod out of the client, a note that decoded views carry no role (`client.role`), and upgrade notes for `wrangler rollback` and reading a `wrangler dev` journal with `node:sqlite`.
