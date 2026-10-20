# @memo-air/server

live-server: a Hocuspocus server for every object kind, with persistence, agent ops, presence,
turns and metrics.

## Main exports

- `createLiveServer({ databaseUrl, jwtSecret, port, address, decide, onTurn, onSpoken,
  browserProvider, desktopProvider, media, redisUrl, logger })`.
- `turnWebhook({ url, jwtSecret })` — deliver deserved turns over HTTP, signed.
- `systemOneProvider` — re-exported from `@memo-air/decide`.

## Used by

`apps/airlink` runs it in process; `apps/live-server` runs it alone. See
[docs/architecture.md](../../docs/architecture.md#live-server) and
[docs/self-hosting.md](../../docs/self-hosting.md#live-server-on-its-own).

> [!NOTE]
> Not yet published to npm. It installs from this repository's workspaces; publishing is coming.
