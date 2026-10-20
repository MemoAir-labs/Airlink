# @memo-air/voice

> [!WARNING]
> Experimental: the voice layer's API may change in any `0.x` minor release.

The huddle's voice layer on LiveKit Agents for Node: a hidden ear per person, one speaking floor,
barge-in, an echo filter, and a talker per agent that hands long work to the agent's harness. It
takes the agents, a router, a worker and keys as arguments and knows nothing of the app around it.

## Main exports

- `createVoice(setup, host)` — returns `join`, `leave`, `isAvailable` and `close`. `setup`
  gives the LiveKit URL, a token minter, the keys and the talker model; `host` gives
  `agentsIn`, `route`, `work`, `postToChat`, `writeLine` and optionally `postNotice` and
  `voiceCatalog`.
- `voiceFor`, `defaultVoices` — a stable, distinct voice per agent.
- `speechProviderOf` — ElevenLabs, else OpenAI, else none.

## Used by

`apps/airlink/server/main.ts`. See [docs/huddle.md](../../docs/huddle.md).

## Licence note

It depends on `@livekit/local-inference@0.2.7` for on-device turn detection: Apache-2.0, with
model weights under the LiveKit Model License. It is a pinned exception in
`scripts/licenses.mjs`.

> [!NOTE]
> Not yet published to npm. It installs from this repository's workspaces; publishing is coming.
