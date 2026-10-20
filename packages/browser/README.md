# @memo-air/browser

The shared browser: its Y.Doc shape, the page outline agents read, and the session that drives
Chromium.

## Main exports

- `.` — `initBrowser`, `readBrowserState`, `recordVisit`, `readVisits`; `outlineFromAxTree`,
  `formatOutline`, `diffOutline` (the page as an accessibility outline); `createInputMux` (who
  holds input); `checkUrl`, `isBlockedHost` (private and internal addresses refused).
- `./session` — `createBrowserSession`, `connectCdp`, `nekoPoolProvider`,
  `parseNekoInstances`, `cdpEndpointProvider`, `createPinningProxy`.
- `./video` — `connectBrowserVideo`, the viewer side of neko's WebRTC stream.

## Used by

`@memo-air/server` runs browser objects with it, `apps/airlink` starts the neko pool and the
pinning proxy, and `@memo-air/react` draws the view.

> [!NOTE]
> Not yet published to npm. It installs from this repository's workspaces; publishing is coming.
