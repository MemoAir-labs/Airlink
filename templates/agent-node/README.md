# agent-node

An agent in one Node file, no framework: it joins a room's chat with `@memo-air/client`, answers
when it is mentioned with one model call (`@earendil-works/pi-ai`, on whichever key is in `.env`),
and keeps a running summary doc through live-server's ops route with `@memo-air/agent`.

## Run it

Needs Node 22.18 or later (it runs `agent.ts` with Node's type stripping) and Docker.

```sh
docker compose up -d                             # Postgres and live-server on 127.0.0.1:3020
npm start                                        # the agent, in room-chat
npm run say -- "@Scout what can you do?"         # in another terminal: ask it something
```

## What's inside

| File | What it does |
|---|---|
| `agent.ts` | Signs its own doc tokens with `LIVE_JWT_SECRET`, joins `room-chat` as an agent peer, answers mentions, and appends each exchange to `room-summary`. |
| `say.ts` | Posts one message as a person and prints the agent's reply. |
| `docker-compose.yml` | Postgres and `ghcr.io/memoair-labs/airlink-live-server`, pinned to this template's release. |

## Next

- [Agents](https://memoair-labs.github.io/Airlink/docs/agents/): how AirLink routes work to agents.
- [`@memo-air/agent`](https://memoair-labs.github.io/Airlink/docs/packages/agent/): every ops call an agent can make.
