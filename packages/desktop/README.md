# @memo-air/desktop

The shared desktop: its Y.Doc shape and the providers that run the machine.

## Main exports

- `.` — `initDesktop`, `readDesktopState`, `setDesktopStatus`, `recordAction`, `readActions`.
- `./session` — `selfHostedDesktopProvider` (the Docker desktop in `docker/desktop.Dockerfile`),
  `e2bDesktopProvider` (E2B Desktop), and the `DesktopProvider` / `DesktopSession` contract
  another provider implements. `DesktopBusy` is thrown when the one Docker desktop is held.

## Used by

`@memo-air/server` runs desktop objects, `apps/airlink` picks the provider, and
`@memo-air/react` draws the view. See [docs/desktop.md](../../docs/desktop.md).

> [!NOTE]
> Not yet published to npm. It installs from this repository's workspaces; publishing is coming.
