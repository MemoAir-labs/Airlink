#!/bin/sh
# Runs Changesets from this directory. Changesets takes a directory for an npm workspace root only
# when it holds a package-lock.json; the public repository has one, the monorepo AirLink is exported
# from does not, so a placeholder stands in for the length of the command there. A placeholder left
# by a killed run is exactly `{}`; a real lockfile never is, and is never touched.
set -eu
cd "$(dirname "$0")/.."
if [ -f package-lock.json ] && [ "$(cat package-lock.json)" = "{}" ]; then
  rm package-lock.json
fi
if [ ! -e package-lock.json ]; then
  printf '{}\n' > package-lock.json
  trap 'rm -f package-lock.json' EXIT INT TERM
fi
npx changeset "$@"
