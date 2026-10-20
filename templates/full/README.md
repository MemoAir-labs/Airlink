# full

All of AirLink in Docker, with no source code: the app with live-server inside it, Postgres,
LiveKit for calls, the shared browser, the Docker desktop and the code runner.

## Run it

Put an LLM key in `.env` (`ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`), then:

```sh
docker compose up -d     # the first pull is several GB: the browser and desktop images are large
```

Open <http://localhost:3030>, give yourself a name, and write in `#general`.

## What's inside

| Path | What it is |
|---|---|
| `docker-compose.yml` | Every service, pinned to this template's release. Ports stay on loopback except WebRTC's UDP. |
| `data/agents.json` | Your agents; AirLink also keeps its settings, memory and signing secret in `data/`. Edit them in Settings, or here while it is stopped. |
| `.env` | Your LLM keys, and the passwords AirLink and its sidecars share. |

The browser and desktop images are built on neko's; where one has no `linux/arm64` build, Docker
Desktop runs the `amd64` image under emulation, more slowly.

## Next

- [Getting started](https://memoair-labs.github.io/Airlink/docs/getting-started/) and [Self-hosting](https://memoair-labs.github.io/Airlink/docs/self-hosting/).
- [Agents](https://memoair-labs.github.io/Airlink/docs/agents/): every field in `agents.json`.
