# Self-hosting

AirLink is one Node process (`apps/airlink`) plus the services in
`apps/airlink/docker-compose.yml`. This page lists every setting, port and service. Values come from
`apps/airlink/server/config.ts`, `apps/airlink/.env.example` and `apps/live-server/src/main.ts`.

> [!WARNING]
> AirLink has no accounts. Anyone who can reach it can join under any name. Keep it on loopback, or
> on a network where you trust everyone. See [security.md](security.md).

## Docker services

| Service | Image | What it is | Needed for |
|---|---|---|---|
| `postgres` | `postgres:16-alpine` | Channels, members, objects, files, the update and event logs. Volume `airlink-postgres`. | Always. |
| `livekit` | `livekit/livekit-server:v1.9` | Voice and video, in `--dev` mode with LiveKit's published dev keys (`devkey` / `secret`). | Huddles. |
| `browser` | built from `docker/browser.Dockerfile` | neko's Chromium; page traffic goes through AirLink's pinning proxy. | Browser objects. |
| `desktop` | built from `docker/desktop.Dockerfile` | neko's XFCE desktop with a control server. | Desktop objects without E2B. |
| `decide` | built from `docker/decide.Dockerfile` | Laya, an open decision model. Profile `decide`, off by default. | Optional routing provider. |

```sh
cd apps/airlink
docker compose up -d                          # postgres, livekit, browser, desktop
docker compose --profile decide up -d decide  # Laya, then set its URL in Settings
```

## Ports

| Port | Bound to | What |
|---|---|---|
| 3030 | `AIRLINK_HOST` | The app: API and web app. |
| 3031 | `AIRLINK_HOST` | live-server's WebSocket and HTTP routes. |
| 3033 | all interfaces | The shared browser's pinning proxy. The browser container reaches it through the Docker host gateway; it only dials public addresses. |
| 5434 | 127.0.0.1 | Postgres. |
| 7880, 7881 | 127.0.0.1 | LiveKit signalling and TCP media. |
| 7882/udp | all interfaces | LiveKit UDP media. |
| 3032 | 127.0.0.1 | The shared browser's viewer (neko). |
| 9232 | 127.0.0.1 | The shared browser's CDP endpoint. |
| 52010/udp | all interfaces | The shared browser's WebRTC media. |
| 3034 | 127.0.0.1 | The desktop's viewer (neko). |
| 3035 | 127.0.0.1 | The desktop's control server (token-gated; it runs input). |
| 52011/udp | all interfaces | The desktop's WebRTC media. |
| 8000 | 127.0.0.1 | Laya, when the `decide` profile is on. |

## Environment: the AirLink app

Set these in `apps/airlink/.env`. Every one has a default that matches `docker-compose.yml`.

**Keys.** Keys can also be pasted in Settings, which take precedence and are stored in
`.airlink/settings.json`.

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | LLM key for Pi, the router and the talker. |
| `OPENAI_API_KEY` | — | LLM key (with an OpenAI model in Settings); also a speech provider for huddles. |
| `ELEVENLABS_API_KEY` | — | Speech for huddles and "Transcribe me" in every browser. |
| `CARTESIA_API_KEY` | — | Speech for huddles. |
| `DEEPGRAM_API_KEY` | — | Speech for huddles. |
| `E2B_API_KEY` | — | Run desktops on E2B instead of Docker. |

**Server.**

| Variable | Default | Meaning |
|---|---|---|
| `AIRLINK_PORT` | `3030` | The app. |
| `AIRLINK_LIVE_PORT` | `3031` | The live socket. |
| `AIRLINK_HOST` | `127.0.0.1` | `0.0.0.0` lets others on your network join (anyone who reaches it, under any name). |
| `AIRLINK_DATA_DIR` | `.airlink` | Settings, agents, memory and the signing secret. |
| `AIRLINK_DATABASE_URL` | `postgres://airlink:airlink@localhost:5434/airlink` | Postgres. |
| `NODE_ENV` | — | `production` serves the built `dist/` instead of Vite (`npm start` sets it). |

**Huddles.**

| Variable | Default | Meaning |
|---|---|---|
| `LIVEKIT_URL` | `ws://localhost:7880` | `off` runs without huddles. |
| `LIVEKIT_API_KEY` | `devkey` | LiveKit API key. |
| `LIVEKIT_API_SECRET` | `secret` | LiveKit API secret. |

**Shared browser.**

| Variable | Default | Meaning |
|---|---|---|
| `AIRLINK_BROWSERS` | one neko at `localhost:9232` / `localhost:3032` | A JSON array of `{ "cdp", "neko", "publicUrl" }`, one per browser container; `off` runs without the shared browser. |
| `AIRLINK_NEKO_PASSWORD` | `airlink` | neko's viewer password; must match compose. |
| `AIRLINK_NEKO_API_TOKEN` | `airlink-neko` | neko's session API token; must match compose. |
| `AIRLINK_BROWSER_CDP_URL` | — | Use one Chromium over CDP instead of neko. |
| `AIRLINK_BROWSER_PROXY_PORT` | `3033` | The pinning proxy's port; compose's `LIVE_BROWSER_PROXY` points at it. |

