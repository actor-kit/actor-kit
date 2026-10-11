# Vendoring the packages

An app that tests actor-kit before it is published installs the packages from tarballs. pnpm records a
tarball by its name, so a rebuilt tarball with the same name looks unchanged to the lockfile (Run Set Jimmy
feedback 17). Two things prevent that:

- **Versions are pre-releases.** Every package is versioned `0.3.0-next.N` (all nine share one version).
  Bump `N` in every `packages/*/package.json` for each build you hand out as a release candidate;
  `pnpm changeset version` at the release turns the pending changesets into `0.3.0`.
- **`scripts/vendor.sh <dir>`** builds every package, then packs each one into `<dir>` as
  `<name>-<version>-<short commit>.tgz`, for example `actor-kit-core-0.3.0-next.0-4181811.tgz`. The version
  inside the tarball carries the same suffix, and each `workspace:*` dependency on another actor-kit
  package is pinned to that same build. A working tree with uncommitted changes adds `-dirty`
  (`...-4181811-dirty.tgz`): commit first if you want the name to identify the build. The repository is
  not modified: each package is staged in a temporary directory and packed there.

```bash
# in actor-kit
scripts/vendor.sh ../my-app/vendor/actor-kit
# pack without building (what is already in each dist/)
node scripts/vendor.mts ../my-app/vendor/actor-kit
```

In the app, point every actor-kit package at its tarball, including the ones it only gets through other
actor-kit packages, so pnpm resolves the pinned internal versions to the same files:

```json
{
  "dependencies": {
    "@actor-kit/client": "file:vendor/actor-kit/actor-kit-client-0.3.0-next.0-4181811.tgz",
    "@actor-kit/worker": "file:vendor/actor-kit/actor-kit-worker-0.3.0-next.0-4181811.tgz"
  },
  "pnpm": {
    "overrides": {
      "@actor-kit/core": "file:vendor/actor-kit/actor-kit-core-0.3.0-next.0-4181811.tgz",
      "@actor-kit/client": "file:vendor/actor-kit/actor-kit-client-0.3.0-next.0-4181811.tgz",
      "@actor-kit/worker": "file:vendor/actor-kit/actor-kit-worker-0.3.0-next.0-4181811.tgz"
    }
  }
}
```

Re-vendoring writes new names; update the paths (and delete the old tarballs), then `pnpm install`.

`tests/unit/vendor.test.ts` checks the versions, the names, the manifest rewrite, and a real pack of
every package.
