# AirLink

One room for people and agents: channels with a chat, a space of live docs, sheets, canvases,
slides and a shared browser, and a call — all on one event log. Agents are yours: Pi runs in
process on your LLM key, and Claude Code, Codex, Gemini CLI or opencode join over ACP when they
are on your PATH. Each agent remembers in a folder of Markdown files.

## Run it

Needs Docker, Node 24 and one LLM key.

```sh
npm install                     # once, from the repository root
cd apps/airlink
cp .env.example .env            # put your ANTHROPIC_API_KEY in it, or paste it in Settings later
docker compose up -d            # Postgres, LiveKit, the shared browser, desktop and code runner
npm run dev                     # http://localhost:3030
```

Open it in two browsers, give each a name, and write in `#general`. The default agent answers;
`@` mentions a specific one, and the selector under the composer picks which harness answers.
The channel's space is a desktop: the dock along its bottom puts a doc, sheet, canvas, slides, a
browser or a call in it, and each window's traffic lights close it to a desktop icon, minimize it
to the dock or maximize it — for everyone in the channel, people and agents alike. "Transcribe me" uses ElevenLabs when a key is set in Settings, otherwise the browser's own
speech service (Chrome, Edge and Safari have one; Brave and Firefox do not).
The shared desktop runs in the compose `desktop` container with no key (build it with
`DESKTOP_EXTRAS=1` for LibreOffice and Firefox); set `E2B_API_KEY` to run desktops on E2B instead.
Without an E2B key the desktop is offered by default, so keep the `desktop` service running or set
`AIRLINK_DESKTOP=off`.
Agents run Python and Node in the compose `runner` container: each run in its own bubblewrap jail
with only its channel's uploads, the network on, and 60 s, 1 GB, 20 files and 50 MB of output. It
is offered by default, so keep the `runner` service running or set `AIRLINK_RUNNER=off`.
bubblewrap needs unprivileged user namespaces on the Docker host: on Ubuntu 24.04 set
`kernel.apparmor_restrict_unprivileged_userns=0` (or give it an AppArmor profile). Jails can reach
host listeners bound to `0.0.0.0`, so on a public-IP host put a firewall in front.

## Where things live

- `.airlink/` — your data: `settings.json` (the key, mode 0600), `agents.json` (who the agents
  are), `memory/` (one OKF folder per agent; point Settings at an Obsidian vault to share yours),
  and `secret`, which signs every token and the name cookie.
- Postgres — the channels, their objects, and live-server's update log.

The app and the live socket listen on `127.0.0.1` only, and the API answers only to `localhost`
and `127.0.0.1` with same-origin JSON, so a web page you visit cannot drive your agents. With
`AIRLINK_HOST=0.0.0.0` people on your network can join, and anyone who reaches it can join under
any name: there are no accounts. The shared browser's pinning proxy listens on all interfaces on
port 3033, because the browser container reaches it through the Docker host gateway; it only dials
public addresses.

## How it fits

`server/main.ts` is one process: live-server (Yjs over Hocuspocus, the Postgres log) on
`AIRLINK_LIVE_PORT`, the agent bridge as its turn hook, and the app's API with the web app on
`AIRLINK_PORT`. The views are `@memo-air/react`, the same ones Memoair draws.
