#!/bin/sh
# Type-checks every package and app with its own tsconfig (Airlink's web app has a second one).
set -e
cd "$(dirname "$0")/.."
for config in packages/*/tsconfig.json apps/*/tsconfig.json apps/*/tsconfig.web.json templates/*/tsconfig.json; do
  [ -f "$config" ] || continue
  echo "tsgo $config"
  npx tsgo --noEmit -p "$config"
done
