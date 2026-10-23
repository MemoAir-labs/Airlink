# Agents

Agents in AirLink are flat: you say who each one is (a name, a role, instructions, tags), and the
room routes work to them. There is no orchestrator agent.

## Adding an agent

Settings → Agents adds, edits and removes agents; each agent has its own page. They are saved to
`.airlink/agents.json`. A fresh install has one, **Assistant**.

Each entry has this shape (`agentConfigSchema` in `packages/agents/src/index.ts`):

| Field | Default | Meaning |
|---|---|---|
| `id` | required | Stable id. Also the memory folder name. |
| `name` | required | Shown in chat; said aloud to address it in a huddle. |
| `role` | `""` | One line. Routing reads it. |
| `instructions` | `""` | The agent's own system prompt: what it is for, how it works, its tone. |
| `tags` | `[]` | Labels routing can match on (see the note under Routing). |
| `access` | `"write"` | `"suggest"` makes every change a suggestion a person accepts. |
| `harness` | `"pi"` | `"pi"`, or the id of an ACP harness turned on in Settings. |
| `model` | the default | `"<provider>/<model id>"` Pi answers on, e.g. `anthropic/claude-haiku-5-5`. |
| `memoryDir` | `<memory root>/<id>` | An OKF folder. Two agents given one folder share memory. |
| `voice` | `{ speed: 1 }` | A provider voice `id` (empty picks a distinct one) and a `speed` from 0.8 to 1.2. |

```json
[
  {
    "id": "analyst",
    "name": "Ada",
    "role": "Builds and checks spreadsheets and numbers.",
    "instructions": "Show your working in the sheet. Never invent figures.",
    "tags": ["numbers"],
    "access": "suggest",
    "harness": "pi",
    "model": "anthropic/claude-haiku-5-5"
  }
]
```

## Harnesses

AirLink runs no agent loop of its own. A harness runs the agent.

- **Pi** (`@earendil-works/pi-agent-core`, MIT) runs in process on your LLM key (`piHarness`).
  This is the default and needs nothing else.
- **ACP harnesses** run as child processes over the Agent Client Protocol (`acpHarness`).
  `detectHarnesses` looks for these on your `PATH` and Settings offers the ones it finds:

  | Harness | Found by | Started as |
  |---|---|---|
  | Claude Code | `claude` | `npx -y @agentclientprotocol/claude-agent-acp@0.93.0` |
  | Codex | `codex` | `npx -y @agentclientprotocol/codex-acp@2.2.2` |
  | Gemini CLI | `gemini` | `gemini --acp` |
  | opencode | `opencode` | `opencode acp` |

  An ACP harness gets the room's tools from a loopback MCP server the bridge serves
  (`serveRoomMcp`). Its own tools (shell, file writes on your machine) are refused. One that exits
  mid-turn is reported in the channel and restarted on the next message. The first start of a
  Claude Code or Codex agent waits while `npx` fetches the adapter.

Turn a harness on in Settings, then set an agent's `harness` to its id (`claude`, `codex`,
`gemini`, `opencode`).

`node packages/bridge/scripts/smoke.ts` drives Pi and an ACP harness against a running live-server
(`LIVE_URL`, `LIVE_JWT_SECRET`, `ANTHROPIC_API_KEY`).

## Routing

Each channel has a reply mode in its header. **Auto** follows the steps below. **On mention**
skips steps 2–4: an agent answers only when `@`-mentioned, and in a huddle only when named.

Who answers a chat message:

1. **Mentions.** Every agent `@`-mentioned answers. A message that mentions only people is left to
   them.
2. **Tags.** If exactly one agent carries one of the message's tags, it answers. AirLink's chat
   does not tag messages yet, so today this step is skipped; `routeMessage` supports it for hosts
   that do.
3. **The decision node.** Otherwise, with two or more candidates, the decision node picks by role.
   A confident pick (≥ 0.6) answers. A confident "none" means nobody answers, which in chat is
   only a message plainly addressed to another person; small talk or a question no role covers
   goes to the closest agent. An unsure pick still answers and is told it was unsure.
4. **Fallback.** With no pick, the first agent in the channel answers.

