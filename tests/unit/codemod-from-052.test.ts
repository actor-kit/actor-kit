/**
 * The 0.52 → 0.3 codemod (docs/migrating-from-0.52.md §7): the mechanical part of a migration,
 * as pure functions. The machine rewrite is not mechanical; the codemod lists what is left.
 */
import { describe, expect, it } from "vitest";
import {
  manualWork,
  migrateManifest,
  renameTokenOptions,
  rewriteImports,
  tagOf,
  tarballsFor,
  usesOf,
} from "../../scripts/migrate-from-0.52.mts";

const TAG = "0.3.0-next.0-abc1234";
const file = (pkg: string) => `file:vendor/actor-kit/actor-kit-${pkg}-${TAG}.tgz`;

describe("rewriteImports", () => {
  it("moves each actor-kit subpath to its 0.3 package", () => {
    const source = [
      'import { createActorKitRouter, createMachineServer } from "actor-kit/worker";',
      "import { createActorKitContext } from 'actor-kit/react';",
      'import { createAccessToken } from "actor-kit/server";',
      'import { createActorKitMockClient } from "actor-kit/test";',
      'import { withActorKit } from "actor-kit/storybook";',
    ].join("\n");
    const result = rewriteImports(source);
    expect(result.source).toBe(
      [
        'import { createActorKitRouter, createMachineServer } from "@actor-kit/worker";',
        "import { createActorKitContext } from '@actor-kit/react';",
        'import { createAccessToken } from "@actor-kit/worker/token";',
        'import { createActorKitMockClient } from "@actor-kit/test";',
        'import { withActorKit } from "@actor-kit/storybook";',
      ].join("\n"),
    );
    expect(result.rewritten).toBe(5);
  });

  it("leaves the bare actor-kit import (its types have no 0.3 counterpart) and other packages alone", () => {
    const source = 'import type { Caller } from "actor-kit";\nimport { z } from "zod";\nconst s = "actor-kit/worker";';
    expect(rewriteImports(source)).toEqual({ source, rewritten: 0 });
  });

  it("rewrites export-from too", () => {
    expect(rewriteImports('export { x } from "actor-kit/worker";').source).toBe(
      'export { x } from "@actor-kit/worker";',
    );
  });
});

describe("renameTokenOptions", () => {
  it("signingKey becomes secret where createAccessToken is imported", () => {
    const source =
      'import { createAccessToken } from "@actor-kit/worker/token";\nawait createAccessToken({ signingKey: env.ACTOR_KIT_SECRET, actorId });';
    expect(renameTokenOptions(source)).toEqual({
      source:
        'import { createAccessToken } from "@actor-kit/worker/token";\nawait createAccessToken({ secret: env.ACTOR_KIT_SECRET, actorId });',
      renamed: 1,
    });
  });

  it("leaves a file that does not import createAccessToken alone", () => {
    const source = "const o = { signingKey: k };";
    expect(renameTokenOptions(source)).toEqual({ source, renamed: 0 });
  });
});

describe("manualWork", () => {
  it("lists every 0.52 symbol, xstate import and bare actor-kit import with its line and a hint", () => {
    const source = [
      'import type { Caller, ActorKitEnv } from "actor-kit";',
      'import { setup } from "xstate";',
      "const S = createMachineServer({ machine });",
      "export const ctx = createActorKitContext<typeof m>('room');",
    ].join("\n");
    const work = manualWork("src/room.ts", source);
    expect(work.map((w) => `${w.line} ${w.what}`)).toEqual([
      '1 import from "actor-kit"',
      "1 Caller",
      "1 ActorKitEnv",
      "2 xstate",
      "3 createMachineServer",
      "4 createActorKitContext",
    ]);
    expect(work.every((w) => w.file === "src/room.ts" && w.hint.length > 10)).toBe(true);
  });

  it("finds nothing in 0.3 code", () => {
    expect(manualWork("a.ts", 'import { defineActor } from "@actor-kit/worker";')).toEqual([]);
  });
});

