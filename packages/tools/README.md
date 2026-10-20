# @memo-air/tools

The room's tool definitions and their thin runners, shared by every harness.

## Main exports

- `.` — `roomTools` (`create_live_doc`, `edit_live_sheet`, `act_live_browser`,
  `act_live_desktop`, `speak_in_live_room` and the rest, each with a zod schema), `runRoomTool`,
  `parseRoomToolCall`, `roomToolAccess`, `parseCreateToolCall`, and formatters for what agents
  read (`formatOutline`, `formatSheet`, `formatTranscript`, …).
- `./mcp` — `serveToolsMcp`, a loopback MCP server for any set of tools; `jsonParameters`.

## Used by

`@memo-air/bridge` offers the tools to every agent and serves them over MCP to ACP harnesses.

> [!NOTE]
> Not yet published to npm. It installs from this repository's workspaces; publishing is coming.
