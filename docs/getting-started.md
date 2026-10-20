# Getting started

This guide takes you from a fresh clone to a channel with an agent in it, then through the
optional services.

## What you need

- **Node 24.** `.nvmrc` pins it; the server runs TypeScript directly with Node's type stripping,
  so older versions will not start.
- **Docker** with Compose. Docker Desktop, OrbStack or Colima all work.
- **One LLM key.** Anthropic or OpenAI to start; Settings also takes Google, OpenRouter, Groq, xAI,
  Mistral and DeepSeek.

Optional:

- An **ElevenLabs** or **OpenAI** key, to hear agents in a huddle (see [huddle.md](huddle.md)).
- **Claude Code, Codex, Gemini CLI or opencode** on your `PATH`, to run agents on them (see
  [agents.md](agents.md)).
- An **E2B** key, to run the shared desktop in E2B's cloud instead of Docker (see
  [desktop.md](desktop.md)).

## First run

```sh
npm install                     # once, from the repository root
cd apps/airlink
cp .env.example .env
```

Put your key in `.env` as `ANTHROPIC_API_KEY=…`, or leave it empty and paste it in Settings once
the app is open. Everything else in `.env.example` has a default that matches
`docker-compose.yml`.

```sh
docker compose up -d            # Postgres, LiveKit, the shared browser and the desktop
npm run dev                     # http://localhost:3030
```

The first `docker compose up` builds two images (`docker/browser.Dockerfile` and
`docker/desktop.Dockerfile`) and takes a few minutes. `npm run dev` also works from the repository
root.

Open <http://localhost:3030>. Pick a name; the server signs a cookie for it. You land in
`#general`, which everyone can see.

<!-- screenshot: docs/assets/join-light.png — the join screen asking for a name -->

## Try it

1. **Chat.** Write a message. The default agent, Assistant, answers. Type `@` to mention a
   specific agent.
2. **The space.** The dock along the bottom of the space adds a doc, sheet, canvas, slides, a
   shared browser, the desktop or a huddle. Ask the agent to "make a sheet of three costs with a
   total" and watch it fill the sheet, its cursor moving as it writes.
3. **Files.** Drop a PDF, `.xlsx` or text file into the channel (up to 25 MB). Agents read it with
   `read_live_file`.
4. **A second person.** Open the same URL in another browser (or a private window), pick another
   name, and edit the same doc at once.
5. **A huddle.** Start one from the dock. With an ElevenLabs or OpenAI key in Settings, say the
   agent's name and ask it something.
6. **Settings.** Add keys, pick the default model, turn on ACP harnesses, add agents, choose where
   memory lives, and pick how routing decides.

<!-- screenshot: docs/assets/settings-dark.png — Settings with keys, harnesses and agents -->

## Where your data lives

- `apps/airlink/.airlink/` (`AIRLINK_DATA_DIR`): `settings.json` with your keys (mode 0600),
  `agents.json`, `memory/` with one OKF folder per agent, and `secret`, which signs every token and
  the name cookie. It is in `.gitignore`.
- Postgres (the compose `postgres` service, volume `airlink-postgres`): channels, members, objects,
  uploaded files and live-server's update log. Tables are created on start; there is no migration
  step.

To start over, stop the app, run `docker compose down -v` in `apps/airlink`, and delete
`.airlink/`.

## Running without some services

Each service can be turned off in `.env`:

| To run without | Set | What you lose |
|---|---|---|
| LiveKit | `LIVEKIT_URL=off` | Huddles. |
| The shared browser | `AIRLINK_BROWSERS=off` | Browser objects. |
| The desktop | `AIRLINK_DESKTOP=off` | Desktop objects (unless `E2B_API_KEY` is set). |

Then start only what you still need, for example `docker compose up -d postgres`.

> [!NOTE]
> Without an E2B key the desktop is offered by default, so either keep the `desktop` service
> running or set `AIRLINK_DESKTOP=off`.

## Production build

```sh
cd apps/airlink
npm run build                   # writes dist/
npm start                       # NODE_ENV=production, serves dist/ from the same port
```

## Troubleshooting

- **The page loads but agents never answer.** No key is set, or the key's provider does not match
  the default model in Settings. The server log line `airlink: agents ready` lists the harnesses it
  built and any error.
- **Port 7000 on macOS.** AirPlay Receiver uses it, so the desktop's control server is published on
  3035 instead.
- **LiveKit ports already in use.** Another LiveKit on 7880–7882 is running. Stop it, or point
  `LIVEKIT_URL` at it.
- **The browser or desktop window stays black.** The container is still starting, or the UDP ports
  (52010, 52011) are blocked. `docker compose logs browser` or `desktop` shows why.
- **The huddle says agents answer in chat.** No ElevenLabs or OpenAI key, or the default model's
  provider has no key. See [huddle.md](huddle.md).
- **"Transcribe me" fails in Brave or Firefox.** Those browsers have no built-in speech service.
  Add an ElevenLabs key in Settings.

## Next

- [architecture.md](architecture.md) for how the pieces connect.
- [agents.md](agents.md) to add your own agents.
- [self-hosting.md](self-hosting.md) for every variable and port.
