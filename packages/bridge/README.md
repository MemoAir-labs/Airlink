# @memo-air/bridge

The agent runtime. It takes live-server's turns, routes each one, runs the chosen agent on its
harness with the room's tools and its memory, and posts the reply in the channel. Every tool call
goes to live-server under a token signed for that agent and that object, capped at its access.

## Main exports

- `createBridge({ liveUrl, jwtSecret, agents, decide, harnesses, room, memoryRoot, logger })` —
  returns `onTurn`, `work` (a huddle's task on the agent's harness) and `post`.
- `piHarness`, `piDecide` — Pi in process, and a chat model as a decision node.
- `acpHarness`, `detectHarnesses` — Claude Code, Codex, Gemini CLI and opencode over ACP.
- `serveRoomMcp` — the loopback MCP server that gives ACP harnesses the room's tools.
- `agentMemory(memoryRoot, agent)` — an agent's OKF folder and store.
- Types: `Harness`, `BridgeRoom`, `BridgeTurn`, `Bridge`.

## Used by

`apps/airlink/server/main.ts` builds the bridge and rebuilds it when Settings change.
`node scripts/smoke.ts` drives Pi and an ACP harness against a running live-server. See
[docs/agents.md](../../docs/agents.md).

> [!NOTE]
> Not yet published to npm. It installs from this repository's workspaces; publishing is coming.
