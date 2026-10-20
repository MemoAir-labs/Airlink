#!/bin/sh
# J.10's pre-publish checklist (spec: "Pre-publish checklist"), every item a machine can check, run
# from the monorepo against a fresh export. The security review, the npm org's owner and the
# in-browser template passes stay with people; the script prints them at the end.
# Needs: Docker, the compose Postgres on 127.0.0.1:5434, and Node 22 and 24 under ~/.nvm. Memoair is
# not checked here: the public repo does not contain it, so its own CI owns its @memo-air consumers.
# Usage: [AIRLINK_EXPORT_REF=<tree-ish>] sh scripts/prepublish-check.sh <empty folder>
set -eu

dest=${1:?usage: scripts/prepublish-check.sh <empty folder>}
here=$(cd "$(dirname "$0")/.." && pwd)
node22=$(ls -d "$HOME"/.nvm/versions/node/v22.* | sort -V | tail -1)/bin
node24=$(ls -d "$HOME"/.nvm/versions/node/v24.* | sort -V | tail -1)/bin
export PATH="$node24:$PATH"
testDatabase=postgres://airlink:airlink@127.0.0.1:5434/airlink_test

mkdir -p "$dest"
dest=$(cd "$dest" && pwd)
scratch=$(mktemp -d)
live=
cleanup() {
  [ -z "$live" ] || kill "$live" 2>/dev/null || true
  rm -rf "$scratch"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

step() {
  printf '\n== %s\n' "$1"
}

step "Items 2, 3, 6: export, gitleaks over the tree, clean install, type-check, biome, licences"
sh "$here/scripts/export.sh" "$dest"
cd "$dest"

step "Items 4, 6, 8: tests (boundary, strip smoke, every workspace)"
TEST_LIVE_DATABASE_URI=$testDatabase npm test

step "Item 6: bench smoke (keystroke fan-out, 10 s)"
if curl -sf localhost:3020/healthz >/dev/null; then
  echo "port 3020 is already serving; stop it so the bench tests this export" >&2
  exit 1
fi
LIVE_DATABASE_URL="$testDatabase" LIVE_JWT_SECRET=checklist PORT=3020 node apps/live-server/src/main.ts > live-server.log 2>&1 &
live=$!
for _ in $(seq 1 30); do curl -sf localhost:3020/healthz >/dev/null && break; sleep 1; done
LIVE_JWT_SECRET=checklist npm -w @memo-air/bench run bench -- --server ws://localhost:3020 --rooms 1 --clients 2 --seconds 10
kill "$live"
live=

step "Items 2, 3, 5: pack; contents, LICENSE, the LiveKit notice, exports targets, publint, attw, sizes"
npm run pack:all
node scripts/check-packs.mjs

step "Item 2: secrets in the tarballs"
for tarball in "$dest"/.packs/*.tgz; do
  name=$(basename "$tarball" .tgz)
  mkdir "$scratch/$name"
  tar -xzf "$tarball" -C "$scratch/$name"
done
[ -n "$(ls -A "$scratch")" ] || { echo "no tarballs to scan" >&2; exit 1; }
docker run --rm -v "$scratch:/scan:ro" ghcr.io/gitleaks/gitleaks:v8.28.0 dir /scan --redact --no-banner

step "Item 4: dist under Node 22 and 24"
PATH="$node22:$PATH" node scripts/consumer-smoke.mjs
node scripts/consumer-smoke.mjs

step "Item 7: templates scaffolded from the packed create-airlink, type-checked, tested, built"
node scripts/template-smoke.mjs

step "Item 8: names"
if npm view create-airlink name >/dev/null 2>&1; then
  echo "create-airlink is taken on npm" >&2
  exit 1
fi
echo "create-airlink is still free"

step "Left to people"
cat <<'EOF'
- Item 1: a security review of protocol/tokens, live-server's auth path, the bridge's harness and
  tool boundaries, the runner and desktop control servers, and the templates' token endpoints, by
  a context that did not write J.10.
- Item 7: docker compose up for room-react and full against locally built images, npm run dev, and
  an in-browser pass for each.
- Item 8: the npm org "memo-air" exists and the owner owns it.
- J.6: make the five GHCR packages public after their first push; set trusted publishers for all
  22 npm packages after the first publish from the owner's machine.
- Releases after v0.1.0: `changeset version` and `changeset publish` run in MemoAir-labs/Airlink's
  release workflow only, where changelog-github can see the commits.
EOF
