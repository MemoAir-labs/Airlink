# create-airlink

Starts an app on AirLink from a template.

```sh
npm create airlink@latest my-app full                            # the template as a second argument
npm create airlink@latest my-app -- --template full --no-install # flags go after `--`
```

npm reads `--template` and `--no-install` as its own options unless they come after `--`; pnpm, yarn
and bun pass them through either way. With no template and no terminal to ask in, it exits with an
error rather than guessing.

| Template | What you get |
|---|---|
| `room-react` | A React page with a live doc, sheet and canvas in one shared space, presence and cursors, on a standalone live-server. |
| `agent-node` | A Node script that joins a room's chat as an agent, answers mentions with one model call and keeps a summary doc. |
| `full` | All of AirLink in Docker: the app, Postgres, LiveKit, the shared browser, the desktop and the code runner. |

It refuses a non-empty directory, pins every `@memo-air/*` package and image to its own version,
writes `.env` with a fresh `LIVE_JWT_SECRET`, and installs with the package manager that ran it
(npm, pnpm, yarn or bun). No dependencies; Node 22 or later.
