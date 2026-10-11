// @vitest-environment jsdom
/**
 * The merge of the zod-free client (`actorClient<typeof C>({ roles, views })`, Run Set Jimmy feedback) with
 * initialView validation (ADR-019 parallel work): a client built from the parts validates the boot view
 * the same way and names itself `{ roles, views }` in the error.
 */
import { actorClient, InitialViewError } from "@actor-kit/client";
import { schema, uint32 } from "@actor-kit/core";
import { describe, expect, it } from "vitest";

const View = schema({ count: uint32 });
const parts = { roles: { owner: () => true }, views: { owner: { schema: View } } };
type Contract = { name: "counter"; def: typeof parts };

describe("actorClient({ roles, views }).create({ initialView })", () => {
  it("validates the boot view against the role's schema", () => {
    const client = actorClient<Contract>(parts).create({
      path: "/c",
      host: "h",
      initialView: { count: 1, role: "owner" },
    });
    expect(client.view).toMatchObject({ count: 1 });
    let caught: unknown;
    try {
      actorClient<Contract>(parts).create({
        path: "/c",
        host: "h",
        initialView: JSON.parse('{"count":-1,"role":"owner"}'),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InitialViewError);
    expect(caught).toMatchObject({
      message: expect.stringMatching(/^actorClient\(\{ roles, views \}\)\.create: initialView/),
    });
  });
});
