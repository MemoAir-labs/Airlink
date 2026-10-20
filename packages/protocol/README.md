# @memo-air/protocol

What every route and client share: token claims, `authorize()` and the zod schemas for every op
and response.

## Main exports

- `.` — `liveTokenClaimsSchema`, `liveActorSchema`, `liveAccessSchema` (`read`, `suggest`,
  `write`), `authorize`, `allows`, `systemActor`; the op and response schemas for rich text,
  sheets, canvases, slides, chat, space, browser, desktop and media.
- `./tokens` — `signLiveToken`, `verifyLiveToken`, and the service and watch token pairs.

## Used by

Every other package and app. `src/boundary.test.ts` also guards the repository: every package is
MIT and imports nothing from outside it.

> [!NOTE]
> Not yet published to npm. It installs from this repository's workspaces; publishing is coming.