describe("migrateManifest", () => {
  const before = {
    name: "game",
    dependencies: { "actor-kit": "0.52.6", react: "^19", xstate: "^5.20.0" },
    devDependencies: { vitest: "^5" },
    pnpm: {
      overrides: { "@open-game-system/x": "file:./vendor/x.tgz" },
      patchedDependencies: { "actor-kit@0.52.6": "patches/actor-kit@0.52.6.patch" },
    },
  };

  it("swaps actor-kit for the vendored packages, pins every one, and drops the 0.52 patch", () => {
    const { manifest, notes } = migrateManifest(before, { tag: TAG, uses: { react: true, token: false } });
    expect(manifest).toEqual({
      name: "game",
      dependencies: {
        react: "^19",
        xstate: "^5.20.0",
        "@actor-kit/core": file("core"),
        "@actor-kit/worker": file("worker"),
        "@actor-kit/client": file("client"),
        "@actor-kit/react": file("react"),
      },
      devDependencies: { vitest: "^5", "@actor-kit/test": file("test") },
      pnpm: {
        overrides: {
          "@open-game-system/x": "file:./vendor/x.tgz",
          "@actor-kit/core": file("core"),
          "@actor-kit/worker": file("worker"),
          "@actor-kit/client": file("client"),
          "@actor-kit/react": file("react"),
          "@actor-kit/test": file("test"),
        },
      },
    });
    expect(notes).toEqual([
      "removed actor-kit 0.52.6",
      "removed the patch for actor-kit@0.52.6 (0.3 answers close codes itself)",
      "xstate is still a dependency: remove it once the machine is rewritten, if nothing else uses it",
    ]);
  });

  it("without React imports: core, worker and client, and always @actor-kit/test (the machine's test helpers move to simulate())", () => {
    const { manifest } = migrateManifest(
      { name: "g", devDependencies: { "actor-kit": "^0.52.5" } },
      { tag: TAG, uses: { react: false, token: false } },
    );
    expect(manifest).toEqual({
      name: "g",
      devDependencies: { "@actor-kit/test": file("test") },
      dependencies: {
        "@actor-kit/core": file("core"),
        "@actor-kit/worker": file("worker"),
        "@actor-kit/client": file("client"),
      },
      pnpm: {
        overrides: {
          "@actor-kit/core": file("core"),
          "@actor-kit/worker": file("worker"),
          "@actor-kit/client": file("client"),
          "@actor-kit/test": file("test"),
        },
      },
    });
  });

  it("keeps the manifest's key order (name, scripts, … stay where they were)", () => {
    const { manifest } = migrateManifest(
      { name: "g", private: true, scripts: { test: "vitest" }, dependencies: { "actor-kit": "0.52.6" }, pnpm: {} },
      { tag: TAG, uses: { react: false, token: false } },
    );
    expect(Object.keys(manifest)).toEqual(["name", "private", "scripts", "dependencies", "pnpm", "devDependencies"]);
  });

  it("adds jose when the game signs tokens (createAccessToken), and moves zod 3 to zod 4", () => {
    const { manifest, notes } = migrateManifest(
      { name: "g", dependencies: { "actor-kit": "0.52.6", zod: "^3.25.76" } },
      { tag: TAG, uses: { react: false, token: true } },
    );
    expect(manifest["dependencies"]).toMatchObject({ zod: "^4.6.5", jose: "^6.2.12" });
    expect(notes).toContain("zod ^3.25.76 → ^4.6.5: message schemas are zod 4 (check z.record and error messages)");
    expect(notes).toContain("added jose (createAccessToken signs actor-kit tokens with it)");
  });

  it("leaves zod 4 and an existing jose alone", () => {
    const { manifest, notes } = migrateManifest(
      { name: "g", dependencies: { "actor-kit": "0.52.6", zod: "^4.1.0", jose: "^6.0.1" } },
      { tag: TAG, uses: { react: false, token: true } },
    );
    expect(manifest["dependencies"]).toMatchObject({ zod: "^4.1.0", jose: "^6.0.1" });
    expect(notes.some((n) => n.startsWith("zod") || n.startsWith("added jose"))).toBe(false);
  });

  it("keeps other patched dependencies", () => {
    const { manifest } = migrateManifest(
      {
        name: "g",
        dependencies: { "actor-kit": "0.52.6" },
        pnpm: { patchedDependencies: { "actor-kit@0.52.6": "a", "x@1": "b" } },
      },
      { tag: TAG, uses: { react: false, token: false } },
    );
    expect(manifest["pnpm"]).toMatchObject({ patchedDependencies: { "x@1": "b" } });
  });

  it("refuses a manifest without actor-kit (nothing to migrate)", () => {
    expect(() =>
      migrateManifest({ name: "g", dependencies: {} }, { tag: TAG, uses: { react: false, token: false } }),
    ).toThrow("package.json has no actor-kit dependency: nothing to migrate");
  });
});

describe("tagOf", () => {
  it("reads the build tag from the vendored core tarball's name", () => {
    expect(tagOf(["actor-kit-worker-0.3.0-next.0-abc1234.tgz", `actor-kit-core-${TAG}.tgz`])).toBe(TAG);
  });

  it("refuses a directory without a core tarball", () => {
    expect(() => tagOf(["readme.md"])).toThrow("no actor-kit-core-<version>.tgz");
  });
});

describe("tarballsFor", () => {
  it("copies only the packages the manifest pins, not every tarball in the directory", () => {
    const files = ["core", "worker", "client", "react", "test", "studio", "storybook", "projection", "studio-cli"].map(
      (p) => `actor-kit-${p}-${TAG}.tgz`,
    );
    expect(tarballsFor(files, TAG, ["core", "worker", "client", "test"])).toEqual([
      `actor-kit-core-${TAG}.tgz`,
      `actor-kit-worker-${TAG}.tgz`,
      `actor-kit-client-${TAG}.tgz`,
      `actor-kit-test-${TAG}.tgz`,
    ]);
  });

  it("refuses a pinned package with no tarball", () => {
    expect(() => tarballsFor([`actor-kit-core-${TAG}.tgz`], TAG, ["core", "worker"])).toThrow(
      `no actor-kit-worker-${TAG}.tgz in the tarball directory`,
    );
  });
});

describe("usesOf", () => {
  it("React is used when anything imports actor-kit/react, before or after the import was moved", () => {
    expect(usesOf(['import { createActorKitContext } from "actor-kit/react";'])).toEqual({ react: true, token: false });
    expect(usesOf(["import { actorContext } from '@actor-kit/react';"])).toEqual({ react: true, token: false });
    expect(usesOf(['import { x } from "actor-kit/reactive";'])).toEqual({ react: false, token: false });
  });

  it("token signing is used when anything calls createAccessToken", () => {
    expect(usesOf(["await createAccessToken({ secret })"])).toEqual({ react: false, token: true });
  });
});
