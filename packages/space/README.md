# @memo-air/space

A channel's space: one Y.Map of objects placed as windows. People arrange through their own
connection; agents through `space-ops`. An agent never moves or resizes what a person arranged,
and closing a window destroys nothing.

## Main exports

- `placeObject`, `moveObject`, `resizeObject`, `removeObject`, `bringToFront`,
  `setWindowState` (`open`, `minimized`, `maximized`).
- The bin: `binObject`, `readBinned`, `forgetObject`.
- `readSpace`, `readHidden`, `restoreSpace`, `diffSpaces`, `placedDocNames`.

## Used by

`@memo-air/server` (space ops), `@memo-air/bridge` (`arrange_windows`) and
`@memo-air/react` (the desktop view).

> [!NOTE]
> Not yet published to npm. It installs from this repository's workspaces; publishing is coming.
