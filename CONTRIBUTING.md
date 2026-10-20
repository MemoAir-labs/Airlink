# Contributing to AirLink

Thanks for helping. AirLink is a set of npm workspaces: `packages/*` are the room's building
blocks and `apps/*` are what runs them. Start with the [README](README.md) and
[docs/architecture.md](docs/architecture.md); each package has its own README.

## Setup

Node 24 (`.nvmrc`), npm and Docker.

```sh
npm install
docker compose -f apps/airlink/docker-compose.yml up -d postgres
docker compose -f apps/airlink/docker-compose.yml exec postgres createdb -U airlink airlink_test
```

## Checks

Run these before opening a pull request; CI runs the same ones.

```sh
npm run typecheck
npm run lint
TEST_LIVE_DATABASE_URI=postgres://airlink:airlink@127.0.0.1:5434/airlink_test npm test
npm run licenses
```

Changes to the server, a doc kind or the bench also rerun the benchmark (`npm run bench`, see the
README): a keystroke p99 above 50 ms or a cold start above 1 s is a regression.

## How the code is laid out

- Every update and event carries an `actor`, and agents go through the same `authorize()` as
  people. Never give an agent a path that skips its token.
- Postgres is never on the keystroke path; durable state lives there, the in-memory docs are a
  cache.
- A new doc kind is a package with a Y.Doc model, ops, `read*`, `restore*`, `diff*` and one test
  file, routed through the server's single runner.
- Tests go where logic can break silently (CRDT ops, suggestions, persistence, auth, routing),
  one focused file per module. Routes that only forward and UI layout do not need them.
- No `console.*` in library code, no `as` casts, no enums, camelCase constants, files end with a
  newline. `npm run lint` covers the formatting.

## Documentation

Docs live in `docs/`, one README per package, and `llms.txt` indexes them. A change to an
environment variable, port, command or behaviour updates the doc that states it in the same pull
request. Write plainly: short sentences, and nothing that is not built (say "coming" instead).

## Pull requests

One change per pull request, with a description of what it does and how you checked it (the
commands above, plus screenshots for UI). By contributing you agree your work is released under
the [MIT licence](LICENSE).

## Releasing

Versions move only in the monorepo this repository is exported from; this repository publishes.

1. Describe each change with `npm run changeset` (Changesets, behind a wrapper that also works in
   the monorepo, which has no `package-lock.json` for Changesets to find the workspace root by).
   Every published package carries one version, so a release moves them all together.
2. To cut a release, run `npm run changeset -- version` there in a commit `release(live): vX.Y.Z`,
   export the tree with `scripts/export.sh`, and push it to `main` here.
3. `.github/workflows/release.yml` publishes every version npm does not have yet (with provenance),
   tags `vX.Y.Z`, writes the GitHub release, and pushes the five images to GHCR for `linux/amd64`
   and `linux/arm64`. Pending changesets publish as `next`, and nothing is committed back.

The workflow publishes through npm trusted publishing (OIDC), so the repository holds no npm token.
npm can only trust a workflow for a package that already exists, so the first release, `v0.1.0`,
is published by hand, from an export tree, by an owner of the `memo-air` npm organization:

1. `sh scripts/prepublish-check.sh <empty folder>` (or `scripts/export.sh` and the checks it runs),
   then, in that folder, `npm run pack:all` and `node scripts/check-packs.mjs`.
2. `npm login`, then publish each tarball with `npm publish .packs/<tarball> --access public`,
   each package after the ones it depends on, and `create-airlink` last.
   `npx changeset publish --no-git-tag` does the same in dependency order from the package folders.
3. Tag `v0.1.0` and write its GitHub release with `node scripts/release-notes.mjs 0.1.0`.
4. For every published package on npmjs.com, open Settings, add a trusted publisher (GitHub
   Actions, organization `MemoAir-labs`, repository `Airlink`, workflow `release.yml`), and set
   publishing access to require two-factor authentication and disallow tokens.
5. Make the five GHCR packages public once the workflow has pushed them.

A package added after `v0.1.0` gets the same treatment before the release that includes it: publish
it once by hand and add its trusted publisher, or the workflow's publish fails on it.
