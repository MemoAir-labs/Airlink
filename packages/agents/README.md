# @memo-air/agents

The agent registry and routing. Agents are flat: the host says who they are (a name, a role,
instructions, tags) and this package decides who answers.

## Main exports

- `agentConfigSchema`, `AgentConfig`, `parseAgentRegistry` — the agent shape and its parser.
- `agentIdentity(agent)` — the identity prompt, the same for every harness.
- `routeMessage` — mention, then tag, then the decision node, then the host's fallback.
- `routeSpoken`, `agentsNamedIn` — who a line said in a huddle is for.
- `deservesTurn`, `turnQuestion`, `turnPrompt` — whether a room event earns an agent a turn,
  and the prompt for it.
- `rememberQuestion` and the thresholds `routeThreshold`, `turnThreshold`,
  `rememberThreshold`.

## Used by

`@memo-air/bridge` routes every turn with it, `@memo-air/server` asks `deservesTurn`,
and `apps/airlink` reads `agents.json` through `parseAgentRegistry`. See
[docs/agents.md](../../docs/agents.md).

> [!NOTE]
> Not yet published to npm. It installs from this repository's workspaces; publishing is coming.
