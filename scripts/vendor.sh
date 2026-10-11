#!/usr/bin/env bash
# Build every package, then pack each one into <dir> as <name>-<version>-<short commit>.tgz
# (Run Set Jimmy feedback 17). See scripts/vendor.mts and docs/vendoring.md.
#
#   scripts/vendor.sh ../my-app/vendor/actor-kit
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: scripts/vendor.sh <dir>" >&2
  exit 1
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
pnpm -C "$root" build >/dev/null
node "$root/scripts/vendor.mts" "$1"