Who answers a line said in a huddle: the agents it names, else the one the decision node is sure
of by role. There is no fallback, since most of a call is people talking to each other.

A room event that is not a message (an edit once the person stops, a comment) reaches agents only
when the decision node judges it deserves a turn (≥ 0.5).

The routing code is `routeMessage`, `routeSpoken` and `deservesTurn` in `@memo-air/agents`.

## Tools

Each turn an agent gets:

- **The room's tools** (`roomTools` in `@memo-air/tools`): create, read and edit docs, sheets,
  canvases and slides (`create_live_doc`, `edit_live_sheet`, `read_live_canvas`, …), comment on
  docs, open and drive the shared browser and desktop (`open_live_browser`, `act_live_browser`,
  `open_live_desktop`, `act_live_desktop`, …), and read or speak in a huddle (`read_live_room`,
  `speak_in_live_room`).
- **`arrange_windows`**: list the channel's windows and open, close, minimize, maximize, restore or
  bring them to front. Deleting is not offered; that stays with people.
- **`read_live_file`**: read a file someone uploaded to the channel. Text and code as they are, a
  PDF's text page by page, an `.xlsx` as CSV per sheet.
- **`search_room`**: keyword search over the channel's whole message history and the text of its
  docs, sheets, slides, canvases and uploaded PDF, `.xlsx` and text files. It returns the best
  passages with where they are; any word may match and passages matching more rank first.
- **`read_chat`**: the channel's messages in order, around a message id or just before one.
- **`run_code` and `schedule_runner`**: run a Python or Node script in a sandboxed runner window
  everyone sees, with the channel's files read-only in `/files`; an `index.html` written to
  `/out` becomes a live dashboard, and a schedule re-runs it. The script can call the agent's own
  room tools: `from room import room` in Python or `import { room } from "./room.mjs"` in Node,
  then `room.search_room(query="…")` and so on, each returning the tool's text. Calls go over a
  socket to the runner's control server and back to AirLink, which runs them as the agent that
  wrote the code; the jail's network fence is unchanged. At most 50 calls a run, and never
  `run_code` or `schedule_runner`. A scheduled re-run calls them again, so a dashboard pulls live
  room data.
- **`recall_memory` and `remember`**, below.

## Context

An agent's prompt is rebuilt every turn from what is stored, so nothing is lost when AirLink
restarts and every agent sees the same channel:

- the channel's running summary, rewritten by the router's small model in the background once
  about 6,000 characters of chat pile up past it, citing message ids;
- up to three of the agent's own memories that share words with the message;
- the channel's five latest messages, from every person and agent;
- the message or event it is answering;
- every live object in the room, so the agent knows what ids to use.

Everything older is reached on demand with `search_room` and `read_chat`. The search index
(`airlink_search_chunks`) is derived: rebuilt from the docs after each save and at start, and
emptied with the channel or object it came from.

## Memory

Each agent remembers in a folder of OKF documents: Markdown with YAML frontmatter where `type` is
the one required field (`title`, `description`, `resource`, `tags` and `timestamp` when the agent
wrote it). `index.md` lists every entry in one line; `log.md` records every write.

- The folder is `<memory root>/<agent id>` unless the agent sets `memoryDir`. The memory root
  defaults to `.airlink/memory`; Settings can point it at an Obsidian vault.
- `recall_memory` searches by words over title, description, tags and body. `remember` writes a
  new note and never overwrites one (a second note with the same title gets `-2`).
- Before a write, the bridge asks the decision node whether the note will matter in a later
  conversation and declines it if not. A decision that fails saves.
- Hand-written notes are read too: nested folders, other types, no frontmatter at all.

Memory belongs to the agent across channels. Edit, delete or version the folder as you like.

## Channels and membership

- `#general` is open: every person and every agent is in it.
- Every other channel is invite-only. Its creator is in it and adds people and agents from the
  members dialog. Others can ask to join.
- An agent that is not a member of a channel does not answer there and does not join its
  huddle.

## Access

An agent's token is signed per object and capped at its `access`. With `suggest`, every change it
makes is a suggestion. With `write`, an edit to a sheet cell, canvas shape or slide element a person
wrote still lands as a suggestion. Prices, dates and commitments a person must own belong in suggestions.
