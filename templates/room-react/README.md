# room-react

A React page with a live doc, a sheet and a canvas in one shared space, with presence and cursors,
on a standalone live-server. Your own code is a token endpoint and one page.

## Run it

```sh
docker compose up -d     # Postgres and live-server on 127.0.0.1:3020
npm run dev              # http://localhost:5173
```

Open it in two tabs to see two people's cursors. `create-airlink` wrote a random `LIVE_JWT_SECRET`
into `.env`; docker compose gives live-server the same value, and live-server checks every token
with it.

## What's inside

| File | What it does |
|---|---|
| `server.ts` | Signs a five-minute write token for one of the room's docs with `signLiveToken` from `@memo-air/protocol/tokens`, served at `/api/token` by Vite's dev server. Replace it with your own auth: as written, anyone who reaches it gets in under any name. |
| `src/room.ts` | The room's objects: a space, and the doc, sheet and canvas placed in it. |
| `src/App.tsx` | `createLiveServerHost` and `LiveSpaceView`, drawing each object with `@memo-air/react/doc`, `/sheet` and `/canvas`. |
| `src/styles.css` | Tailwind, the views' theme, and an `@source` pointing at `node_modules/@memo-air/react/dist` so the views' classes get generated. If your package manager hoists `@memo-air/react` elsewhere (a monorepo workspace, say), point `@source` at where it actually lives. |
| `docker-compose.yml` | Postgres and `ghcr.io/memoair-labs/airlink-live-server`, pinned to this template's release. |

## Next

- [`@memo-air/react`](https://memoair-labs.github.io/Airlink/docs/packages/react/): the other views and what each needs.
- [Self-hosting](https://memoair-labs.github.io/Airlink/docs/self-hosting/): live-server's environment variables.
- [Security](https://memoair-labs.github.io/Airlink/docs/security/): tokens and what they allow.
