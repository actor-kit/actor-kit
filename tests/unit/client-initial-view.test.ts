// @vitest-environment jsdom
/**
 * actorClient(...).create({ initialView }) validates the boot view against the view schema (the
 * caller's role's, for a contract) and refuses a mismatch with a coded error (ADR-018 C style).
 */
import { actorClient, InitialViewError } from "@actor-kit/client";
import { ActorKitError, enumOf, schema, string, uint32 } from "@actor-kit/core";
import { describe, expect, it } from "vitest";

const Owner = schema({ count: uint32, secret: string });
const Viewer = schema({ count: uint32, phase: enumOf(["lobby", "playing"]) });
const contract = {
  name: "counter",
  def: {
    roles: { owner: () => true, viewer: () => true },
    views: { owner: { schema: Owner }, viewer: { schema: Viewer } },
  },
};

const base = { path: "/api/counter/c1", host: "example.com" };

function refusal(create: () => unknown): InitialViewError {
  try {
    create();
  } catch (error) {
    if (error instanceof InitialViewError) return error;
    throw error;
  }
  throw new Error("expected create() to throw");
}

describe("create({ initialView }) with a schema", () => {
  it("accepts a valid view", () => {
    const client = actorClient(Owner).create({ ...base, initialView: { count: 1, secret: "s" } });
    expect(client.view).toEqual({ count: 1, secret: "s" });
  });

  it("refuses an invalid one with a code, the issues and a docs URL", () => {
    const error = refusal(() => actorClient(Owner).create({ ...base, initialView: JSON.parse('{"count":-1}') }));
    expect(error).toMatchObject({
      name: "InitialViewError",
      code: "invalid_initial_view",
      docs: "https://actorkit.dev/errors/invalid_initial_view/",
      message:
        "actorClient().create: initialView does not match the view schema (count: expected an integer from 0 to 4294967295; secret: expected a string). Pass the view the server rendered for this caller.",
      issues: [
        { message: "expected an integer from 0 to 4294967295", path: ["count"] },
        { message: "expected a string", path: ["secret"] },
      ],
    });
  });
});

describe("create({ initialView }) with the typed client from roles and views (ADR-018)", () => {
  it("validates through the same schemas, naming how the client was built", () => {
    const parts = actorClient<typeof contract & { def: { roles: unknown; views: unknown } }>({
      roles: contract.def.roles,
      views: contract.def.views,
    });
    expect(() => parts.create({ ...base, initialView: { count: 1, secret: "s", role: "owner" } })).not.toThrow();
    const error = refusal(() => parts.create({ ...base, initialView: { count: 1, role: "owner" } }));
    expect(error.message).toBe(
      'actorClient({ roles, views }).create: initialView does not match the "owner" view (secret: expected a string). Pass the view the server rendered for this caller.',
    );
  });

  it("refuses with an ActorKitError carrying the issues as details", () => {
    const error = refusal(() => actorClient(Owner).create({ ...base, initialView: {} }));
    expect(error).toBeInstanceOf(ActorKitError);
    expect(error.details).toEqual(error.issues);
  });
});

describe("create({ initialView }) with a contract", () => {
  it("validates against the role the view names", () => {
    const client = actorClient(contract).create({ ...base, initialView: { count: 1, phase: "lobby", role: "viewer" } });
    expect(client.role).toBe("viewer");
    const error = refusal(() =>
      actorClient(contract).create({ ...base, initialView: { count: 1, phase: "lobby", role: "owner" } }),
    );
    expect(error.message).toBe(
      'actorClient(counter).create: initialView does not match the "owner" view (secret: expected a string). Pass the view the server rendered for this caller.',
    );
  });

  it("accepts a view without a role that matches any role's view", () => {
    expect(() => actorClient(contract).create({ ...base, initialView: { count: 1, phase: "playing" } })).not.toThrow();
  });

  it("refuses a view without a role that matches none, naming the first role's issues", () => {
    const error = refusal(() => actorClient(contract).create({ ...base, initialView: { count: 1 } }));
    expect(error.message).toBe(
      'actorClient(counter).create: initialView matches none of the views ("owner", "viewer"); against "owner": secret: expected a string. Pass the view the server rendered for this caller.',
    );
    expect(error.issues).toEqual([{ message: "expected a string", path: ["secret"] }]);
  });

  it("accepts a view without a role when some role has no view schema (it may be that role's)", () => {
    const partly = {
      name: "partly",
      def: { roles: { owner: () => true, guest: () => true }, views: { owner: { schema: Owner } } },
    };
    expect(() => actorClient(partly).create({ ...base, initialView: { anything: 1 } })).not.toThrow();
  });

  it("refuses null and a role that is not a string, as views without a role", () => {
    expect(refusal(() => actorClient(contract).create({ ...base, initialView: null })).message).toContain(
      'matches none of the views ("owner", "viewer"); against "owner": (root): expected an object.',
    );
    expect(refusal(() => actorClient(contract).create({ ...base, initialView: { count: 1, role: 5 } })).issues).toEqual(
      [{ message: "expected a string", path: ["secret"] }],
    );
  });

  it("checks nothing for a contract with neither roles nor view schemas", () => {
    const bare = { name: "bare", def: { views: { any: { fn: () => 1 } } } };
    expect(() => actorClient(bare).create({ ...base, initialView: 42 })).not.toThrow();
  });

  it("checks nothing for a role without a view schema, or a contract without any", () => {
    const loose = { name: "loose", def: { roles: { any: () => true }, views: {} } };
    expect(() => actorClient(loose).create({ ...base, initialView: "anything" })).not.toThrow();
    expect(() =>
      actorClient(contract).create({ ...base, initialView: { role: "guest", whatever: true } }),
    ).not.toThrow();
  });
});
