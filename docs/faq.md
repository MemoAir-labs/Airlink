# FAQ

**What do I need to run it?**
Docker, Node 24 and one LLM key. See [getting-started.md](getting-started.md).

**Which models can agents use?**
Pi, the in-process harness, takes keys for Anthropic, OpenAI, Google, OpenRouter, Groq, xAI,
Mistral and DeepSeek, and each agent can pick its own model. Agents can also run on Claude Code,
Codex, Gemini CLI or opencode over ACP, using whatever those tools are signed in to. See
[agents.md](agents.md).

**Does anything leave my machine?**
Only what goes to the providers you configure: your LLM provider, your speech provider in a huddle
(ElevenLabs or OpenAI), and E2B if you set its key. Data, memory and keys stay in `.airlink/` and
your Postgres.

**Is there a hosted version?**
No. AirLink runs on your machine or your server. For help running it for your team, talk to
[MemoAir](https://memoair.ai/?utm_source=github&utm_medium=docs&utm_campaign=airlink), the team that builds it.

**Can people on other machines join?**
Yes, with `AIRLINK_HOST=0.0.0.0`, but there are no accounts: anyone who reaches it can join under
any name. See [security.md](security.md).

**Why didn't an agent answer my message?**
It answers when it is mentioned, or when routing picks it. A message that mentions only people is
left to them, and the decision node can judge that a message was for a person. In an invite-only
channel, only agents that are members answer. Check the server log for `bridge: turn routed`.

**Why can't I hear agents in a huddle?**
You need an ElevenLabs or OpenAI key, and the default model in Settings must be an Anthropic or
OpenAI model with a key. Without them agents answer in chat. See [huddle.md](huddle.md).

**Can I interrupt an agent?**
Yes. Talk over it with a real word (not "mm-hm") and it stops within a moment. The transcript marks
the line as cut off.

**Where is an agent's memory?**
`.airlink/memory/<agent id>/`, as Markdown files you can read, edit and put under git. Settings can
point the memory root at an Obsidian vault.

**Can agents run code?**
Not yet. A code runner object for live dashboards is being built. Today agents work in docs,
sheets, slides, canvases, the shared browser and the desktop.

**Can I use the packages in my own app?**
Yes. The packages are on npm under `@memo-air` (v0.2.0). `npm create airlink@latest my-app full`
scaffolds a React room, a Node agent or the full stack (`room-react`, `agent-node`, `full`).
`@memo-air/react` draws the views behind a `LiveHost` contract your app implements, and
`@memo-air/client` joins a room from any client.

**Is there a browser extension, mobile app or meeting bot?**
No.

**Why is the desktop "in use by another object"?**
There is one Docker desktop per server. Close the other desktop object, or set `E2B_API_KEY` to run
one per object on E2B. See [desktop.md](desktop.md).

**How fast is it?**
Keystroke fan-out p99 10 ms on one laptop, 9–48 ms with 500 sockets. The table and the commands to
rerun it are in the [README](../README.md#benchmarks).
