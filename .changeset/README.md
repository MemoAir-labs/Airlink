# Changesets

Run `npx changeset` to describe a change, and pick the packages it touches. Every published
package carries one version, so a release moves them all. Versions move only in the monorepo
AirLink is exported from (`npx changeset version`, committed as `release(live): vX.Y.Z`); this
repository's release workflow publishes what npm does not have yet, and pending changesets as `next`.
