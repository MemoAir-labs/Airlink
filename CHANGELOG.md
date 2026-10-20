# Changelog

All notable changes to AirLink are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-20

### Added

- **Channels.** `#general` open to everyone; every other channel invite-only, with members (people
  and agents), join requests and a members dialog. Names are the identity: no accounts, a signed
  name cookie.
- **Chat.** Messages with mentions, attachments, reactions and Markdown; agents stream their
  replies; a typing line.
- **The space.** Each channel's objects as windows on a shared desktop, with a dock; open, close to
  an icon, minimize, maximize, for everyone; a bin for removed objects.
- **Live objects.** Rich-text docs with comments, suggestions, history and Markdown export; sheets
  with formulas and `.xlsx` export; slides with themes and `.pptx` export; an Excalidraw canvas;
  uploaded files up to 25 MB (PDF, `.xlsx` and text readable by agents).
- **Shared browser.** neko's Chromium over WebRTC, driven by people and agents, read by agents as
  an accessibility outline, with every page connection through a pinning proxy that refuses
  private addresses.
- **Desktop.** A Linux desktop in Docker (XFCE, terminal, editor, files; LibreOffice and Firefox
  with `DESKTOP_EXTRAS=1`) behind a token-gated control server; E2B as an optional provider.
- **Huddle.** Voice and video over LiveKit. Full-duplex agent voice: server-side transcription per
  person, on-device turn-end detection, one speaking floor, barge-in with cut marks, an echo filter,
  a distinct voice and speed per agent, and a talker that hands long work to the agent's harness.
  Without a speech key, per-person transcription in the browser and agents answering in chat.
  "Share signals" sends present/away and gestures computed in the browser.
- **Agents.** Flat agents with a role, instructions, tags, access, harness, model, memory folder
  and voice; agent pages in Settings. Pi in process on keys for Anthropic, OpenAI, Google,
  OpenRouter, Groq, xAI, Mistral or DeepSeek; Claude Code, Codex, Gemini CLI and opencode over ACP
  with the room's tools served as loopback MCP and their own tools refused. Agent cursors.
- **Routing and the decision node.** Mention, then tag, then the decision node by role, then a
  fallback; room events judged for an unprompted turn; every decision logged with its odds. A small
  model on your key by default; any System One provider (Laya in a compose profile, or Jev) in
  Settings.
- **Memory.** One OKF folder of Markdown per agent, with `recall_memory` and `remember`, gated by
  the decision node; point it at an Obsidian vault.
- **live-server.** Yjs over Hocuspocus with an append-only Postgres update log, an event log, agent
  ops over HTTP under per-agent, per-doc tokens, presence, `/metrics` and `/healthz`; runnable on
  its own (`apps/live-server`).
- **Benchmarks.** `apps/bench`: keystroke, awareness, agent-op, cold-start, concurrency and
  shared-browser latency, with the measured table in the README.
- **Project.** MIT licence in every package, a dependency licence check, CI (type-check, Biome,
  tests, licences, bench smoke, image build), contributing guide, security policy, documentation
  under `docs/`.

### Coming

- A code runner object: agents run Python and Node in a sandbox and show output and live
  dashboards in the space.
- Published npm packages, `npm create airlink`, a docs site and an API reference.
- A measured voice latency row.
