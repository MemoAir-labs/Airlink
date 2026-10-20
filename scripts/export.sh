#!/bin/sh
# Writes the open-source repository into an empty folder: the committed tree under live/ at HEAD
# (nothing uncommitted, no history), plus the biome config a nested folder of the monorepo cannot
# carry, and a lockfile seeded from the monorepo's so it installs the versions already tested. Then
# installs it from scratch and runs every check CI runs, against npm packages only.
# Usage: [AIRLINK_EXPORT_REF=<tree-ish>] scripts/export.sh <empty folder> [--no-checks]
set -eu

dest=${1:?usage: scripts/export.sh <empty folder> [--no-checks]}
here=$(cd "$(dirname "$0")/.." && pwd)
top=$(git -C "$here" rev-parse --show-toplevel)
prefix=$(git -C "$here" rev-parse --show-prefix)
ref=${AIRLINK_EXPORT_REF:-HEAD}

mkdir -p "$dest"
dest=$(cd "$dest" && pwd)
if [ -n "$(ls -A "$dest")" ]; then
  echo "export: $dest is not empty" >&2
  exit 1
fi

# A tree path in `<ref>:<path>` resolves from the top level, so archive from there.
git -C "$top" archive --format=tar "$ref:${prefix%/}" | tar -x -C "$dest"

cat > "$dest/biome.json" <<'EOF'
{
  "$schema": "https://biomejs.dev/schemas/2.5.1/schema.json",
  "root": true,
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": {
    "ignoreUnknown": true,
    "includes": [
      "**/*.{js,jsx,ts,tsx,mjs}",
      "**/package.json",
      "!!**/node_modules",
      "!!**/dist",
      "!!**/package-lock.json"
    ]
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineEnding": "lf",
    "lineWidth": 80,
    "expand": "auto"
  },
  "linter": {
    "rules": {
      "preset": "none",
      "correctness": {
        "noUnusedImports": { "fix": "safe", "level": "error" },
        "noUnusedVariables": "error"
      },
      "style": {
        "useBlockStatements": "error",
        "useImportType": "error"
      },
      "suspicious": { "noImportCycles": "error" }
    }
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "double",
      "jsxQuoteStyle": "double",
      "trailingCommas": "es5",
      "semicolons": "always",
      "arrowParentheses": "always"
    }
  }
}
EOF

echo "export: wrote $(find "$dest" -type f | wc -l | tr -d ' ') files to $dest"
[ "${2:-}" = "--no-checks" ] && exit 0

[ -n "$(ls -A "$dest")" ] || { echo "export: nothing to scan in $dest" >&2; exit 1; }
# Secrets, in the tree exactly as it would be pushed, before anything is installed into it.
docker run --rm -v "$dest:/scan:ro" ghcr.io/gitleaks/gitleaks:v8.28.0 dir /scan --redact --no-banner

node "$here/scripts/seed-lockfile.mjs" "$here/../package-lock.json" "$dest"

cd "$dest"
npm install --no-audit --no-fund
git init -q
git add -A
npm run typecheck
npm run lint
npm run licenses
echo "export: install, type-check, lint and licences pass; run the tests with TEST_LIVE_DATABASE_URI set"