**Desktop.**

| Variable | Default | Meaning |
|---|---|---|
| `AIRLINK_DESKTOP` | on | `off` runs without the Docker desktop. |
| `AIRLINK_DESKTOP_CONTROL_URL` | `http://localhost:3035` | The control server. |
| `AIRLINK_DESKTOP_VIEWER_URL` | `http://localhost:3034` | The neko viewer. |
| `AIRLINK_DESKTOP_PASSWORD` | `airlink` | Viewer password; must match compose. |
| `AIRLINK_DESKTOP_TOKEN` | `airlink-desktop` | Control token; must match compose. Change it if port 3035 is ever exposed beyond loopback. |

The decision node, the default model, the memory folder and ACP harnesses are set in Settings, not
in the environment.

## Files AirLink keeps

| Path | What |
|---|---|
| `.airlink/settings.json` | Keys (mode 0600), default model, harnesses, memory root, speech, decision provider. |
| `.airlink/agents.json` | The agents. |
| `.airlink/memory/` | One OKF folder per agent, unless Settings points elsewhere. |
| `.airlink/secret` | Signs every live token and the name cookie. Made on first run (mode 0600). |

Back up `.airlink/` and the Postgres volume together.

## Running it beyond your laptop

- Set `AIRLINK_HOST=0.0.0.0` and put it behind a reverse proxy with TLS. Browsers require a secure
  origin for microphones and cameras except on `localhost`.
- The app answers only its own host names: `localhost`, `127.0.0.1`, `[::1]` and `AIRLINK_HOST`.
- neko and LiveKit advertise `127.0.0.1` for WebRTC in the compose file (`NEKO_WEBRTC_NAT1TO1`,
  LiveKit `--dev`). For other machines, set those to an address they can reach and open the UDP
  ports.
- Change every default password and token (`AIRLINK_NEKO_PASSWORD`, `AIRLINK_NEKO_API_TOKEN`,
  `AIRLINK_DESKTOP_PASSWORD`, `AIRLINK_DESKTOP_TOKEN`, the LiveKit keys) in both `.env` and compose.
- The code runner's bubblewrap jails need unprivileged user namespaces (Ubuntu 24.04:
  `kernel.apparmor_restrict_unprivileged_userns=0`, or an AppArmor profile), and they can reach
  host listeners bound to `0.0.0.0`, so a public-IP host needs a firewall in front.

> [!NOTE]
> A multi-user, internet-facing deployment is not what AirLink is built for today: there are no
> accounts, and one desktop is shared by the server. Redis for multiple nodes is wired in
> live-server but off.

## live-server on its own

`apps/live-server` runs live-server alone, for a host that runs agents and the app elsewhere.

```sh
LIVE_DATABASE_URL=postgres://… LIVE_JWT_SECRET=… npm -w @memo-air/live-server run start
```

<details>
<summary>live-server's environment</summary>

| Variable | Default | Meaning |
|---|---|---|
| `LIVE_DATABASE_URL` | required | Postgres. |
| `LIVE_JWT_SECRET` | required | The secret tokens are signed with; the host signs with the same. |
| `PORT` | `3020` | HTTP and WebSocket. |
| `REDIS_URL` | — | Turns on the Redis extension for multiple nodes. |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | — | Huddles, when all three are set. |
| `OPENAI_API_KEY` | — | Server-side agent speech through `speak` (OpenAI TTS). |
| `LIVE_BROWSERS` | — | A JSON array of neko browsers; needs `LIVE_NEKO_PASSWORD` and `LIVE_NEKO_API_TOKEN`. |
| `LIVE_BROWSER_CDP_URL` | — | One Chromium over CDP instead. |
| `LIVE_BROWSER_PROXY_PORT` | `3021` | The pinning proxy. |
| `LIVE_BROWSER_PROXY_HOST` | `0.0.0.0` | Its bind address. |
| `E2B_API_KEY` | — | Desktops on E2B. |
| `LIVE_DESKTOP_TEMPLATE` | — | A custom E2B template. |
| `LIVE_DECIDE_URL` | — | A System One decision provider (Laya at `http://localhost:8000/v1/systemone`, or Jev at `https://api.typesafe.ai/v1/systemone`). |
| `LIVE_DECIDE_API_KEY`, `LIVE_DECIDE_MODEL`, `LIVE_DECIDE_NAME` | — | Its key (Jev), model (`jev-latest`) and a name for logs. |
| `LIVE_TURN_HOOK_URL` | — | Where deserved turns are POSTed, signed with `LIVE_JWT_SECRET`. |

</details>

It serves `/healthz` and `/metrics`. CI starts it this way for the bench smoke
(`.github/workflows/ci.yml`).

## Tests and benchmarks against your install

```sh
docker compose -f apps/airlink/docker-compose.yml exec postgres createdb -U airlink airlink_test
TEST_LIVE_DATABASE_URI=postgres://airlink:airlink@127.0.0.1:5434/airlink_test npm test
```

The benchmark commands are in the README's [Measured latency](../README.md#measured-not-claimed)
section.
